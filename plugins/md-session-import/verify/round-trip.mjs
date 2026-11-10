/**
 * Round-trip verification for the md-session-import bundle.
 *
 * Input is produced by the REAL export formatter (`formatSessionMarkdown`), and
 * every event the import builds is put through the REAL session validator
 * (`adoptSessionEvent`, the same function the persistence read path calls). No
 * expectation here is written from documentation alone.
 *
 * Failure details stay structural (line numbers, lengths, counts). Transcript
 * content is never echoed into the report.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const DSH = 'C:/Users/q1505/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const BUNDLE = 'C:/Users/q1505/.dsh/plugins/md-session-import';

const { formatSessionMarkdown } = await import(`file:///${DSH}/dsh-session-log-export/lib/index.js`);
const { adoptSessionEvent, KNOWN_SESSION_EVENT_TYPES } = await import(`file:///${DSH}/dsh-session/lib/index.js`);
const { parseSessionMarkdown, buildSessionEvents, importHeader, ImportError } = await import(`file:///${BUNDLE}/index.js`);

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
const readLog = (spec) => {
  const [project, id] = spec.split('/');
  const file = join('C:/Users/q1505/.dsh/sessions', project, id, 'session.v4.jsonl.zstd');
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

/** Run the import path over one document and validate every built event. */
const importDocument = (markdown) => {
  const parsed = parseSessionMarkdown(markdown);
  const events = buildSessionEvents(parsed, { createdAt: 1_700_000_000_000 });
  events.forEach((event, index) => {
    check(`seq contiguous at ${index}`, event.seq === index, `got ${event.seq}`);
    check(`known type "${event.type}"`, KNOWN_SESSION_EVENT_TYPES.has(event.type));
    adoptSessionEvent(event);
  });
  return { parsed, events };
};

//#region 1. Real transcripts survive export → import → export
for (const spec of [
  '--C-Users-q1505-.dsh--/session-b1662c56-2472-4991-8576-0bcb306383fe',
  '--D-crack--/session-cc02a835-3e14-40fe-b5aa-6e2355adcbc4',
  '--D-the-worm-of-bliss--/session-e8e95284-5917-49f3-a51c-7dedce0c4427',
]) {
  const source = readLog(spec);
  const markdown = formatSessionMarkdown(source);
  const sourceUsers = source.filter((e) => e.type === 'user/message' && e.surfaceOp === 'append' && e.data.source.kind === 'user').length;
  const { parsed, events } = importDocument(markdown);
  const importedUsers = events.filter((e) => e.type === 'user/message').length;
  const importedAssistants = events.filter((e) => e.type === 'assistant/message').length;
  const label = spec.split('/')[1].slice(0, 20);

  // The export writes an assistant reply's own text verbatim, so a reply that
  // itself contains a line starting with ">" (a quoted example, say) exports a
  // line that is indistinguishable from a user message. The import then reads
  // it as one and gains a turn. This is a property of the document format, not
  // of the import: the format carries no escape for a leading ">", and guessing
  // one would break every document the export actually produces. Count the
  // collisions so the check states the exact discrepancy instead of hiding it.
  const bodyLines = markdown.split('\n');
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
  check(`${label}: assistant count never exceeds user count`, importedAssistants <= importedUsers, `${importedUsers} user vs ${importedAssistants} assistant`);
  const roles = events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message').map((e) => e.type);
  check(`${label}: no two assistant messages in a row`, roles.every((role, index) => index === 0 || role !== 'assistant' || roles[index - 1] !== 'assistant'));
  const sourceTitle = source.findLast((e) => e.type === 'session/title')?.data.title;
  const importedTitle = events.find((e) => e.type === 'session/title')?.data.title;
  check(`${label}: title preserved`, importedTitle === sourceTitle, `${JSON.stringify(sourceTitle)} vs ${JSON.stringify(importedTitle)}`);

  // Feed the imported log straight back into the real formatter: the document an
  // import produces must be a document the export understands.
  const body = (text) => text.slice(text.indexOf('\n') + 1).trim();
  const roundBody = body(formatSessionMarkdown(events));
  const sourceBody = body(markdown);
  check(`${label}: re-export is idempotent`, body(formatSessionMarkdown(importDocument(roundBody).events)) === roundBody);

  // The user text itself must survive byte for byte. This is the exact claim,
  // and it is stronger than comparing documents: the export merges every user
  // message delivered in one turn into that turn, and this import deliberately
  // gives each user message its own turn, so the collapsed blocks of a merged
  // turn move. Taken straight from the source log rather than re-derived.
  const sourceTexts = source
    .filter((e) => e.type === 'user/message' && e.surfaceOp === 'append' && e.data.source.kind === 'user')
    .map((e) => e.data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').replace(/\n+$/u, ''));
  const importedTexts = parsed.turns.map((t) => t.user).filter((text) => text !== null);
  // Every genuine user text must still be present and in order; the phantom
  // quotes above are extra entries the document itself introduced.
  const genuineOnly = importedTexts.filter((text) => sourceTexts.includes(text));
  check(`${label}: user text preserved exactly`, JSON.stringify(genuineOnly) === JSON.stringify(sourceTexts), `${sourceTexts.length} source vs ${genuineOnly.length} genuine; first mismatch at index ${sourceTexts.findIndex((t, i) => t !== genuineOnly[i])}`);
  check(`${label}: nothing but the documented collision is added`, importedTexts.length === sourceTexts.length + phantomQuotes, `${String(importedTexts.length)} imported vs ${String(sourceTexts.length)} source + ${String(phantomQuotes)} phantom`);
  if (!source.some((event) => event.type === 'tool/call')) {
    check(`${label}: re-export reproduces the document exactly`, roundBody === sourceBody, firstDifference(sourceBody, roundBody));
  }
  console.log(`  ${label}: ${parsed.turns.length} turns, ${importedUsers} user / ${importedAssistants} assistant, ${events.length} events${phantomNote}`);
}
//#endregion

//#region 2. Fences hold structure
{
  const document = ['# Fenced', '', '> show me', '', 'Answer:', '', '```text', '> this is not a user message', '```', '', '> second', '', 'Done.', ''].join('\n');
  const { parsed, events } = importDocument(document);
  check('fence: the > inside a fence is not a user message', events.filter((e) => e.type === 'user/message').length === 2);
  check('fence: the quoted line survives in the assistant text', parsed.turns[0].assistant.includes('> this is not a user message'));
  check('fence: two turns', parsed.turns.length === 2);
}
//#endregion

//#region 3. Collapsed blocks: assistant text kept, tool work dropped
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
  check('details: one user message', events.filter((e) => e.type === 'user/message').length === 1);
  check('details: one assistant message', events.filter((e) => e.type === 'assistant/message').length === 1);
  check('details: intermediate text kept', parsed.turns[0].assistant.includes('Looking at the file first.'));
  check('details: final reply kept', parsed.turns[0].assistant.includes('Finished.'));
  check('details: tool arguments dropped', !parsed.turns[0].assistant.includes('SECRET_ARGUMENT'));
  check('details: tool result dropped', !parsed.turns[0].assistant.includes('SECRET_RESULT'));
  check('details: no tool event emitted', !events.some((e) => e.type === 'tool/call' || e.type === 'tool/result'));
  check('details: two turns are one turn', parsed.turns.length === 1);
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
  check('head: CRLF normalized', parsed.turns[0].user === 'no heading at all' && parsed.turns[0].assistant === 'reply');
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
