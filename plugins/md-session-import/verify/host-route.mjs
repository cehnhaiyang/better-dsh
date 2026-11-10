/**
 * Host-wiring verification for the md-session-import bundle.
 *
 * Drives the registered route with synthetic Requests against a fake
 * persistence service, so the create → append → close transaction, the error
 * taxonomy, and the ownership release are all observed rather than assumed.
 */
const DSH = 'C:/Users/q1505/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const BUNDLE = 'C:/Users/q1505/.dsh/plugins/md-session-import';

const { adoptSessionEvent } = await import(`file:///${DSH}/dsh-session/lib/index.js`);
const { apply, inject, name, IMPORT_PATH } = await import(`file:///${BUNDLE}/index.js`);

let passed = 0;
const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`);
};

/** Build a fake host context and mount the plugin on it. */
const mount = (persistence, registry, presets) => {
  const routes = [];
  const ctx = {
    connection: {
      fetch: {
        register: (route) => {
          routes.push(route);
          return () => {};
        },
      },
    },
    get: (service) => {
      if (service === 'sessionPersistence') return persistence;
      if (service === 'workspaceRegistry') return registry;
      if (service === 'agentPresets') return presets;
      return undefined;
    },
    effect: (callback) => callback(),
    logger: { warn: () => {} },
  };
  apply(ctx);
  return routes[0];
};

/**
 * Agent-preset registry double. `resolve` mirrors the real contract: an unknown
 * id throws a RemoteError-shaped error, and a declaration whose activation
 * failed answers with `broken`.
 */
const fakePresets = (options = {}) => {
  const known = new Map([
    ['safe', {}],
    ['writing', {}],
    ['broken-one', { broken: 'row failed to activate' }],
  ]);
  const resolved = [];
  return {
    resolved,
    service: {
      async resolve(id) {
        resolved.push(id);
        const record = known.get(id);
        if (record === undefined) throw new Error(`Unknown agent preset: ${id}`);
        return record.broken === undefined ? { id } : { id, broken: record.broken };
      },
    },
  };
};

/**
 * Workspace-registry double. `attachSession` mirrors the real contract: it
 * reads the Session header back through persistence and requires the cwd to
 * resolve to the workspace's own canonical path.
 */
const fakeRegistry = (options = {}) => {
  const attached = [];
  const workspace = {
    id: 'ws-1',
    title: 'My Project',
    path: 'D:\\projects\\mine',
    async attachSession(sessionId) {
      if (options.attachThrows === true) throw new Error('attach refused');
      attached.push(sessionId);
    },
  };
  return {
    attached,
    service: {
      get: (id) => (id === workspace.id && options.unknown !== true ? workspace : undefined),
    },
  };
};

/** Persistence double recording every handle operation. */
const recordingPersistence = (options = {}) => {
  const calls = [];
  return {
    calls,
    service: {
      async create(header) {
        calls.push({ op: 'create', header });
        if (options.createThrows === true) throw new Error('create failed');
        return {
          async append(events) {
            calls.push({ op: 'append', events });
            if (options.appendThrows === true) throw new Error('append failed');
          },
          async close() {
            calls.push({ op: 'close' });
          },
        };
      },
    },
  };
};

const post = (route, payload, headers = {}) =>
  route.fetch(
    new Request(`http://127.0.0.1:3080${IMPORT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    }),
  );

check('plugin name is the bundle row name', name === 'md-session-import');
check('injects only connection', JSON.stringify(inject) === '["connection"]');
check('route path', IMPORT_PATH === '/api/session.import');

//#region Happy path
{
  const { calls, service } = recordingPersistence();
  const route = mount(service);
  check('route registered on POST with a buffered body', route.methods.join() === 'POST' && route.requestBody === 'buffered');
  const response = await post(route, { markdown: '# Title\n\n> hello\n\nhi there\n' });
  const payload = await response.json();
  check('happy: 200', response.status === 200, String(response.status));
  check('happy: session id minted', typeof payload.sessionId === 'string' && payload.sessionId.startsWith('session-'), payload.sessionId);
  check('happy: one turn reported', payload.turns === 1 && payload.messages === 1, JSON.stringify(payload));
  check('happy: title reported', payload.title === 'Title');

  const create = calls.find((c) => c.op === 'create');
  check('happy: create called once', calls.filter((c) => c.op === 'create').length === 1);
  check('happy: header is v4 and unseeded', create.header.version === 4 && create.header.isSeeded === false);
  check('happy: header id matches the response', create.header.id === payload.sessionId);
  check('happy: header carries an absolute cwd', typeof create.header.cwd === 'string' && /^[A-Za-z]:[\\/]/.test(create.header.cwd), create.header.cwd);
  check('happy: header carries no seed marker', create.header.parentSession === undefined && create.header.isSeeded === false);

  const append = calls.find((c) => c.op === 'append');
  check('happy: append called once', calls.filter((c) => c.op === 'append').length === 1);
  check('happy: appended log starts at seq 0', append.events[0].seq === 0);
  check('happy: appended log is contiguous', append.events.every((event, index) => event.seq === index));
  append.events.forEach((event) => adoptSessionEvent(event));
  check('happy: every appended event passes the real validator', true);

  const order = calls.map((c) => c.op).join(',');
  check('happy: close runs after append and releases ownership exactly once', order === 'create,append,close', order);
}
//#endregion

//#region Tool work reaches storage
{
  const { calls, service } = recordingPersistence();
  const route = mount(service);
  const markdown = [
    '> use the tool',
    '',
    '<details><summary>1 previous message</summary>',
    '',
    '**Tool: `read_file`**',
    '',
    '```json',
    '{ "path": "a.md" }',
    '```',
    '',
    '**Result**',
    '',
    '```',
    'body',
    '```',
    '',
    '</details>',
    '',
    'done',
    '',
  ].join('\n');
  const response = await post(route, { markdown });
  const payload = await response.json();
  check('tools: 200', response.status === 200, String(response.status));
  check('tools: one call reported', payload.toolCalls === 1, JSON.stringify(payload));
  const stored = calls.find((c) => c.op === 'append')?.events ?? [];
  check('tools: the call reaches storage', stored.some((e) => e.type === 'tool/call' && e.data.name === 'read_file'));
  check('tools: the result reaches storage', stored.some((e) => e.type === 'tool/result' && e.data.message.content[0]?.text === 'body'));
  check('tools: the call and the result pair up',
    stored.find((e) => e.type === 'tool/result')?.data.message.toolCallId === stored.find((e) => e.type === 'tool/call')?.data.callId);
  stored.forEach((event) => adoptSessionEvent(event));
  check('tools: every appended event passes the real validator', true);
}
//#endregion

//#region Failure paths
{
  const route = mount(undefined);
  const response = await post(route, { markdown: '> hi\n\nhello\n' });
  check('no persistence: 503 unavailable', response.status === 503 && (await response.json()).error === 'unavailable', String(response.status));
}
{
  const route = mount(recordingPersistence().service);
  const response = await post(route, { markdown: '   \n' });
  check('blank markdown: 400 empty', response.status === 400 && (await response.json()).error === 'empty', String(response.status));
}
{
  const route = mount(recordingPersistence().service);
  const response = await post(route, { markdown: '# T\n\njust prose, no quoted input\n' });
  check('prose only: 400 no-turns', response.status === 400 && (await response.json()).error === 'no-turns', String(response.status));
}
{
  const route = mount(recordingPersistence().service);
  const response = await post(route, 'not json at all');
  check('malformed body: 400 bad-request', response.status === 400 && (await response.json()).error === 'bad-request', String(response.status));
}
{
  const { calls, service } = recordingPersistence();
  const route = mount(service);
  const response = await post(route, { markdown: '> hi\n\nhello\n', cwd: 'relative/path' });
  check('relative cwd: 400 bad-request', response.status === 400 && (await response.json()).error === 'bad-request', String(response.status));
  check('relative cwd: nothing was written', calls.length === 0);
}
{
  const { calls, service } = recordingPersistence({ appendThrows: true });
  const route = mount(service);
  const response = await post(route, { markdown: '> hi\n\nhello\n' });
  check('append failure: 500 write-failed', response.status === 500 && (await response.json()).error === 'write-failed', String(response.status));
  check('append failure: the handle is still closed', calls.some((c) => c.op === 'close'), calls.map((c) => c.op).join(','));
}
{
  const { calls, service } = recordingPersistence({ createThrows: true });
  const route = mount(service);
  const response = await post(route, { markdown: '> hi\n\nhello\n' });
  check('create failure: 500 write-failed', response.status === 500 && (await response.json()).error === 'write-failed', String(response.status));
  check('create failure: no append attempted', !calls.some((c) => c.op === 'append'));
}
{
  const route = mount(recordingPersistence().service);
  const response = await post(route, { markdown: '> hi\n\nhello\n' }, { 'content-length': String(64 * 1024 * 1024) });
  check('oversized body: 413 too-large', response.status === 413 && (await response.json()).error === 'too-large', String(response.status));
}
{
  const route = mount(recordingPersistence().service);
  const response = await post(route, [1, 2, 3]);
  check('array body: 400 bad-request', response.status === 400 && (await response.json()).error === 'bad-request', String(response.status));
}
//#endregion

//#region Workspace placement
{
  const { calls, service } = recordingPersistence();
  const registry = fakeRegistry();
  const route = mount(service, registry.service);
  const response = await post(route, { markdown: '# T\n\n> hi\n\nhello\n', workspaceId: 'ws-1' });
  const payload = await response.json();
  check('workspace: 200', response.status === 200, String(response.status));
  const create = calls.find((c) => c.op === 'create');
  const append = calls.find((c) => c.op === 'append');
  check('workspace: cwd is the workspace path', create.header.cwd === 'D:\\projects\\mine', create.header.cwd);
  check('workspace: the session was written', append !== undefined && append.events.length > 0);
  check('workspace: attach ran after the handle closed', calls.map((c) => c.op).join(',') === 'create,append,close', calls.map((c) => c.op).join(','));
  check('workspace: attach named the new session', registry.attached.length === 1 && registry.attached[0] === payload.sessionId, registry.attached.join(','));
  check('workspace: the response reports it', payload.workspace?.id === 'ws-1' && payload.workspace?.title === 'My Project', JSON.stringify(payload.workspace));
  check('workspace: no failure marker', payload.attachFailed === undefined);
}
{
  const { calls, service } = recordingPersistence();
  const registry = fakeRegistry({ unknown: true });
  const route = mount(service, registry.service);
  const response = await post(route, { markdown: '> hi\n\nhello\n', workspaceId: 'ws-gone' });
  check('unknown workspace: 404', response.status === 404 && (await response.json()).error === 'workspace-not-found', String(response.status));
  check('unknown workspace: nothing written', calls.length === 0);
}
{
  const { calls, service } = recordingPersistence();
  const route = mount(service, undefined);
  const response = await post(route, { markdown: '> hi\n\nhello\n', workspaceId: 'ws-1' });
  check('no registry: 503 workspace-unavailable', response.status === 503 && (await response.json()).error === 'workspace-unavailable', String(response.status));
  check('no registry: nothing written', calls.length === 0);
}
{
  const { calls, service } = recordingPersistence();
  const registry = fakeRegistry({ attachThrows: true });
  const route = mount(service, registry.service);
  const response = await post(route, { markdown: '> hi\n\nhello\n', workspaceId: 'ws-1' });
  const payload = await response.json();
  check('attach failure still succeeds', response.status === 200, String(response.status));
  check('attach failure keeps the session', typeof payload.sessionId === 'string');
  check('attach failure is reported', payload.attachFailed === true);
  check('attach failure still closed the handle', calls.some((c) => c.op === 'close'));
}
{
  const { service } = recordingPersistence();
  const route = mount(service, fakeRegistry().service);
  const response = await post(route, { markdown: '> hi\n\nhello\n', workspaceId: '' });
  check('empty workspaceId: 400 bad-request', response.status === 400 && (await response.json()).error === 'bad-request', String(response.status));
}
{
  // A workspace wins over an explicit cwd: they can never disagree.
  const { calls, service } = recordingPersistence();
  const route = mount(service, fakeRegistry().service);
  await post(route, { markdown: '> hi\n\nhello\n', workspaceId: 'ws-1', cwd: 'C:\\elsewhere' });
  const create = calls.find((c) => c.op === 'create');
  check('workspace overrides an explicit cwd', create.header.cwd === 'D:\\projects\\mine', create.header.cwd);
}
{
  // Without a workspace the previous behaviour stands: caller cwd, else process cwd.
  const { calls, service } = recordingPersistence();
  const route = mount(service, fakeRegistry().service);
  await post(route, { markdown: '> hi\n\nhello\n', cwd: 'C:\\explicit' });
  const create = calls.find((c) => c.op === 'create');
  check('no workspace: explicit cwd honoured', create.header.cwd === 'C:\\explicit', create.header.cwd);
  check('no workspace: nothing attached', fakeRegistry().attached.length === 0);
}
//#endregion

//#region Optional route fields
{
  const { calls, service } = recordingPersistence();
  const route = mount(service, undefined, fakePresets().service);
  await post(route, { markdown: '> hi\n\nhello\n', cwd: 'D:\\somewhere', agentPreset: 'safe', provider: 'p', model: 'm' });
  const create = calls.find((c) => c.op === 'create');
  const append = calls.find((c) => c.op === 'append');
  const assistant = append.events.find((e) => e.type === 'assistant/message');
  check('optional: cwd overrides the default', create.header.cwd === 'D:\\somewhere', create.header.cwd);
  check('optional: agentPreset recorded', create.header.agentPreset === 'safe');
  check('optional: provider and model reach the assistant source', assistant.data.message.source.provider === 'p' && assistant.data.message.source.model === 'm');
}
//#endregion

//#region Preset selection
{
  const { calls, service } = recordingPersistence();
  const presets = fakePresets();
  const route = mount(service, undefined, presets.service);
  const response = await post(route, { markdown: '> hi\n\nhello\n', agentPreset: 'writing' });
  const create = calls.find((c) => c.op === 'create');
  check('preset: 200 for a healthy preset', response.status === 200, String(response.status));
  check('preset: the resolved id is what the header records', create.header.agentPreset === 'writing', create.header.agentPreset);
  check('preset: the registry was consulted exactly once', presets.resolved.length === 1 && presets.resolved[0] === 'writing', presets.resolved.join(','));
}
{
  const { calls, service } = recordingPersistence();
  const presets = fakePresets();
  const route = mount(service, undefined, presets.service);
  await post(route, { markdown: '> hi\n\nhello\n' });
  const create = calls.find((c) => c.op === 'create');
  check('preset: omitting it writes no agentPreset', create.header.agentPreset === undefined, String(create.header.agentPreset));
  check('preset: omitting it never consults the registry', presets.resolved.length === 0, presets.resolved.join(','));
}
{
  const { calls, service } = recordingPersistence();
  const route = mount(service, undefined, fakePresets().service);
  const response = await post(route, { markdown: '> hi\n\nhello\n', agentPreset: 'no-such-preset' });
  check('preset: unknown id is 404 preset-not-found', response.status === 404 && (await response.json()).error === 'preset-not-found', String(response.status));
  check('preset: unknown id writes nothing', calls.length === 0, calls.map((c) => c.op).join(','));
}
{
  const { calls, service } = recordingPersistence();
  const route = mount(service, undefined, fakePresets().service);
  const response = await post(route, { markdown: '> hi\n\nhello\n', agentPreset: 'broken-one' });
  check('preset: broken preset is 422 preset-broken', response.status === 422 && (await response.json()).error === 'preset-broken', String(response.status));
  check('preset: broken preset writes nothing', calls.length === 0, calls.map((c) => c.op).join(','));
}
{
  const { calls, service } = recordingPersistence();
  const route = mount(service, undefined, undefined);
  const response = await post(route, { markdown: '> hi\n\nhello\n', agentPreset: 'safe' });
  check('preset: no registry is 503 preset-unavailable', response.status === 503 && (await response.json()).error === 'preset-unavailable', String(response.status));
  check('preset: no registry writes nothing', calls.length === 0, calls.map((c) => c.op).join(','));
}
{
  // Validation must precede the write: a refused preset cannot leave a Session
  // behind, because a stored header is immutable and would have no correction.
  const { calls, service } = recordingPersistence();
  const registry = fakeRegistry();
  const route = mount(service, registry.service, fakePresets().service);
  const response = await post(route, { markdown: '> hi\n\nhello\n', workspaceId: 'ws-1', agentPreset: 'no-such-preset' });
  check('preset: a bad preset beats a valid workspace', response.status === 404, String(response.status));
  check('preset: nothing written and nothing attached', calls.length === 0 && registry.attached.length === 0);
}
{
  const { calls, service } = recordingPersistence();
  const route = mount(service, fakeRegistry().service, fakePresets().service);
  const response = await post(route, { markdown: '> hi\n\nhello\n', workspaceId: 'ws-1', agentPreset: 'safe' });
  const create = calls.find((c) => c.op === 'create');
  check('preset: workspace and preset compose', response.status === 200 && create.header.agentPreset === 'safe' && create.header.cwd === 'D:\\projects\\mine', `${String(create.header.agentPreset)} @ ${String(create.header.cwd)}`);
}
{
  const { service } = recordingPersistence();
  const route = mount(service, undefined, fakePresets().service);
  const response = await post(route, { markdown: '> hi\n\nhello\n', agentPreset: '' });
  const payload = await response.json();
  check('preset: empty string is treated as omitted', response.status === 200 && payload.sessionId !== undefined, String(response.status));
}
{
  const { calls, service } = recordingPersistence();
  const route = mount(service, undefined, fakePresets().service);
  const response = await post(route, { markdown: '> hi\n\nhello\n', agentPreset: 42 });
  check('preset: a non-string is ignored rather than fatal', response.status === 200, String(response.status));
  check('preset: a non-string writes no agentPreset', calls.find((c) => c.op === 'create').header.agentPreset === undefined);
}
//#endregion

console.log(`${passed} checks passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
if (failures.length > 0) process.exitCode = 1;
