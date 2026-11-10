/**
 * Integration test: drive the md-session-import host path against the REAL
 * JSONL persistence backend.
 *
 * This closes the last unverified link. It mounts exactly the backend the web
 * profile mounts, runs the plugin's own route handler over a synthetic
 * authenticated request, and then reads the result back through the same
 * service a resume uses — including the `open(id, 'write')` that proves the
 * import released write ownership.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, rmSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const DSH_ROOT = 'C:/Users/q1505/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json';
const dshRequire = createRequire(DSH_ROOT);
const load = async (specifier) => import(pathToFileURL(dshRequire.resolve(specifier)).href);

const { Context } = await load('@deepseek-ai/cordis');
const jsonl = await load('@deepseek-ai/dsh-session-persistence-jsonl');
const { adoptSessionEvent } = await load('@deepseek-ai/dsh-session');
const { formatSessionMarkdown } = await load('@deepseek-ai/dsh-session-log-export');
const mdImport = await import('file:///C:/Users/q1505/.dsh/plugins/md-session-import/index.js');

let passed = 0;
const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const root = join('C:/Users/q1505/.dsh', '.verify-import-root');
if (existsSync(root)) rmSync(root, { recursive: true, force: true });

const app = new Context();
await app.plugin(jsonl, { root, compression: 'zstd' });
const persistence = app.get('sessionPersistence');
check('persistence mounted', persistence !== undefined);
check('persistence exposes a process-local identity', typeof persistence.identity === 'symbol');

// Mount the import plugin exactly as the profile does.
const routes = [];
/** Assigned after the workspace chain mounts; the route reads it per request. */
let registry;
const hostCtx = {
  connection: { fetch: { register: (route) => { routes.push(route); return () => {}; } } },
  get: (service) => service === 'sessionPersistence' ? persistence : service === 'workspaceRegistry' ? registry : undefined,
  effect: (callback) => callback(),
  logger: { warn: (message) => console.log('  [host warn]', message) },
};
mdImport.apply(hostCtx);
check('route registered', routes.length === 1 && routes[0].path === mdImport.IMPORT_PATH);

// A transcript shaped like the export produces, with a project directory.
const markdown = [
  '# Integration Title',
  '',
  '> first prompt',
  '',
  'first answer',
  '',
  '> second prompt',
  '',
  '<details><summary>1 previous message</summary>',
  '',
  '**Tool: `read`**',
  '',
  '```json',
  '{ "file_path": "D:\\\\x.md" }',
  '```',
  '',
  '**Result**',
  '',
  '```',
  'file body',
  '```',
  '',
  '</details>',
  '',
  'second answer',
  '',
].join('\n');

const response = await routes[0].fetch(
  new Request('http://127.0.0.1:3080/api/session.import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown, cwd: 'C:\\Users\\q1505\\.dsh' }),
  }),
);
const payload = await response.json();
check('import answered 200', response.status === 200, `${response.status} ${JSON.stringify(payload)}`);
if (response.status !== 200) {
  console.log('import refused:', JSON.stringify(payload));
  console.log(`${passed} checks passed, ${failures.length} failed`);
  for (const failure of failures) console.log(`  FAIL ${failure}`);
  process.exit(1);
}
check('two turns reported', payload.turns === 2, String(payload.turns));
check('title reported', payload.title === 'Integration Title');

// Read it back through the persistence service, exactly as a session list does.
const listed = await persistence.list();
const stored = listed.find((entry) => entry.header.id === payload.sessionId);
check('session appears in persistence.list', stored !== undefined, `listed ${listed.length} sessions`);
check('stored header keeps the title-bearing id', stored?.header.id === payload.sessionId);
check('stored header is unseeded v4', stored?.header.version === 4 && stored?.header.isSeeded === false);
check('stored header keeps cwd', stored?.header.cwd === 'C:\\Users\\q1505\\.dsh', stored?.header.cwd);
check('stored header carries no agentPreset', stored?.header.agentPreset === undefined);

const readHandle = await persistence.open(payload.sessionId, 'read');
const read = await readHandle.read(0, undefined);
await readHandle.close();
check('read returns the full log', read.events.length === payload.turns * 6 + 1, `got ${read.events.length}`);
check('read events start at seq 0 and are contiguous', read.events.every((event, index) => event.seq === index));
check('every stored event passes the real validator', read.events.every((event) => adoptSessionEvent(event) === event));
check('no tool events were stored', !read.events.some((e) => e.type === 'tool/call' || e.type === 'tool/result'));

// Re-export the stored log through the real formatter.
const reformatted = formatSessionMarkdown(read.events);
check('re-export keeps the title', reformatted.startsWith('# Integration Title'), reformatted.split('\n')[0]);
check('re-export keeps both prompts', (reformatted.match(/^> /gmu) ?? []).length === 2);
check('re-export drops the tool block', !reformatted.includes('read') || !reformatted.includes('file body'));

// The critical ownership check: the import must have released the write handle,
// or a resume would fail with an ownership error and the Session would be
// visible but unusable.
let ownershipError;
let writeHandle;
try {
  writeHandle = await persistence.open(payload.sessionId, 'write');
} catch (error) {
  ownershipError = error;
}
check('write ownership was released (a resume can claim it)', ownershipError === undefined, String(ownershipError));
if (writeHandle !== undefined) {
  // Extend the way a real next turn does, then confirm it round-trips: the
  // stored log must accept a contiguous continuation at the exact next seq.
  const base = read.events.length;
  const at = Date.now();
  let seq = base;
  const next = (type, data) => ({ type, seq: seq++, time: at + seq, data });
  const appended = [
    next('turn/start', { turn: payload.turns + 1 }),
    next('step/start', { turn: payload.turns + 1, step: 1 }),
    next('user/message', { content: [{ type: 'text', text: 'continued' }], source: { kind: 'user' }, role: 'user', id: 'm-1' }),
    next('assistant/message', {
      turn: payload.turns + 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'continued answer' }],
        source: { kind: 'model', provider: 'imported', model: 'imported' },
        id: 'm-2',
      },
      stream: [],
    }),
    next('step/end', { turn: payload.turns + 1, step: 1 }),
    next('turn/end', { turn: payload.turns + 1, reason: { kind: 'completed' } }),
  ];
  // Mark the two surface events the way the log requires.
  appended[2].surfaceOp = 'append';
  appended[3].surfaceOp = 'append';
  await writeHandle.append(appended);
  await writeHandle.close();
  const after = await persistence.open(payload.sessionId, 'read');
  const tail = await after.read(base, undefined);
  await after.close();
  check('a later turn lands contiguously after the import', tail.events.length === appended.length && tail.events.every((event, index) => event.seq === base + index), `got ${tail.events.length}`);
  check('the extended log still validates', tail.events.every((event) => adoptSessionEvent(event) === event));
  const reExported = formatSessionMarkdown([...read.events, ...tail.events]);
  check('the extended log re-exports with three turns', (reExported.match(/^> /gmu) ?? []).length === 3, String((reExported.match(/^> /gmu) ?? []).length));
}

// Duplicate id must be refused, so an import can never clobber an existing Session.
let duplicateRejected = false;
try {
  await persistence.create({ ...stored.header });
} catch {
  duplicateRejected = true;
}
check('creating the same id twice is refused', duplicateRejected);

// The artifact on disk is the canonical generation file.
const artifact = join(root, '--C-Users-q1505-.dsh--', payload.sessionId, 'session.v4.jsonl.zstd');
check('artifact written at the canonical path', existsSync(artifact), artifact);
if (existsSync(artifact)) {
  const buffer = readFileSync(artifact);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  check('artifact is a zstd frame', buffer.subarray(0, 4).equals(magic));
  const text = zstdDecompressSync(buffer).toString('utf8');
  const header = JSON.parse(text.split('\n')[0]);
  check('stored header line is canonical', header.type === 'session' && header.version === 4 && header.id === payload.sessionId);
  check('stored header line has no seed marker', header.inheritedEventCount === undefined && header.isSeeded === false);
  check('stored header line records delegationDepth', header.delegationDepth === 0);
}

//#region Real workspace placement
//#region
// Mount the real storage chain and the real WorkspaceRegistry, so the placement
// rule is exercised against the code that will run in production rather than
// against a double.
const Storage = (await load('@deepseek-ai/dsh-storage')).default;
const storageJson = await load('@deepseek-ai/dsh-storage-json');
const storageDomain = await load('@deepseek-ai/dsh-storage-domain');
const WorkspaceRegistry = (await load('@deepseek-ai/dsh-workspace')).default;

await app.plugin(Storage);
// The JSON backend registers itself as the backend named `json`, which is the
// key the domain facility routes through — not the plugin's own name.
await app.plugin(storageJson, { root: join(root, 'storages') });
await app.plugin(storageDomain, { backend: 'json', routes: { workspace: 'json' } });
await app.plugin(WorkspaceRegistry);
registry = app.get('workspaceRegistry');
check('workspace registry mounted', registry !== undefined);

const projectDir = join(root, 'project');
mkdirSync(projectDir, { recursive: true });
const workspace = await registry.create(projectDir, 'Verify Project');
check('workspace created', typeof workspace?.id === 'string' && workspace.path.length > 0, JSON.stringify(workspace?.path));
check('workspace path is canonical', workspace.path === realpathSync(projectDir), workspace.path);

// Import through the route, filing the session under the workspace.
const filed = await routes[0].fetch(
  new Request('http://127.0.0.1:3080/api/session.import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown: '> filed prompt\n\nfiled answer\n', workspaceId: workspace.id }),
  }),
);
const filedPayload = await filed.json();
check('filed import answered 200', filed.status === 200, `${filed.status} ${JSON.stringify(filedPayload)}`);
check('filed import reports the workspace', filedPayload.workspace?.id === workspace.id, JSON.stringify(filedPayload.workspace));
check('filed import did not warn', filedPayload.attachFailed === undefined);

const storedFiled = await persistence.open(filedPayload.sessionId, 'read');
check('filed session cwd is the workspace path', storedFiled.header.cwd === workspace.path, storedFiled.header.cwd);
await storedFiled.close();

const reRead = registry.get(workspace.id);
check('workspace now accounts the session', reRead.sessionIds.includes(filedPayload.sessionId), reRead.sessionIds.join(','));
check('the account is newest-first', reRead.sessionIds[0] === filedPayload.sessionId);

// The control: a session whose cwd differs is refused by the same real
// membership check, which is what proves the pair (cwd, attach) is required.
const stray = await routes[0].fetch(
  new Request('http://127.0.0.1:3080/api/session.import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown: '> stray prompt\n\nstray answer\n', cwd: root }),
  }),
);
const strayPayload = await stray.json();
check('unfiled import still succeeds', stray.status === 200 && typeof strayPayload.sessionId === 'string', String(stray.status));
check('unfiled import reports no workspace', strayPayload.workspace === null, JSON.stringify(strayPayload.workspace));
let refusal;
try {
  await registry.get(workspace.id).attachSession(strayPayload.sessionId);
} catch (error) {
  refusal = error;
}
check('a mismatched cwd is refused by the real membership check', refusal !== undefined, 'attach unexpectedly succeeded');
check('the refusal names the cwd mismatch', String(refusal?.message).includes('resolves to'), String(refusal?.message));
check('the refused session was not accounted', !registry.get(workspace.id).sessionIds.includes(strayPayload.sessionId));

// resolveByPath is how the maintenance script reasons about ownership; the
// imported session must resolve to the workspace we filed it under.
const byPath = await registry.resolveByPath(workspace.path);
check('resolveByPath finds the workspace', byPath?.id === workspace.id, String(byPath?.id));

// A workspace choice beats a conflicting cwd, so the two can never disagree.
const both = await routes[0].fetch(
  new Request('http://127.0.0.1:3080/api/session.import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown: '> both\n\nanswer\n', workspaceId: workspace.id, cwd: 'C:\\ignored' }),
  }),
);
const bothPayload = await both.json();
const bothHandle = await persistence.open(bothPayload.sessionId, 'read');
check('workspace wins over a conflicting cwd', bothHandle.header.cwd === workspace.path, bothHandle.header.cwd);
await bothHandle.close();

// An unknown workspace id must not create a session at all.
const before = (await persistence.list()).length;
const missing = await routes[0].fetch(
  new Request('http://127.0.0.1:3080/api/session.import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ markdown: '> nope\n\nno\n', workspaceId: 'ws-does-not-exist' }),
  }),
);
check('unknown workspace answered 404', missing.status === 404, String(missing.status));
check('unknown workspace stored nothing', (await persistence.list()).length === before);
//#endregion
//#endregion

await app.stop?.();
console.log(`${passed} checks passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
if (failures.length > 0) process.exitCode = 1;
