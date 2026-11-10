/**
 * Round-trip verification for the md-session-import plugin.
 *
 * Input is produced by the REAL export formatter (`formatSessionMarkdown`), and
 * every event the import builds is put through two REAL validators:
 *
 * - `adoptSessionEvent`, the function the persistence read path calls; and
 * - the format catalog's restore path (`createRestore` → `decodeRow` →
 *   `finish`), which is the only place the surface fold and the tool-call
 *   lifecycle are enforced. A log that passes the first and fails the second
 *   would open once and then refuse every later turn, so both run here.
 *
 * Failure details stay structural (line numbers, lengths, counts). Transcript
 * content is never echoed into the report.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const DSH = 'C:/Users/q1505/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const PLUGIN = 'C:/Users/q1505/.dsh/plugins/md-session-import';
const SESSIONS = 'C:/Users/q1505/.dsh/sessions';

const { formatSessionMarkdown } = await import(`file:///${DSH}/dsh-session-log-export/lib/index.js`);
const { adoptSessionEvent, KNOWN_SESSION_EVENT_TYPES } = await import(`file:///${DSH}/dsh-session/lib/index.js`);
const { sessionFormatCatalog } = await import(`file:///${DSH}/dsh-session-format-catalog/lib/index.js`);
const { parseSessionMarkdown, buildSessionEvents, importHeader, ImportError } = await import(`file:///${PLUGIN}/index.js`);

let passed = 0;
const failures = [];
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`);
};

/** First index at which two documents differ, for a content-free report. */
const firstDifference = (a, b) => {
  const left = a.split('\n');
  const right = b.split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) return `line ${i + 1}: lengths ${String(left[i]?.length)} vs ${String(right[i]?.length)}`;
  }
  return 'identical lines';
};

/** Decode the multi-frame zstd artifact one frame at a time. */
const readLog = (file) => {
  const buffer = readFileSync(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  let at = -1;
  while ((at = buffer.indexOf(magic, at + 1)) !== -1) starts.push(at);
  let text = '';
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : buffer.length;
    try {
      text += zstdDecompressSync(buffer.subarray(from, to)).toString('utf8');
    } catch {
      /* a false magic inside compressed data: skip */
    }
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
    .filter((event) => event.type !== 'session');
};

/** The message body of one content array, as the import stores it. */
const bodyText = (content) => content.filter((block) => block.type === 'text').map((block) => block.text).join('\n\n');

/** Every assistant text a turn carries, in order. */
const turnText = (turn) => turn.steps.map((step) => step.text).filter((text) => text !== '').join('\n\n');

/** Every tool call a turn carries, in order. */
const turnCalls = (turn) => turn.steps.flatMap((step) => step.calls);

/** Every tool result the imported log holds, in order. */
const resultTexts = (events) => events
  .filter((event) => event.type === 'tool/result')
  .map((event) => bodyText(event.data.message.content));

/**
 * Walk the rebuilt log with the structural rules the agent loop depends on, so
 * a failure names the broken pairing instead of a decoder stack.
 */
const structureProblems = (events) => {
  const problems = [];
  let turn;
  let step;
  let tools = new Set();
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        if (turn !== undefined) problems.push('nested turn');
        turn = event.data.turn;
        step = undefined;
        tools = new Set();
        break;
      case 'turn/end':
        if (step !== undefined) problems.push('turn/end inside an open step');
        if (tools.size > 0) problems.push('turn/end with an unresolved call');
        turn = undefined;
        break;
      case 'step/start':
        if (step !== undefined) problems.push('nested step');
        step = event.data.step;
        tools = new Set();
        break;
      case 'step/end':
        if (tools.size > 0) problems.push('step/end with an unresolved call');
        step = undefined;
        break;
      case 'assistant/message':
        if (event.data.turn !== turn || event.data.step !== step) problems.push('assistant message outside its step');
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') tools.add(block.id);
        }
        break;
      case 'tool/call':
        if (event.data.turn !== turn || event.data.step !== step) problems.push('tool/call outside its step');
        if (!tools.has(event.data.callId)) problems.push('tool/call that no assistant block advertised');
        break;
      case 'tool/result':
        if (event.data.turn !== turn || event.data.step !== step) problems.push('tool/result outside its step');
        if (!tools.delete(event.data.message.toolCallId)) problems.push('tool/result with no live call');
        break;
      default:
        break;
    }
  }
  return problems;
};

/** Run the real restore path over the rebuilt log: surface fold plus tool lifecycle. */
const validateAsStored = (events) => {
  const header = importHeader('session-verify', { createdAt: 1_700_000_000_000 });
  const restore = sessionFormatCatalog.createRestore(
    { type: 'session', version: 4, id: header.id, createdAt: header.createdAt, isSeeded: false, delegationDepth: 0 },
    { validation: 'current' },
  );
  for (const event of events) restore.decodeRow(event);
  restore.finish();
};

/** Run the import path over one document and validate every built event. */
const importDocument = (markdown) => {
  const parsed = parseSessionMarkdown(markdown);
  const events = buildSessionEvents(parsed, { createdAt: 1_700_000_000_000 });
  events.forEach((event, index) => {
    check(`seq contiguous at ${index}`, event.seq === index, `got ${event.seq}`);
    check(`known type "${event.type}"`, KNOWN_SESSION_EVENT_TYPES.has(event.type));
    adoptSessionEvent(event);
  });
  const problems = structureProblems(events);
  check('structure: turns, steps and calls pair up', problems.length === 0, problems.join('; '));
  try {
    validateAsStored(events);
    passed += 1;
  } catch (error) {
    check('restore path accepts the log', false, String(error?.message));
  }
  return { parsed, events };
};

//#region 1. Real transcripts survive export → import
// Every stored transcript that carries tool work and a quoted user message is
// worth more than a fixed list: the corpus changes, and a hand-picked id turns
// the whole suite red the day it is deleted.
const corpus = [];
for (const project of readdirSync(SESSIONS)) {
  let entries;
  try {
    entries = readdirSync(join(SESSIONS, project));
  } catch {
    continue;
  }
  for (const entry of entries) {
    const file = join(SESSIONS, project, entry, 'session.v4.jsonl.zstd');
    if (!existsSync(file)) continue;
    let events;
    try {
      events = readLog(file);
    } catch {
      continue;
    }
    const calls = events.filter((event) => event.type === 'tool/call').length;
    const quoted = events.filter((event) => event.type === 'user/message' && event.surfaceOp === 'append' && event.data.source.kind === 'user').length;
    if (calls > 0 && quoted > 0) corpus.push({ label: entry.slice(0, 20), events, calls });
  }
}
corpus.sort((a, b) => b.calls - a.calls);
const sample = corpus.slice(0, 5);
check('corpus: found transcripts with tool work', sample.length > 0, `${corpus.length} candidates`);

let restoredCalls = 0;
let restoredResults = 0;
for (const { label, events: source } of sample) {
  const markdown = formatSessionMarkdown(source);
  const { parsed, events } = importDocument(markdown);
  const importedUsers = events.filter((e) => e.type === 'user/message').length;
  const importedAssistants = events.filter((e) => e.type === 'assistant/message').length;
  const importedCalls = events.filter((e) => e.type === 'tool/call');
  const importedResults = events.filter((e) => e.type === 'tool/result');
  restoredCalls += importedCalls.length;
  restoredResults += importedResults.length;

  const sourceUsers = source.filter((e) => e.type === 'user/message' && e.surfaceOp === 'append' && e.data.source.kind === 'user').length;
  const sourceCalls = source.filter((e) => e.type === 'tool/call');
  const sourceResults = source.filter((e) => e.type === 'tool/result' && e.surfaceOp === 'append');

  // The export writes an assistant reply's own text verbatim, so a reply that
  // itself contains a line starting with ">" exports a line that is
  // indistinguishable from a user message. The import then reads it as one and
  // gains a turn. This is a property of the document format, not of the import:
  // the format carries no escape for a leading ">". Count the collisions so the
  // check states the exact discrepancy instead of hiding it.
  const phantomQuotes = source
    .filter((event) => event.type === 'assistant/message' && event.surfaceOp === 'append')
    .filter((event) =>
      (event.data.message.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .split('\n')
        .some((line) => line.startsWith('>')),
    ).length;
  const phantomNote = phantomQuotes === 0 ? '' : ` (${String(phantomQuotes)} assistant repl${phantomQuotes === 1 ? 'y' : 'ies'} in this transcript start a line with ">"; the format has no escape for it)`;

  check(`${label}: every quoted user message preserved`, importedUsers === sourceUsers + phantomQuotes, `source ${sourceUsers} imported ${importedUsers}${phantomNote}`);
  check(`${label}: every turn has a user message`, parsed.turns.every((t) => t.user !== null));
  check(`${label}: every tool call restored`, importedCalls.length === sourceCalls.length, `${sourceCalls.length} source vs ${importedCalls.length} imported`);
  // A call the source never settled still needs one result, so the rebuild may
  // hold exactly as many extra results as there are unsettled calls.
  const settled = new Set(sourceResults.map((event) => String(event.data.message.toolCallId)));
  const unresolved = sourceCalls.filter((event) => !settled.has(String(event.data.callId))).length;
  check(`${label}: every tool result restored`, importedResults.length === sourceResults.length + unresolved, `${sourceResults.length} source + ${unresolved} repairs vs ${importedResults.length}`);
  check(`${label}: call names preserved in order`,
    JSON.stringify(importedCalls.map((e) => e.data.name)) === JSON.stringify(sourceCalls.map((e) => e.data.name)));
  const sameValue = (left, right) => {
    try {
      return JSON.stringify(JSON.parse(left)) === JSON.stringify(JSON.parse(right));
    } catch {
      return left === right;
    }
  };
  check(`${label}: call arguments preserved`,
    importedCalls.every((event, index) => sameValue(event.data.arguments, sourceCalls[index]?.data.arguments ?? '')));

  const sourceTitle = source.findLast((e) => e.type === 'session/title')?.data.title;
  const importedTitle = events.find((e) => e.type === 'session/title')?.data.title;
  check(`${label}: title preserved`, importedTitle === sourceTitle, `${JSON.stringify(sourceTitle)} vs ${JSON.stringify(importedTitle)}`);

  // The user text itself must survive byte for byte, modulo line endings: a
  // Markdown document cannot distinguish a CRLF in the content from one that is
  // document formatting, so the import normalizes them. This is the exact claim,
  // and it is stronger than comparing documents: the export merges every user
  // message delivered in one turn into that turn, and this import deliberately
  // gives each user message its own turn, so the collapsed blocks of a merged
  // turn move. Taken straight from the source log rather than re-derived.
  const sourceTexts = source
    .filter((e) => e.type === 'user/message' && e.surfaceOp === 'append' && e.data.source.kind === 'user')
    .map((e) => e.data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').replace(/\r\n?/gu, '\n').replace(/\n+$/u, ''));
  const importedTexts = parsed.turns.map((t) => t.user).filter((text) => text !== null);
  // Every genuine user text must still be present and in order; the phantom
  // quotes above are extra entries the document itself introduced.
  const genuineOnly = importedTexts.filter((text) => sourceTexts.includes(text));
  check(`${label}: user text preserved exactly`, JSON.stringify(genuineOnly) === JSON.stringify(sourceTexts), `${sourceTexts.length} source vs ${genuineOnly.length} genuine; first mismatch at index ${sourceTexts.findIndex((t, i) => t !== genuineOnly[i])}`);
  check(`${label}: nothing but the documented collision is added`, importedTexts.length === sourceTexts.length + phantomQuotes, `${String(importedTexts.length)} imported vs ${String(sourceTexts.length)} source + ${String(phantomQuotes)} phantom`);

  // Re-exporting the rebuild and importing again must reach a fixed point: the
  // structure an import produces is a structure the export understands.
  const roundBody = formatSessionMarkdown(events);
  const again = buildSessionEvents(parseSessionMarkdown(roundBody), { createdAt: 1_700_000_000_000 });
  check(`${label}: re-import is a fixed point`, again.map((e) => e.type).join(',') === events.map((e) => e.type).join(','));
  check(`${label}: re-import keeps the call names`,
    JSON.stringify(again.filter((e) => e.type === 'tool/call').map((e) => e.data.name)) === JSON.stringify(importedCalls.map((e) => e.data.name)));

  console.log(`  ${label}: ${parsed.turns.length} turns, ${importedUsers} user / ${importedAssistants} assistant, ${importedCalls.length} calls, ${importedResults.length} results, ${events.length} events${phantomNote}`);
}
check('corpus: tool work actually restored', restoredCalls > 0 && restoredResults >= restoredCalls, `${restoredCalls} calls / ${restoredResults} results`);

// The document an import produces must be a document the export still writes.
{
  const document = '# Stable\n\n> q\n\nanswer\n';
  const { events } = importDocument(document);
  const body = (text) => text.slice(text.indexOf('\n') + 1).trim();
  check('simple: re-export is idempotent', body(formatSessionMarkdown(importDocument(body(formatSessionMarkdown(events))).events)) === body(formatSessionMarkdown(events)));
}
//#endregion

//#region 2. Fences hold structure
{
  const document = ['# Fenced', '', '> show me', '', 'Answer:', '', '```text', '> this is not a user message', '```', '', '> second', '', 'Done.', ''].join('\n');
  const { parsed, events } = importDocument(document);
  check('fence: the > inside a fence is not a user message', events.filter((e) => e.type === 'user/message').length === 2);
  check('fence: the quoted line survives in the assistant text', turnText(parsed.turns[0]).includes('> this is not a user message'));
  check('fence: two turns', parsed.turns.length === 2);
}
//#endregion

//#region 3. Collapsed blocks: tool work reconstructed
{
  const document = [
    '# Tools',
    '',
    '> do the thing',
    '',
    '<details><summary>2 previous messages</summary>',
    '',
    '**Assistant**',
    '',
    'Looking at the file first.',
    '',
    '**Tool: `read_file`**',
    '',
    '```json',
    '{ "path": "SECRET_ARGUMENT" }',
    '```',
    '',
    '**Result**',
    '',
    '```',
    '> a quoted line inside a tool result',
    'SECRET_RESULT',
    '```',
    '',
    '</details>',
    '',
    'Finished.',
    '',
  ].join('\n');
  const { parsed, events } = importDocument(document);
  const turn = parsed.turns[0];
  check('details: one user message', events.filter((e) => e.type === 'user/message').length === 1);
  check('details: intermediate text kept', turnText(turn).includes('Looking at the file first.'));
  check('details: final reply kept', turnText(turn).includes('Finished.'));
  check('details: one turn', parsed.turns.length === 1);
  check('details: two steps, one per model call', turn.steps.length === 2, String(turn.steps.length));
  check('details: the call keeps its arguments', turnCalls(turn)[0]?.arguments.includes('SECRET_ARGUMENT'));
  check('details: the result keeps its body', resultTexts(events)[0] === '> a quoted line inside a tool result\nSECRET_RESULT', JSON.stringify(resultTexts(events)[0]));
  check('details: no tool text leaked into a message', !turnText(turn).includes('SECRET_ARGUMENT') && !turnText(turn).includes('SECRET_RESULT'));
  const assistant = events.find((e) => e.type === 'assistant/message');
  check('details: the block and the call share one id',
    assistant.data.message.content.find((block) => block.type === 'tool-call')?.id === events.find((e) => e.type === 'tool/call')?.data.callId);
}
{
  // A parallel batch: two tool entries under one assistant entry stay one step
  // with two calls, which is how the original model call looked.
  const document = [
    '> go',
    '',
    '<details><summary>2 previous messages</summary>',
    '',
    '**Tool: `first`**',
    '',
    '```json',
    '{}',
    '```',
    '',
    '**Result**',
    '',
    '```',
    'one',
    '```',
    '',
    '**Tool: `second`**',
    '',
    '(no arguments)',
    '',
    '**Result**',
    '',
    '(no output)',
    '',
    '</details>',
    '',
    'done',
    '',
  ].join('\n');
  const { parsed, events } = importDocument(document);
  const calls = events.filter((e) => e.type === 'tool/call');
  check('batch: two calls in one step', calls.length === 2 && calls[0].data.step === calls[1].data.step);
  check('batch: one assistant message holds both blocks', events.filter((e) => e.type === 'assistant/message')[0].data.message.content.filter((b) => b.type === 'tool-call').length === 2);
  check('batch: (no arguments) becomes an empty argument string', calls[1].data.arguments === '', JSON.stringify(calls[1].data.arguments));
  check('batch: (no output) becomes an empty content array', JSON.stringify(resultTexts(events)[1]) === '""' && events.filter((e) => e.type === 'tool/result')[1].data.message.content.length === 0);
  check('batch: the leading tool entry opens a textless step', parsed.turns[0].steps[0].text === '');
}
{
  const document = [
    '> failing',
    '',
    '<details><summary>1 previous message</summary>',
    '',
    '**Tool: `boom`**',
    '',
    '```json',
    '{}',
    '```',
    '',
    '**Result (error)**',
    '',
    '```',
    'the failure text',
    '```',
    '',
    '</details>',
    '',
  ].join('\n');
  const { events } = importDocument(document);
  const result = events.find((e) => e.type === 'tool/result');
  check('error: flagged as an error', result.data.message.isError === true);
  check('error: the failure text is the visible content', bodyText(result.data.message.content) === 'the failure text');
}
{
  // The export writes a harness reason above the content fence. The reason is
  // metadata the model never saw, so it must not be injected into the content.
  const document = [
    '> reason',
    '',
    '<details><summary>1 previous message</summary>',
    '',
    '**Tool: `boom`**',
    '',
    '```json',
    '{}',
    '```',
    '',
    '**Result (error)**',
    '',
    'Error: FS_NOT_FOUND',
    '',
    '```',
    'the failure text',
    '```',
    '',
    '</details>',
    '',
  ].join('\n');
  const { events } = importDocument(document);
  const result = events.find((e) => e.type === 'tool/result');
  check('reason: kept as error metadata', result.data.error?.reason === 'FS_NOT_FOUND', JSON.stringify(result.data.error));
  check('reason: not folded into the content', bodyText(result.data.message.content) === 'the failure text');
  check('reason: flagged as an error', result.data.message.isError === true);
}
{
  // A call whose result never landed must still be paired, or no later turn can
  // open: the log refuses to close a step over an unresolved call.
  const document = [
    '> interrupted',
    '',
    '<details><summary>1 previous message</summary>',
    '',
    '**Tool: `lost`**',
    '',
    '```json',
    '{}',
    '```',
    '',
    '**Result**',
    '',
    '(no result recorded)',
    '',
    '</details>',
    '',
  ].join('\n');
  const { events } = importDocument(document);
  const result = events.find((e) => e.type === 'tool/result');
  check('missing result: a result is still emitted', result !== undefined);
  check('missing result: the export wording is kept', bodyText(result.data.message.content) === '(no result recorded)');
  check('missing result: flagged as an error', result.data.message.isError === true);
}
{
  // A result body containing a literal </details> line stays inside its fence.
  const document = [
    '> html',
    '',
    '<details><summary>1 previous message</summary>',
    '',
    '**Tool: `cat`**',
    '',
    '```json',
    '{}',
    '```',
    '',
    '**Result**',
    '',
    '```',
    '</details>',
    'after',
    '```',
    '',
    '</details>',
    '',
    'tail reply',
    '',
  ].join('\n');
  const { parsed, events } = importDocument(document);
  check('fence: a </details> inside a result fence does not close the block', resultTexts(events)[0] === '</details>\nafter', JSON.stringify(resultTexts(events)[0]));
  check('fence: the reply after the block is its own step', turnText(parsed.turns[0]) === 'tail reply');
}
//#endregion

//#region 4. Document furniture
{
  const document = ['# Real Title', '', 'Session file:', '', '```text', 'C:\\some\\path\\session.v4.jsonl.zstd', '```', '', '> hi', '', 'hello', ''].join('\n');
  const { parsed, events } = importDocument(document);
  check('head: title read', parsed.title === 'Real Title');
  check('head: Session file block stripped', !JSON.stringify(parsed).includes('some\\\\path'));
  check('head: title event emitted for a pinned title', events[0].type === 'session/title' && events[0].data.source.kind === 'user');
  check('head: messageSeqs is empty for a pinned title', Array.isArray(events[0].data.messageSeqs) && events[0].data.messageSeqs.length === 0);
}
{
  const { events } = importDocument('# Untitled Session\n\n> hi\n\nhello\n');
  check('head: the untitled heading emits no title event', !events.some((e) => e.type === 'session/title'));
}
{
  const { parsed } = importDocument('> no heading at all\r\n\r\nreply\r\n');
  check('head: CRLF normalized', parsed.turns[0].user === 'no heading at all' && turnText(parsed.turns[0]) === 'reply');
}
//#endregion

//#region 5. Multiline user input
{
  const { parsed } = importDocument('> line one\n> line two\n>\n> line four\n\nok\n');
  check('quote: multiline user message preserved', parsed.turns[0].user === 'line one\nline two\n\nline four', JSON.stringify(parsed.turns[0].user));
}
//#endregion

//#region 6. Rejections
{
  const expect = (name, markdown, code) => {
    try {
      buildSessionEvents(parseSessionMarkdown(markdown));
      check(name, false, 'expected a rejection');
    } catch (error) {
      check(name, error instanceof ImportError && error.code === code, `code=${String(error?.code)}`);
    }
  };
  expect('reject: empty document', '', 'no-turns');
  expect('reject: assistant-only document', '# T\n\njust prose\n', 'no-turns');
  try {
    parseSessionMarkdown(42);
    check('reject: non-string document', false, 'expected a rejection');
  } catch (error) {
    check('reject: non-string document', error instanceof ImportError && error.code === 'bad-request');
  }
}
//#endregion

//#region 7. Header shape
{
  const header = importHeader('session-abc', { cwd: 'C:\\Users\\q1505\\.dsh', createdAt: 1_700_000_000_000 });
  const allowed = ['type', 'version', 'id', 'createdAt', 'cwd', 'parentSession', 'isSeeded', 'origin', 'delegationDepth', 'agentPreset'];
  check('header: v4, unseeded, depth 0', header.version === 4 && header.isSeeded === false && header.delegationDepth === 0);
  check('header: id matches', header.id === 'session-abc');
  check('header: only storage-allowed keys', Object.keys(header).every((key) => allowed.includes(key)), Object.keys(header).join(','));
  check('header: createdAt is a safe integer', Number.isSafeInteger(header.createdAt) && header.createdAt >= 0);
}
//#endregion

//#region 8. Assistant message shape
{
  const { events } = importDocument('> q\n\nanswer\n');
  const assistant = events.find((e) => e.type === 'assistant/message');
  check('assistant: carries a stream', Array.isArray(assistant.data.stream) && assistant.data.stream.length === 2);
  check('assistant: stream ends the block with the full text', assistant.data.stream[1].chunk.block.text === 'answer');
  check('assistant: no fabricated replay state', assistant.data.message.source.replayState === undefined);
  check('assistant: source is a model route', assistant.data.message.source.kind === 'model');
  check('assistant: carries turn and step', assistant.data.turn === 1 && assistant.data.step === 1);
  check('assistant: not marked interrupted', assistant.data.interrupted === undefined);
}
{
  // One start/end pair per content block, so the timed replay matches the
  // durable content it renders.
  const { events } = importDocument('> q\n\n<details><summary>1 previous message</summary>\n\n**Tool: `t`**\n\n```json\n{}\n```\n\n**Result**\n\n```\nx\n```\n\n</details>\n');
  const assistant = events.find((e) => e.type === 'assistant/message');
  check('stream: one start and one end per block', assistant.data.stream.length === 2 && assistant.data.stream[0].chunk.blockType === 'tool-call');
}
//#endregion

//#region 9. Event times stay ordered and monotonic
{
  const { events } = importDocument('> a\n\nb\n\n> c\n\nd\n');
  check('time: strictly increasing', events.every((event, index) => index === 0 || event.time > events[index - 1].time));
  check('time: bracketed turn structure', events.map((e) => e.type).join(',') === 'turn/start,step/start,user/message,assistant/message,step/end,turn/end,turn/start,step/start,user/message,assistant/message,step/end,turn/end');
}
//#endregion

console.log(`\n${passed} checks passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
if (failures.length > 0) process.exitCode = 1;
