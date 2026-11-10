/**
 * Import a Session Markdown transcript as a new stored Session.
 *
 * The counterpart of `@deepseek-ai/dsh-session-log-export`'s "Copy session as
 * Markdown": `formatSessionMarkdown` renders each turn as a `>`-quoted user
 * message followed by the assistant reply, with intermediate assistant text and
 * tool work collapsed into `<details>` blocks. This plugin reads that document
 * back and rebuilds a Session log from it.
 *
 * The document is a presentation format, not a serialization format, so the
 * rebuild restores what the document actually carries and states what it cannot.
 *
 * Restored: every assistant message (its text plus one `tool-call` block per
 * tool entry, in document order), every `tool/call` with the arguments the
 * export printed, and every `tool/result` with its visible content and error
 * flag. One exported turn becomes as many steps as the transcript had model
 * calls, which is the structure the agent loop replays.
 *
 * Not recoverable, and therefore handled rather than pretended:
 *
 * - Tool call ids. The export prints names and arguments, never ids, and a call
 *   must be paired with a result carrying the same id — an unpaired call fails
 *   the next request at the provider. Each pair therefore gets one freshly
 *   minted id: the pairing is exact, only the spelling is new.
 * - Argument formatting. The export pretty-prints JSON arguments, so a call
 *   whose arguments were compact is stored pretty-printed. The block and the
 *   `tool/call` event take the same string (the log requires them to match
 *   byte for byte) and the value is unchanged.
 * - Attachment bytes. An image or file inside a result renders as an
 *   `[Image: …]`/`[File: …]` label. The label is kept; the bytes never enter
 *   the document.
 * - A call with no recorded result. The export writes `(no result recorded)`;
 *   the rebuild stores exactly that text as an error result, because a step
 *   cannot close over an unresolved call and inventing a success would be a lie.
 * - Where one model call ended and the next began, when the next one produced no
 *   text. A call batch is written as a run of tool entries under one assistant
 *   entry, and a later textless call batch is written the same way, so the two
 *   are the same shape in the document. Consecutive entries therefore rebuild as
 *   one assistant message holding every call: the same work in the same order,
 *   one message instead of two.
 *
 * A `turn` in the exported document is also not the original turn: the export
 * merges injected runtime context into the turn it was delivered in.
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
/** The tool name between the backticks of a `**Tool: \`name\`**` header. */
const TOOL_HEADER_NAME = /^Tool: `(.*)`$/u;
/** The heading the export writes above a tool result, error or not. */
const RESULT_HEADER = /^\*\*Result( \(error\))?\*\*[ \t]*$/u;
/** One quoted line the export writes for a user message. */
const QUOTED_LINE = /^> ?(.*)$/u;
/** The placeholder the export writes for a result that produced no visible content. */
const NO_OUTPUT = '(no output)';
/** The placeholder the export writes for a call whose result never landed. */
const NO_RESULT = '(no result recorded)';
/** The placeholder the export writes for a call that carried no arguments. */
const NO_ARGUMENTS = '(no arguments)';
/** The prefix the export writes before a tool failure reason. */
const ERROR_PREFIX = 'Error: ';

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
 * Token kinds: `fence` carries a whole fenced block as raw lines plus a
 * `closed` flag, so a body can be extracted without guessing where it ends;
 * `top` is a line outside every construct; `quote` is a `>`-prefixed line;
 * `details-open`, `details-body` and `details-close` bracket a collapsed block.
 * Every token also carries the `group` its document run belongs to, so a fence
 * opened inside a collapsed block stays part of that block instead of splitting
 * it and surfacing its contents as an assistant message.
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
        tokens.push({ kind: 'fence', group: fence.group, lines: fence.lines, closed: true });
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
  if (fence !== undefined) tokens.push({ kind: 'fence', group: fence.group, lines: fence.lines, closed: false });
  return tokens;
}

/**
 * The text one block carries: a fence's interior, or a single bare line.
 * @param block - a `{ kind: 'fence', … }` or `{ kind: 'line', line }` block.
 * @returns the block's own text, fence markers excluded.
 */
function blockText(block) {
  if (block.kind === 'line') return block.line;
  // A closed fence ends with its closing marker; an unterminated one runs to the
  // end of the document, so only the opening line is furniture there.
  return block.token.lines.slice(1, block.token.closed === true ? -1 : undefined).join('\n');
}

/**
 * Read the argument text a tool entry printed.
 *
 * The export writes the call's `arguments` string as a JSON fence, or the
 * literal `(no arguments)` when it was empty. Anything else is unexpected, and
 * the visible text is kept rather than dropped so no content disappears.
 *
 * @param blocks - the blocks before the result heading.
 * @returns the argument string to store on both the block and the `tool/call`.
 */
function argumentTextOf(blocks) {
  const fences = blocks.filter((block) => block.kind === 'fence');
  const blankOnly = blocks.every((block) => block.kind === 'fence' || block.line.trim() === '');
  if (fences.length === 1 && blankOnly) return blockText(fences[0]);
  const text = trimBlankEdgeLines(blocks.map(blockText).join('\n'));
  return text === NO_ARGUMENTS ? '' : text;
}

/**
 * Read the result a tool entry printed.
 *
 * The export writes one of four bodies: a fence holding the visible content,
 * `(no output)` when that content was empty, `Error: <reason>` (optionally
 * followed by the content fence) for a failure, or `(no result recorded)` when
 * the call never settled. The reason is the harness's own classification, not
 * content the model saw, so it is kept beside the text instead of inside it.
 *
 * @param errorHeading - whether the heading said `(error)`.
 * @param blocks - the blocks after the result heading.
 * @returns the result, or undefined when the export recorded none at all.
 */
function resultOf(errorHeading, blocks) {
  const fences = blocks.filter((block) => block.kind === 'fence');
  const bare = blocks.filter((block) => block.kind === 'line' && block.line.trim() !== '');
  const lone = bare.length === 1 && fences.length === 0 ? bare[0].line.trim() : undefined;
  if (lone === NO_RESULT) return undefined;
  if (lone === NO_OUTPUT) return { text: '', isError: errorHeading };
  if (lone?.startsWith(ERROR_PREFIX) === true) {
    return { text: '', isError: true, reason: lone.slice(ERROR_PREFIX.length) };
  }
  if (lone !== undefined) return { text: lone, isError: errorHeading };
  const reasonLine = bare.length === 1 && fences.length === 1 ? bare[0].line.trim() : undefined;
  if (reasonLine?.startsWith(ERROR_PREFIX) === true) {
    return { text: blockText(fences[0]), isError: true, reason: reasonLine.slice(ERROR_PREFIX.length) };
  }
  if (fences.length === 1 && bare.length === 0) return { text: blockText(fences[0]), isError: errorHeading };
  // Unrecognized shape: keep every visible line rather than lose the entry.
  return { text: trimBlankEdgeLines(blocks.map(blockText).join('\n')), isError: errorHeading };
}

/**
 * Parse one tool entry: the name from its header, then arguments and result.
 * @param name - the tool name between the header's backticks.
 * @param blocks - the entry's body blocks, header excluded.
 * @returns the tool call with whatever the export recorded of its result.
 */
function toolEntryOf(name, blocks) {
  const headingIndex = blocks.findIndex((block) => block.kind === 'line' && RESULT_HEADER.test(block.line));
  if (headingIndex === -1) {
    // No result heading at all: the entry is arguments only.
    return { kind: 'tool', name, arguments: argumentTextOf(blocks), result: undefined };
  }
  const heading = RESULT_HEADER.exec(blocks[headingIndex].line);
  return {
    kind: 'tool',
    name,
    arguments: argumentTextOf(blocks.slice(0, headingIndex)),
    result: resultOf(heading?.[1] !== undefined, blocks.slice(headingIndex + 1)),
  };
}

/**
 * Recover the entries held in one collapsed block: assistant messages and tool
 * calls, in the order the export wrote them. Consecutive tool entries belong to
 * the assistant message above them — they were its parallel calls — which is
 * what lets the rebuild reproduce one step per model call.
 *
 * The export escapes `<details>`/`<summary>` inside assistant text as HTML
 * entities; the entities are kept verbatim. Unescaping them would restore
 * literal tags that a Markdown renderer would then treat as markup, changing the
 * rendering of text the author wrote as text.
 *
 * @param tokens - the tokens between `details-open` and `details-close`.
 * @returns one entry per assistant message or tool call, blanks already removed.
 */
function entriesInDetails(tokens) {
  const entries = [];
  /** @type {{ assistant: boolean, name: string, lines: string[], blocks: object[] } | undefined} */
  let entry;
  const settle = () => {
    if (entry === undefined) return;
    if (entry.assistant) {
      const text = trimBlankEdgeLines(entry.lines.join('\n'));
      if (text !== '') entries.push({ kind: 'assistant', text });
    } else {
      entries.push(toolEntryOf(entry.name, entry.blocks));
    }
    entry = undefined;
  };
  for (const token of tokens) {
    if (token.kind === 'details-open' || token.kind === 'details-close') continue;
    if (token.kind === 'fence') {
      // A fence belongs to whichever entry is open; before any header it is
      // stray body text with nothing recoverable in it.
      if (entry?.assistant === true) entry.lines.push(...token.lines);
      else if (entry !== undefined) entry.blocks.push({ kind: 'fence', token });
      continue;
    }
    const header = ENTRY_HEADER.exec(token.line);
    if (header !== null) {
      settle();
      entry = header[1] === 'Assistant'
        ? { assistant: true, name: '', lines: [], blocks: [] }
        : { assistant: false, name: TOOL_HEADER_NAME.exec(header[1])?.[1] ?? header[1], lines: [], blocks: [] };
      continue;
    }
    if (entry === undefined) continue;
    if (entry.assistant) entry.lines.push(token.line);
    else entry.blocks.push({ kind: 'line', line: token.line });
  }
  settle();
  return entries;
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
      const entries = entriesInDetails(buffer);
      if (entries.length > 0) segments.push({ kind: 'intermediate', entries });
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
 * turn; everything the assistant did after it belongs to that turn.
 *
 * A turn is a list of steps, one per assistant message the export wrote. Tool
 * entries attach to the assistant message above them: they were that message's
 * calls, so they share its step. An entry run that opens with a tool call (an
 * assistant message whose text was blank exports no `**Assistant**` header)
 * starts a step of its own with no text.
 *
 * @param markdown - the document text.
 * @returns the title and the turn list, each turn carrying `null` for a user
 *   message when the document opens with assistant text.
 */
export function parseSessionMarkdown(markdown) {
  if (typeof markdown !== 'string') throw new ImportError('bad-request', 'import body must be Markdown text');
  const { title, tokens } = stripDocumentHead(tokenize(markdown));
  const turns = [];
  /** @type {{ user: string | null, steps: { text: string, calls: object[] }[] } | undefined} */
  let current;
  const openTurn = (user) => {
    current = { user, steps: [] };
    turns.push(current);
  };
  const openStep = (text) => {
    current.steps.push({ text, calls: [] });
  };
  for (const segment of segmentsOf(tokens)) {
    if (segment.kind === 'user') {
      openTurn(segment.text);
      continue;
    }
    if (current === undefined) openTurn(null);
    if (segment.kind === 'assistant') {
      openStep(segment.text);
      continue;
    }
    for (const entry of segment.entries) {
      if (entry.kind === 'assistant') {
        openStep(entry.text);
        continue;
      }
      if (current.steps.length === 0) openStep('');
      current.steps[current.steps.length - 1].calls.push({
        name: entry.name,
        arguments: entry.arguments,
        result: entry.result,
      });
    }
  }
  return {
    title,
    turns: turns.filter((turn) => turn.user !== null || turn.steps.length > 0),
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
 * Build the stream records an `assistant/message` carries for content that
 * arrived whole. The reader renders durable message content; the stream
 * reproduces the timed arrival, and one opening and one closing record is the
 * smallest faithful account of a block that streamed in one piece.
 *
 * @param content - the message's content blocks.
 * @param time - epoch milliseconds for every record.
 * @returns the stream record list.
 */
function contentStream(content, time) {
  const records = [];
  content.forEach((block, index) => {
    records.push({ type: 'chunk', time, chunk: { type: 'block-start', index, blockType: block.type } });
    records.push({ type: 'chunk', time, chunk: { type: 'block-end', index, block } });
  });
  return records;
}

/**
 * Build the `tool/result` event data for one reconstructed call.
 *
 * A result must exist for every advertised call before the step can close, so a
 * call whose result the document never recorded still gets one. Its text is the
 * export's own `(no result recorded)` and it is flagged as an error: the call
 * produced no result, and reporting a success that never happened would corrupt
 * the transcript the model reads next.
 *
 * @param call - the reconstructed call, carrying its minted id.
 * @param turn - the owning turn ordinal.
 * @param step - the owning step ordinal.
 * @returns the `tool/result` event data.
 */
function toolResultData(call, turn, step) {
  const result = call.result;
  const text = result === undefined ? NO_RESULT : result.text;
  const isError = result === undefined || result.isError;
  return {
    turn,
    step,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId: call.id },
      toolCallId: call.id,
      content: text === '' ? [] : textBlocks(text),
      ...(isError ? { isError: true } : {}),
      id: randomUUID(),
    },
    // The reason is harness metadata, never model-visible content, so it stays
    // beside the text instead of inside it. The name and code are the export's
    // own wording for a failure it can only describe, not identify.
    ...(result?.reason === undefined
      ? {}
      : { error: { name: 'ToolError', code: 'TOOL_ERROR', reason: result.reason } }),
  };
}

/**
 * Build the complete, seq-numbered event log for one imported transcript.
 *
 * The result is a valid log for a Session header with `isSeeded: false`: it
 * starts at seq 0, is contiguous, and brackets every turn so a reader folds a
 * balanced transcript. Surface events carry the `append` marker the log
 * requires of anything that produces a message.
 *
 * One step per assistant message is not a stylistic choice: the log rejects a
 * `tool/call` or `tool/result` whose turn/step coordinates do not match the open
 * step, and it rejects closing a step while any advertised call is unresolved.
 * So a step carries its assistant message, that message's calls, and one result
 * per call, in that order.
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
    // A turn with only a user message still needs one step to hold it.
    const steps = turn.steps.length === 0 ? [{ text: '', calls: [] }] : turn.steps;
    steps.forEach((step, stepIndex) => {
      const stepOrdinal = stepIndex + 1;
      push('step/start', { turn: ordinal, step: stepOrdinal });
      if (stepIndex === 0 && turn.user !== null) {
        push(
          'user/message',
          { content: textBlocks(turn.user), source: { kind: 'user' }, role: 'user', id: randomUUID() },
          'append',
        );
      }
      // The block and the `tool/call` event must carry the same id and the same
      // argument string: the log checks both when it pairs them.
      const calls = step.calls.map((call) => ({ ...call, id: randomUUID() }));
      const content = [];
      if (step.text !== '') content.push({ type: 'text', text: step.text });
      for (const call of calls) {
        content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments });
      }
      if (content.length > 0) {
        push(
          'assistant/message',
          {
            turn: ordinal,
            step: stepOrdinal,
            message: {
              role: 'assistant',
              content,
              source: { kind: 'model', provider, model },
              id: randomUUID(),
            },
            stream: contentStream(content, clock),
          },
          'append',
        );
      }
      for (const call of calls) {
        push('tool/call', {
          turn: ordinal,
          step: stepOrdinal,
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
      for (const call of calls) push('tool/result', toolResultData(call, ordinal, stepOrdinal), 'append');
      push('step/end', { turn: ordinal, step: stepOrdinal });
    });
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
    toolCalls: events.filter((event) => event.type === 'tool/call').length,
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
