/**
 * Edit the model's own output in a Session, in place.
 *
 * The log is append-only, so an edit cannot rewrite anything. Each edit appends
 * one `plugin:msg-edit/revise` record carrying the decision, and a message
 * projection registered here turns that record into the model-visible history
 * the next request is built from. The durable assistant message keeps its
 * identity and its recorded text forever; what changes is the derived message
 * the loop sends.
 *
 * Why a projection rather than a surface replacement: `assistant/message`
 * embeds its provider stream and is forbidden from carrying `sourceEventSeqs`,
 * so it can never be the node that replaces a surface range. A
 * `system/message` or `developer/message` replacement *can* shadow an assistant
 * node — both were verified against the shipped validator — but it cannot
 * express "rewrite this text". A projection states the intent directly.
 *
 * Decisions are addressed by `messageId`, not by log position: the identity is
 * what the browser has (the assistant action row is handed exactly that), and it
 * survives a fork and a compaction, where a seq does not.
 *
 * @module dsh-msg-edit
 */

import { SessionSeq } from '@deepseek-ai/dsh-session/types';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';

/** Plugin name; the bundle patch row id and the row `name` must both equal the package name. */
export const name = 'msg-edit';

/** Host route the browser reads decisions from and posts edits to. */
export const MESSAGE_PATH = '/api/session.message';

/** Plugin record type owned by this plugin; the projection below interprets it. */
export const RECORD_TYPE = 'plugin:msg-edit/revise';

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 64 * 1024;

/** Largest replacement text accepted, in UTF-8 bytes. */
const MAX_TEXT_BYTES = 32 * 1024;

/** A request the caller must fix; maps to a 4xx response. */
class EditError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - human explanation for the response body.
   */
  constructor(code, message) {
    super(message);
    this.name = 'EditError';
    this.code = code;
  }
}

/** Status for each stable error code. */
const STATUS_BY_CODE = {
  'bad-request': 400,
  'too-large': 413,
  'not-found': 404,
  'not-editable': 409,
  'write-failed': 500,
  'unavailable': 503,
};

/**
 * Whether a value is a usable message identity.
 * @param {unknown} value - candidate.
 * @returns {boolean} true when the value names a message.
 */
function isMessageId(value) {
  return typeof value === 'string' && value !== '';
}

/**
 * Read and size-check the JSON request body.
 * @param {Request} request - the incoming Fetch request.
 * @returns {Promise<unknown>} the parsed body.
 * @throws {EditError} when the body is missing, oversized, or not JSON.
 */
async function readBody(request) {
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new EditError('too-large', 'the request body exceeds the edit limit');
  }
  if (text.trim() === '') throw new EditError('bad-request', 'the request body is empty');
  try {
    return JSON.parse(text);
  } catch {
    throw new EditError('bad-request', 'the request body is not JSON');
  }
}

/**
 * Derive the surface node seqs of a log.
 *
 * Both paths need this: a live Session exposes its folded surface, while a cold
 * log must be replayed. Replaying is the same fold the restore path performs, so
 * a decision validated here cannot be rejected on the next open.
 *
 * @param {ReadonlyArray<object>} events - the complete event log in seq order.
 * @returns {number[]} surface node seqs in model-visible order.
 */
function foldSurfaceSeqs(events) {
  const surface = [];
  for (const event of events) {
    if (typeof event?.seq !== 'number') continue;
    const op = event.surfaceOp;
    if (op === 'append') {
      surface.push(event.seq);
      continue;
    }
    if (op !== null && typeof op === 'object' && op.op === 'replace') {
      const start = surface.indexOf(op.startSeq);
      const end = surface.indexOf(op.endSeq);
      if (start === -1 || end === -1 || start > end) continue;
      surface.splice(start, end - start + 1, event.seq);
    }
  }
  return surface;
}

/**
 * Index the current surface's assistant messages by identity.
 * @param {ReadonlyArray<object>} events - the complete event log in seq order.
 * @param {ReadonlyArray<number>} surface - surface node seqs.
 * @returns {Map<string, object>} messageId to its `assistant/message` event.
 */
function assistantIndex(events, surface) {
  const index = new Map();
  for (const seq of surface) {
    const event = events[seq];
    if (event?.type !== 'assistant/message') continue;
    const id = event.data?.message?.id;
    if (isMessageId(id)) index.set(id, event);
  }
  return index;
}

/**
 * Resolve one message identity to the live assistant message it names.
 *
 * A message marked `interrupted` is a delivered prefix: the turn was stopped, or
 * the provider stream failed after it had already sent text (a content filter, a
 * dropped connection, a truncated response). The Harness settles that prefix as
 * a durable `assistant/message` with `interrupted: true`, and the Chat view
 * renders it with the same action row as any other reply — so it must be
 * addressable here too. Refusing it made the pencil appear and every save fail
 * with "this reply cannot be edited", which is exactly the reply a human most
 * wants to repair: the text that got cut off.
 *
 * Nothing about the durable record changes: the original prefix stays in the
 * log, and the edit is an appended decision like any other, so the honest
 * history remains recoverable by disabling the plugin.
 *
 * @param {Map<string, object>} index - identity to event.
 * @param {string} messageId - the requested identity.
 * @returns {object} the target event.
 * @throws {EditError} when the identity is not a live assistant message.
 */
function resolveTarget(index, messageId) {
  const event = index.get(messageId);
  if (event === undefined) {
    throw new EditError('not-found', `no model message "${messageId}" is on the surface`);
  }
  return event;
}

/**
 * Build the replacement content for an edited message.
 *
 * Only `text` blocks are replaced; every other block keeps its position.
 * Dropping a `tool-call` block would orphan its result and the provider would
 * reject the next request, so an edit is scoped to the prose a human can see.
 * A message with no text block is therefore not editable: there is nothing to
 * rewrite, and silently changing its tool calls would break the transcript.
 *
 * @param {ReadonlyArray<object>} content - the durable message content.
 * @param {string} text - the replacement prose.
 * @returns {object[]} content blocks with the text block first.
 * @throws {EditError} when the message carries no text block.
 */
function replacementContent(content, text) {
  const others = content.filter((block) => block?.type !== 'text');
  if (others.length === content.length) {
    throw new EditError('not-editable', 'this message has no text to edit');
  }
  return text === '' ? others : [{ type: 'text', text }, ...others];
}

/**
 * Validate one request and resolve the record it should append.
 *
 * Both the live and cold paths must reach the same decision, so the resolution
 * lives here rather than in either path.
 *
 * @param {ReadonlyArray<object>} events - the complete event log in seq order.
 * @param {ReadonlyArray<number>} surface - surface node seqs.
 * @param {{messageId: string, text: string}} request - the edit.
 * @returns {{op: 'edit', messageIds: string[], text: string}} the record payload.
 * @throws {EditError} when the target is not editable.
 */
function resolveRecord(events, surface, request) {
  const target = resolveTarget(assistantIndex(events, surface), request.messageId);
  replacementContent(target.data.message.content, request.text);
  return { op: 'edit', messageIds: [request.messageId], text: request.text };
}

/**
 * Fold every committed decision into the current state.
 *
 * Reading is a fold over the log rather than a stored table: the log is the only
 * authority, and a cached copy could disagree with it after an external write. A
 * later edit of the same message supersedes an earlier one.
 *
 * @param {ReadonlyArray<object>} events - the complete event log in seq order.
 * @returns {{revision: number, edited: Record<string, string>}} the current state.
 */
function foldDecisions(events) {
  const edited = new Map();
  let revision = 0;
  for (const event of events) {
    if (event?.type !== RECORD_TYPE) continue;
    const data = event.data ?? {};
    if (data.op !== 'edit' || typeof data.text !== 'string') continue;
    const ids = Array.isArray(data.messageIds) ? data.messageIds.filter(isMessageId) : [];
    if (ids.length === 0) continue;
    revision += 1;
    edited.set(ids[0], data.text);
  }
  return { revision, edited: Object.fromEntries(edited) };
}

/**
 * Record one edit on a Session.
 *
 * The live Session is preferred so the running agent's next request reflects the
 * change at once; a cold Session is reached through a persistence write handle
 * instead. Both paths flush, so a success means the decision is durable.
 *
 * @param {object} ctx - the composed host context.
 * @param {{sessionId: string, messageId: string, text: string}} request - the edit.
 * @returns {Promise<object>} the response value.
 * @throws {EditError} when the Session is missing or the write cannot be flushed.
 */
async function revise(ctx, request) {
  const sessions = ctx.get('sessions');
  if (sessions === undefined) throw new EditError('unavailable', 'the session store is not mounted in this profile');
  const live = sessions.get(request.sessionId);
  if (live !== undefined) {
    const record = resolveRecord(live.snapshotEvents(), [...live.surface.nodes], request);
    const recordSeq = appendPluginRecord(live, RECORD_TYPE, record);
    if (!await sessions.flush(live)) {
      throw new EditError('write-failed', 'the decision could not be flushed to storage');
    }
    return { sessionId: request.sessionId, recordSeq, op: record.op, messageIds: record.messageIds };
  }
  const persistence = ctx.get('sessionPersistence');
  if (persistence === undefined) throw new EditError('unavailable', 'session persistence is not configured');
  const handle = await persistence.open(request.sessionId, 'write');
  try {
    const { events } = await handle.read();
    const record = resolveRecord(events, foldSurfaceSeqs(events), request);
    const recordSeq = events.length;
    await handle.append([{
      type: RECORD_TYPE,
      seq: SessionSeq(recordSeq),
      time: Date.now(),
      data: record,
      ignorable: true,
    }]);
    await handle.flush();
    return { sessionId: request.sessionId, recordSeq, op: record.op, messageIds: record.messageIds };
  } finally {
    await handle.close();
  }
}

/**
 * Read the current decisions for one Session.
 * @param {object} ctx - the composed host context.
 * @param {URLSearchParams} query - the request query, carrying `sessionId`.
 * @returns {Promise<object>} the folded decisions.
 * @throws {EditError} when the Session id is missing.
 */
async function readDecisions(ctx, query) {
  const sessionId = query.get('sessionId');
  if (typeof sessionId !== 'string' || sessionId === '') throw new EditError('bad-request', 'sessionId is required');
  const sessions = ctx.get('sessions');
  const live = sessions?.get(sessionId);
  if (live !== undefined) return { sessionId, ...foldDecisions(live.snapshotEvents()) };
  const persistence = ctx.get('sessionPersistence');
  if (persistence === undefined) throw new EditError('unavailable', 'session persistence is not configured');
  const handle = await persistence.open(sessionId, 'read');
  try {
    const { events } = await handle.read();
    return { sessionId, ...foldDecisions(events) };
  } finally {
    await handle.close();
  }
}

/**
 * Answer one read or write request.
 * @param {object} ctx - the composed host context.
 * @param {Request} request - the incoming Fetch request.
 * @returns {Promise<Response>} the JSON response.
 */
async function messageResponse(ctx, request) {
  try {
    if (request.method === 'GET') {
      return Response.json(await readDecisions(ctx, new URL(request.url, 'http://localhost').searchParams));
    }
    const body = await readBody(request);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new EditError('bad-request', 'the request body must be a JSON object');
    }
    const { sessionId, messageId, text } = body;
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new EditError('bad-request', 'sessionId must be a non-empty string');
    }
    if (!isMessageId(messageId)) throw new EditError('bad-request', 'messageId must be a non-empty string');
    if (typeof text !== 'string') throw new EditError('bad-request', 'text must be a string');
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
      throw new EditError('too-large', 'the replacement text exceeds the edit limit');
    }
    return Response.json(await revise(ctx, { sessionId, messageId, text }));
  } catch (error) {
    if (error instanceof EditError) {
      return Response.json({ error: error.code, message: error.message }, { status: STATUS_BY_CODE[error.code] ?? 400 });
    }
    ctx.logger?.warn?.(`msg-edit: request failed: ${String(error)}`);
    return Response.json({ error: 'write-failed', message: 'the change could not be recorded' }, { status: 500 });
  }
}

/**
 * The message projection: turn each record into current model-visible history.
 *
 * `project` must be pure and must publish immutable copies.
 *
 * Reading the original content from `context.messages` first is what makes a
 * second edit replace the first instead of composing with it: the context
 * carries the messages current *before* this record, so the record always
 * describes a complete replacement. The event's own message is the fallback for
 * the first edit of a message, which has no projection in force yet.
 *
 * @param {object} event - the committed record.
 * @param {object} context - history preceding this decision.
 * @returns {Map<number, object>} changed messages keyed by target seq.
 * @throws {Error} when the record cannot be applied to this history.
 */
function project(event, context) {
  const { op, messageIds, text } = event.data ?? {};
  if (op !== 'edit') throw new Error(`msg-edit: unsupported operation "${String(op)}"`);
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    throw new Error('msg-edit: record carries no target');
  }
  if (typeof text !== 'string') throw new Error('msg-edit: record carries no replacement text');
  const wanted = new Set(messageIds);
  const updates = new Map();
  for (const seq of context.nodes) {
    const source = context.events[seq - context.baseSeq];
    if (source?.type !== 'assistant/message') continue;
    if (!wanted.has(source.data?.message?.id)) continue;
    const original = context.messages.get(seq) ?? source.data.message;
    if (original === null || original === undefined) throw new Error(`msg-edit: no message at seq ${seq} to edit`);
    const others = original.content.filter((block) => block?.type !== 'text');
    updates.set(seq, { ...original, content: text === '' ? others : [{ type: 'text', text }, ...others] });
  }
  // A target that is no longer on the surface (a later compaction shadowed it)
  // simply contributes nothing: the log is append-only, and a decision about
  // history the model no longer sees must never make the Session unreadable.
  return updates;
}

/**
 * Mount the projection and the read/write route.
 * @param {object} ctx - host context.
 */
export function apply(ctx) {
  const sessions = ctx.get('sessions');
  if (sessions === undefined) throw new Error('msg-edit: the session store is not mounted');
  // One definition per event type: the registry refuses a second owner.
  ctx.effect(
    () => sessions.registerMessageProjection({ type: RECORD_TYPE, project }),
    'msg-edit: message projection',
  );
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: MESSAGE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) => messageResponse(ctx, request),
    }),
    'msg-edit: message route',
  );
}

/** `connection` carries the route registry; the stores are read through `ctx.get` so a partial profile still loads. */
export const inject = ['connection'];
