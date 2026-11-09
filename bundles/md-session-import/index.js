/**
 * Import a Session Markdown transcript as a new stored Session.
 *
 * The counterpart of `@deepseek-ai/dsh-session-log-export`'s "Copy session as
 * Markdown": `formatSessionMarkdown` renders each turn as a `>`-quoted user
 * message followed by the assistant reply, with intermediate assistant text and
 * tool work collapsed into `<details>` blocks. This plugin reads that document
 * back and rebuilds a Session log from it.
 *
 * Two deliberate departures from the export, both because the export is a
 * presentation format and not a serialization format:
 *
 * - Tool invocations are not reconstructed. A tool call must be paired with a
 *   result carrying the same call id, or the next request fails at the
 *   provider; the collapsed block records a rendered summary of the call and
 *   its output, not the raw `arguments` string and result blocks a replay
 *   needs. Losing them costs the model that intermediate work; fabricating them
 *   would cost the user the Session.
 * - Every turn collapses to exactly one user message and one assistant message.
 *   The turn's remaining assistant text is concatenated in document order, so
 *   the imported history always alternates strictly between the two roles.
 *   A `turn` in the exported document is not the original turn: the export
 *   merges injected runtime context into the turn it was delivered in.
 *
 * Records are written straight through the persistence write handle
 * (`create` → `append` → `close`) rather than through `ctx.sessions.create()`.
 * Persistence is a plugin concern that attaches to live Sessions: only the
 * agent loop opens a `write` handle, so a store-owned Session with no agent
 * would never reach storage. A Session born here is an ordinary cold Session —
 * it lists, opens, and resumes like any other, and the first open attaches its
 * agent loop.
 *
 * @module dsh-md-session-import
 */

import { randomUUID } from 'node:crypto';

/** Plugin name; the bundle patch row id and the row `name` must both equal the package name. */
export const name = 'md-session-import';

/** Host route the browser posts one Markdown document to. */
export const IMPORT_PATH = '/api/session.import';

/**
 * Largest request body accepted, in bytes. One exported transcript of a long
 * Session is a few megabytes; this bounds a hostile or mistaken upload without
 * reaching into legitimate use.
 */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** Heading `formatSessionMarkdown` writes when the Session carries no title. */
const UNTITLED_SESSION_MARKDOWN_TITLE = 'Untitled Session';

/**
 * Fallback provider/model stamped on imported assistant messages. The original
 * route is not recoverable from the transcript, and an assistant message must
 * name some route; `assistant.message.source.replayState` stays absent, so no
 * adapter ever replays these messages as its own response.
 */
const IMPORTED_ROUTE = { provider: 'imported', model: 'imported' };

/** The import failed for a reason the caller can report to the user. */
export class ImportError extends Error {
  /**
   * @param code - machine code the browser maps to localized copy.
   * @param message - operator-facing detail for logs.
   */
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

/** Opening fence of a CommonMark fenced code block, with its info string. */
const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
/** One entry header inside a collapsed block: an assistant turn or a tool call. */
const ENTRY_HEADER = /^\*\*(Assistant|Tool: `.*`)\*\*[ \t]*$/u;
/** One quoted line the export writes for a user message. */
const QUOTED_LINE = /^> ?(.*)$/u;

/**
 * Trim blank first and last lines without touching interior blank lines.
 * @param text - any text.
 * @returns the text without surrounding blank lines.
 */
function trimBlankEdgeLines(text) {
  const lines = text.split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

/**
 * Split a document into classified tokens, tracking fenced code so that a
 * `>`-prefixed line inside a fence stays code and a `<details>` inside a fence
 * does not open a collapsed block.
 *
 * Token kinds: `fence` carries a whole fenced block as raw lines; `top` is a
 * line outside every construct; `quote` is a `>`-prefixed line; `details-open`,
 * `details-body` and `details-close` bracket a collapsed block. Every token
 * also carries the `group` its document run belongs to, so a fence opened
 * inside a collapsed block stays part of that block instead of splitting it and
 * surfacing its contents as an assistant message.
 *
 * @param markdown - the document text.
 * @returns the token list in document order.
 */
function tokenize(markdown) {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const tokens = [];
  /** @type {{ character: string, length: number, lines: string[], group: string } | undefined} */
  let fence;
  let details = false;
  for (const line of lines) {
    if (fence !== undefined) {
      fence.lines.push(line);
      const closes = new RegExp(`^ {0,3}${fence.character}{${String(fence.length)},}[ \t]*$`, 'u').test(line);
      if (closes) {
        tokens.push({ kind: 'fence', group: fence.group, lines: fence.lines });
        fence = undefined;
      }
      continue;
    }
    const opening = OPENING_FENCE.exec(line);
    if (opening !== null) {
      const marker = opening[1];
      const info = opening[2];
      // A backtick fence may not carry a backtick in its info string; that is
      // ordinary text, not a fence (CommonMark).
      if (!(marker.startsWith('`') && info.includes('`'))) {
        fence = {
          character: marker.slice(0, 1),
          length: marker.length,
          lines: [line],
          group: details ? 'details' : 'top',
        };
        continue;
      }
    }
    if (!details && /^ {0,3}<details(?:[\s>]|$)/u.test(line)) {
      details = true;
      tokens.push({ kind: 'details-open', group: 'details', line });
      continue;
    }
    if (details) {
      if (/^ {0,3}<\/details>[ \t]*$/u.test(line)) {
        details = false;
        tokens.push({ kind: 'details-close', group: 'details', line });
        continue;
      }
      tokens.push({ kind: 'details-body', group: 'details', line });
      continue;
    }
    if (QUOTED_LINE.test(line)) {
      tokens.push({ kind: 'quote', group: 'quote', line });
      continue;
    }
    tokens.push({ kind: 'top', group: 'top', line });
  }
  // An unterminated fence runs to the end of the document.
  if (fence !== undefined) tokens.push({ kind: 'fence', group: fence.group, lines: fence.lines });
  return tokens;
}

/**
 * Recover the assistant text held in one collapsed block. Tool entries are
 * skipped whole, including their argument and result fences, so no rendered
 * tool output leaks into a message.
 *
 * The export escapes `<details>`/`<summary>` inside this text as HTML entities;
 * the entities are kept verbatim. Unescaping them would restore literal tags
 * that a Markdown renderer would then treat as markup, changing the rendering
 * of text the author wrote as text.
 *
 * @param tokens - the tokens between `details-open` and `details-close`.
 * @returns one text per assistant entry, in order, blanks already removed.
 */
function assistantTextsInDetails(tokens) {
  const texts = [];
  /** @type {{ assistant: boolean, lines: string[] } | undefined} */
  let entry;
  const settle = () => {
    if (entry?.assistant === true) {
      const text = trimBlankEdgeLines(entry.lines.join('\n'));
      if (text !== '') texts.push(text);
    }
    entry = undefined;
  };
  for (const token of tokens) {
    if (token.kind === 'details-open' || token.kind === 'details-close') continue;
    if (token.kind === 'fence') {
      if (entry !== undefined) entry.lines.push(...token.lines);
      continue;
    }
    const header = ENTRY_HEADER.exec(token.line);
    if (header !== null) {
      settle();
      entry = { assistant: header[1] === 'Assistant', lines: [] };
      continue;
    }
    if (entry !== undefined) entry.lines.push(token.line);
  }
  settle();
  return texts;
}

/**
 * Group tokens into ordered document segments: user messages, assistant
 * replies, and collapsed blocks. Blank runs between sections fall out as empty
 * assistant segments and are dropped.
 *
 * @param tokens - classified tokens from {@link tokenize}.
 * @returns segments in document order.
 */
function segmentsOf(tokens) {
  const segments = [];
  let mode;
  let buffer = [];
  const settle = () => {
    if (mode === 'quote') {
      const text = trimBlankEdgeLines(buffer.map((token) => QUOTED_LINE.exec(token.line)?.[1] ?? '').join('\n'));
      if (text !== '') segments.push({ kind: 'user', text });
    } else if (mode === 'top') {
      const text = trimBlankEdgeLines(buffer.flatMap((token) => token.lines ?? [token.line]).join('\n'));
      if (text !== '') segments.push({ kind: 'assistant', text });
    } else if (mode === 'details') {
      const texts = assistantTextsInDetails(buffer);
      if (texts.length > 0) segments.push({ kind: 'intermediate', texts });
    }
    mode = undefined;
    buffer = [];
  };
  for (const token of tokens) {
    if (token.group !== mode) settle();
    mode = token.group;
    buffer.push(token);
  }
  settle();
  return segments;
}

/**
 * Drop the document's leading `# Title` heading and the optional `Session file:`
 * provenance block that `formatSessionMarkdown` writes when the caller supplies
 * one. Both are document furniture, not transcript.
 *
 * @param tokens - classified tokens.
 * @returns the title (or undefined) and the remaining tokens.
 */
function stripDocumentHead(tokens) {
  let index = 0;
  let title;
  while (index < tokens.length && tokens[index].kind === 'top' && tokens[index].line.trim() === '') index += 1;
  const heading = tokens[index];
  if (heading?.kind === 'top') {
    const match = /^# (.*)$/u.exec(heading.line);
    if (match !== null) {
      const text = match[1].replace(/\s+/gu, ' ').trim();
      if (text !== '' && text !== UNTITLED_SESSION_MARKDOWN_TITLE) title = text;
      index += 1;
    }
  }
  while (index < tokens.length && tokens[index].kind === 'top' && tokens[index].line.trim() === '') index += 1;
  if (tokens[index]?.kind === 'top' && /^Session file:[ \t]*$/u.test(tokens[index].line)) {
    index += 1;
    while (index < tokens.length && tokens[index].kind === 'top' && tokens[index].line.trim() === '') index += 1;
    if (tokens[index]?.kind === 'fence') index += 1;
  }
  return { title, tokens: tokens.slice(index) };
}

/**
 * Parse one Session Markdown document into turns. Each user segment opens a
 * turn; the assistant text that follows it, including collapsed intermediate
 * text, belongs to that turn.
 *
 * @param markdown - the document text.
 * @returns the title and the turn list, each turn carrying `null` for a user
 *   message when the document opens with assistant text.
 */
export function parseSessionMarkdown(markdown) {
  if (typeof markdown !== 'string') throw new ImportError('bad-request', 'import body must be Markdown text');
  const { title, tokens } = stripDocumentHead(tokenize(markdown));
  const turns = [];
  /** @type {{ user: string | null, parts: string[] } | undefined} */
  let current;
  for (const segment of segmentsOf(tokens)) {
    if (segment.kind === 'user') {
      current = { user: segment.text, parts: [] };
      turns.push(current);
      continue;
    }
    if (current === undefined) {
      current = { user: null, parts: [] };
      turns.push(current);
    }
    if (segment.kind === 'assistant') current.parts.push(segment.text);
    else current.parts.push(...segment.texts);
  }
  return {
    title,
    turns: turns
      .map((turn) => ({ user: turn.user, assistant: trimBlankEdgeLines(turn.parts.join('\n\n')) }))
      .filter((turn) => turn.user !== null || turn.assistant !== '')
  };
}

/**
 * Wrap one plain text body as the single text block a message carries.
 * @param text - the message text.
 * @returns the content block list.
 */
function textBlocks(text) {
  return [{ type: 'text', text }];
}

/**
 * Build the exact compact stream records an `assistant/message` carries for
 * text that arrived whole. The reader renders durable message content; the
 * stream reproduces the timed arrival, and one opening and one closing record
 * is the smallest faithful account of a block that streamed in one piece.
 *
 * @param text - the message text.
 * @param time - epoch milliseconds for both records.
 * @returns the stream record list.
 */
function textStream(text, time) {
  return [
    { type: 'chunk', time, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { type: 'chunk', time, chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } },
  ];
}

/**
 * Build the complete, seq-numbered event log for one imported transcript.
 *
 * The result is a valid log for a Session header with `isSeeded: false`: it
 * starts at seq 0, is contiguous, and brackets every turn so a reader folds a
 * balanced transcript. Surface events carry the `append` marker the log
 * requires of anything that produces a message.
 *
 * @param parsed - the result of {@link parseSessionMarkdown}.
 * @param options - `provider`/`model` stamped on assistant messages and the
 *   `createdAt` epoch milliseconds every event time is derived from.
 * @returns the event list in seq order.
 * @throws {ImportError} when the document holds no user message.
 */
export function buildSessionEvents(parsed, options = {}) {
  const provider = options.provider ?? IMPORTED_ROUTE.provider;
  const model = options.model ?? IMPORTED_ROUTE.model;
  const createdAt = options.createdAt ?? Date.now();
  if (parsed.turns.every((turn) => turn.user === null)) {
    throw new ImportError('no-turns', 'the Markdown document holds no quoted user message');
  }
  const events = [];
  let clock = createdAt;
  const next = () => (clock += 1);
  const push = (type, data, surfaceOp) => {
    const event = { type, seq: events.length, time: next(), data };
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp;
    events.push(event);
  };
  if (parsed.title !== undefined) {
    push('session/title', { title: parsed.title, messageSeqs: [], source: { kind: 'user' } });
  }
  parsed.turns.forEach((turn, index) => {
    const ordinal = index + 1;
    push('turn/start', { turn: ordinal });
    push('step/start', { turn: ordinal, step: 1 });
    if (turn.user !== null) {
      push(
        'user/message',
        { content: textBlocks(turn.user), source: { kind: 'user' }, role: 'user', id: randomUUID() },
        'append',
      );
    }
    if (turn.assistant !== '') {
      push(
        'assistant/message',
        {
          turn: ordinal,
          step: 1,
          message: {
            role: 'assistant',
            content: textBlocks(turn.assistant),
            source: { kind: 'model', provider, model },
            id: randomUUID(),
          },
          stream: textStream(turn.assistant, clock),
        },
        'append',
      );
    }
    push('step/end', { turn: ordinal, step: 1 });
    push('turn/end', { turn: ordinal, reason: { kind: 'completed' } });
  });
  return events;
}

/**
 * Derive the immutable header for an imported Session.
 *
 * This is the logical header, not the stored line: the artifact's first line
 * adds `type: "session"` when it is encoded, and a logical header carrying that
 * field is refused as an unexpected field. `version`, `id`, `createdAt`,
 * `isSeeded` and `delegationDepth` are all required.
 *
 * @param id - the Session id to mint into the header.
 * @param options - `cwd` records the project directory the stored log is keyed
 *   by, and `agentPreset` pins the composition a later resume must reproduce.
 * @returns the complete v4 logical header.
 */
export function importHeader(id, options = {}) {
  return {
    version: 4,
    id,
    createdAt: options.createdAt ?? Date.now(),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    isSeeded: false,
    delegationDepth: 0,
    ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
  };
}

/** An absolute path on either platform: a drive letter, a UNC share, or a POSIX root. */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u;

/** HTTP status per failure code. Storage faults are the server's, not the caller's. */
const STATUS_BY_CODE = {
  'too-large': 413,
  unavailable: 503,
  'workspace-unavailable': 503,
  'workspace-not-found': 404,
  'preset-unavailable': 503,
  'preset-not-found': 404,
  'preset-broken': 422,
  'write-failed': 500,
};

/**
 * Validate one requested preset against the mounted registry and return the id
 * the registry resolved it to.
 *
 * A header naming a preset the registry cannot resolve produces a Session that
 * cannot be opened: every later resume resolves the recorded id before it
 * composes anything, so an unknown or unusable one fails there — long after the
 * import reported success and with nothing left to correct. Refusing at import
 * time keeps that failure where the user can act on it.
 *
 * @param ctx - the composed host context.
 * @param id - the requested preset id.
 * @returns the registry's resolved id.
 * @throws {ImportError} when no registry is mounted, the id is unknown, or the preset cannot compose.
 */
async function resolvePresetId(ctx, id) {
  const registry = ctx.get('agentPresets');
  if (registry === undefined) {
    throw new ImportError('preset-unavailable', 'the agent preset registry is not mounted in this profile');
  }
  let resolved;
  try {
    resolved = await registry.resolve(id);
  } catch (error) {
    throw new ImportError('preset-not-found', `agent preset "${id}" does not exist: ${String(error)}`);
  }
  if (resolved.broken !== undefined) {
    throw new ImportError('preset-broken', `agent preset "${id}" cannot compose a session: ${resolved.broken}`);
  }
  return resolved.id;
}

/**
 * The project directory an import defaults to when the caller names none.
 * Storage keys a session's directory off its `cwd`, and a session without one
 * is filed outside every project, so falling back to the process's own working
 * directory keeps an import in the project the Harness was launched for.
 * @returns the absolute working directory, or undefined when it cannot be read.
 */
function defaultCwd() {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

/**
 * Read and size-check one JSON request body.
 * @param request - the incoming Fetch request.
 * @returns the parsed body.
 * @throws {ImportError} when the body is absent, oversized, or not JSON.
 */
async function readBody(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_REQUEST_BYTES) {
    throw new ImportError('too-large', `import body of ${declared} bytes exceeds the ${String(MAX_REQUEST_BYTES)} byte limit`);
  }
  let text;
  try {
    text = await request.text();
  } catch (error) {
    throw new ImportError('bad-request', `import body could not be read: ${String(error)}`);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) {
    throw new ImportError('too-large', `import body exceeds the ${String(MAX_REQUEST_BYTES)} byte limit`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportError('bad-request', 'import body is not JSON');
  }
}

/**
 * Write one imported transcript as a new stored Session, optionally filed under
 * an existing workspace.
 *
 * `create` takes write ownership and `close` both completes durability and
 * releases it. Releasing it matters twice over: a handle left open would make
 * the later `open(id, 'write')` that resumes this Session fail with an
 * ownership error, and `attachSession` reads the Session's header back through
 * persistence, which a session that never became durable has no header for.
 *
 * The workspace's own `path` is the `cwd`, so the attach passes the only check
 * it makes: the header cwd must resolve to a directory equal to the workspace's
 * canonical path. Filing a session is that pair of steps — a correct `cwd` plus
 * the account entry — because the sidebar groups by the account, not by
 * matching directories.
 *
 * @param persistence - the mounted persistence service.
 * @param request - the request fields, including the resolved `workspace`.
 * @returns the new Session id, its counts, and the workspace outcome.
 * @throws {ImportError} when the document carries no transcript or the write fails.
 */
async function importTranscript(persistence, request) {
  const parsed = parseSessionMarkdown(request.markdown);
  const createdAt = Date.now();
  const events = buildSessionEvents(parsed, {
    createdAt,
    ...(request.provider === undefined ? {} : { provider: request.provider }),
    ...(request.model === undefined ? {} : { model: request.model }),
  });
  const id = `session-${randomUUID()}`;
  const cwd = request.workspace?.path ?? request.cwd ?? defaultCwd();
  const header = importHeader(id, {
    createdAt,
    ...(cwd === undefined ? {} : { cwd }),
    ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
  });
  let handle;
  try {
    handle = await persistence.create(header);
    await handle.append(events);
  } catch (error) {
    throw new ImportError('write-failed', `the imported Session could not be stored: ${String(error)}`);
  } finally {
    await handle?.close().catch((error) => {
      request.log?.warn?.(`session import: closing the write handle for "${id}" failed: ${String(error)}`);
    });
  }
  let attachFailed;
  if (request.workspace !== undefined) {
    try {
      await request.workspace.attachSession(id);
    } catch (error) {
      attachFailed = String(error);
      request.log?.warn?.(`session import: "${id}" was stored but could not attach to workspace "${request.workspace.id}": ${attachFailed}`);
    }
  }
  return {
    sessionId: id,
    turns: events.filter((event) => event.type === 'turn/start').length,
    messages: events.filter((event) => event.type === 'assistant/message').length,
    title: parsed.title ?? null,
    workspace: request.workspace === undefined ? null : { id: request.workspace.id, title: request.workspace.title },
    ...(attachFailed === undefined ? {} : { attachFailed: true }),
  };
}

/**
 * Answer one import request.
 * @param ctx - the composed host context.
 * @param request - the incoming Fetch request.
 * @returns the JSON response.
 */
async function importResponse(ctx, request) {
  const persist = (message) => ctx.logger?.warn?.(`md-session-import: ${message}`);
  try {
    const persistence = ctx.get('sessionPersistence');
    if (persistence === undefined) {
      return Response.json({ error: 'unavailable', message: 'session persistence is not configured' }, { status: 503 });
    }
    const body = await readBody(request);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ImportError('bad-request', 'import body must be a JSON object');
    }
    const markdown = body.markdown;
    if (typeof markdown !== 'string' || markdown.trim() === '') {
      throw new ImportError('empty', 'import body carries no Markdown text');
    }
    const cwd = body.cwd;
    if (cwd !== undefined && (typeof cwd !== 'string' || !ABSOLUTE_PATH.test(cwd))) {
      throw new ImportError('bad-request', 'cwd must be an absolute path');
    }
    const workspaceId = body.workspaceId;
    if (workspaceId !== undefined && (typeof workspaceId !== 'string' || workspaceId === '')) {
      throw new ImportError('bad-request', 'workspaceId must be a non-empty string');
    }
    // A named workspace decides the directory. Its own canonical path is the
    // only cwd its membership check accepts, so the two cannot disagree and a
    // later workspace repair cannot relocate the Session.
    let workspace;
    if (workspaceId !== undefined) {
      const registry = ctx.get('workspaceRegistry');
      if (registry === undefined) throw new ImportError('workspace-unavailable', 'the workspace registry is not mounted in this profile');
      workspace = registry.get(workspaceId);
      if (workspace === undefined) throw new ImportError('workspace-not-found', `workspace "${workspaceId}" does not exist`);
    }
    // Validate the preset before anything is written, for the reason
    // `resolvePresetId` gives: a stored header is immutable, so a bad id has no
    // later correction.
    const requestedPreset = typeof body.agentPreset === 'string' && body.agentPreset !== '' ? body.agentPreset : undefined;
    const agentPreset = requestedPreset === undefined ? undefined : await resolvePresetId(ctx, requestedPreset);
    const result = await importTranscript(persistence, {
      markdown,
      ...(workspace === undefined ? {} : { workspace }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
      ...(typeof body.provider === 'string' && body.provider !== '' ? { provider: body.provider } : {}),
      ...(typeof body.model === 'string' && body.model !== '' ? { model: body.model } : {}),
      log: { warn: persist },
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof ImportError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: STATUS_BY_CODE[error.code] ?? 400 },
      );
    }
    ctx.logger?.warn?.(`md-session-import: import failed: ${String(error)}`);
    return Response.json({ error: 'write-failed', message: 'the Session could not be created' }, { status: 500 });
  }
}

/**
 * Register the import route on the shared API channel.
 * @param ctx - host context carrying `connection` and `sessionPersistence`.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: IMPORT_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => importResponse(ctx, request),
      }),
    'md-session-import: import route',
  );
}

/** `connection` carries the route registry; persistence is read through `ctx.get` so a profile without it still loads. */
export const inject = ['connection'];
