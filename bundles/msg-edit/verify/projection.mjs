// Verify the host half against the REAL session store: the projection contract,
// the record shape, decision folding, and physical round-trip.
import { pathToFileURL } from 'node:url'

const root = 'C:/Users/q1505/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const { Session, appendPluginRecord, foldSurface } = await import(pathToFileURL(`${root}/dsh-session/lib/index.js`).href)
const llm = await import(pathToFileURL(`${root}/dsh-llm/lib/index.js`).href)
const { sessionFormatCatalog } = await import(pathToFileURL(`${root}/dsh-session-format-catalog/lib/index.js`).href)

const host = await import(pathToFileURL('C:/Users/q1505/.dsh/bundles/msg-edit/index.js').href)
const { RECORD_TYPE, apply } = host

let passed = 0
const failures = []
const check = (label, condition, detail = '') => {
  if (condition) { passed += 1; return }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// Mount against a stub context so the REAL registered projection is under test.
const registered = []
let route
apply({
  get: (name) => (name === 'sessions' ? { registerMessageProjection: (def) => { registered.push(def) } } : undefined),
  effect: (run) => run(),
  connection: { fetch: { register: (spec) => { route = spec; return () => {} } } },
  logger: { warn: () => {} },
})
check('registers exactly one projection', registered.length === 1, `got ${registered.length}`)
const projection = registered[0]
check('projection owns the record type', projection?.type === RECORD_TYPE, String(projection?.type))
check('route serves GET and POST', route?.methods?.includes('GET') === true && route?.methods?.includes('POST') === true)
check('the route is the edit route', route?.path === '/api/session.message', String(route?.path))

const HEADER = (id) => ({ version: 4, id, createdAt: 1_700_000_000_000, isSeeded: false, delegationDepth: 0 })

function build(id, { content, extra } = {}) {
  const session = Session.create(id, [], HEADER(id), 0, [projection])
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1, message: llm.createSystemMessage('sys') }, { surfaceOp: 'append' })
  session.append('user/message', llm.createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: llm.createAssistantMessage({
      content: content ?? [{ type: 'text', text: 'answer one' }],
      source: { provider: 'p', model: 'm' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  if (extra !== undefined) extra(session)
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'success' } })
  return session
}

const assistantId = (session) => session.deriveMessages().find((m) => m.role === 'assistant')?.id
const textOf = (message) => message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')

function roundTrip(session, projections) {
  const rows = [sessionFormatCatalog.encodeCurrentHeader(session.header, 0)]
  for (const event of session.snapshotEvents()) rows.push(sessionFormatCatalog.encodeCurrentEvent(event))
  const restore = sessionFormatCatalog.createRestore(rows[0], { recovery: 'strict', validation: 'current' })
  for (const row of rows.slice(1)) restore.decodeRow(row)
  const artifact = restore.finish()
  const fold = foldSurface(artifact.events, projections)
  const messages = []
  for (const seq of fold.nodes) {
    const projected = fold.projectedMessages.get(seq)
    if (projected === null) continue
    const event = artifact.events[seq]
    const message = projected ?? (event.type === 'user/message' ? event.data : event.data.message)
    if (message === undefined || message.content.length === 0) continue
    messages.push(message)
  }
  return messages
}

// 1. Edit rewrites the prose and keeps the identity.
{
  const session = build('e1')
  const before = assistantId(session)
  appendPluginRecord(session, RECORD_TYPE, { op: 'edit', messageIds: [before], text: 'REWRITTEN' })
  const after = session.deriveMessages().find((m) => m.role === 'assistant')
  check('edit rewrites the text', textOf(after) === 'REWRITTEN', textOf(after))
  check('edit keeps the identity', after.id === before)
}

// 2. A second edit supersedes the first.
{
  const session = build('e2')
  const id = assistantId(session)
  appendPluginRecord(session, RECORD_TYPE, { op: 'edit', messageIds: [id], text: 'FIRST' })
  appendPluginRecord(session, RECORD_TYPE, { op: 'edit', messageIds: [id], text: 'SECOND' })
  check('second edit supersedes', textOf(session.deriveMessages().find((m) => m.role === 'assistant')) === 'SECOND')
}

// 3. Editing a message that carries a tool call keeps the call, text first.
{
  const session = build('e3', {
    content: [
      { type: 'text', text: 'let me look' },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
    ],
    extra: (s) => {
      s.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' })
      s.append('tool/result', { turn: 1, step: 1, message: { id: 't1', role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'body' }], source: { kind: 'tool', callId: 'c1' } } }, { surfaceOp: 'append' })
    },
  })
  appendPluginRecord(session, RECORD_TYPE, { op: 'edit', messageIds: [assistantId(session)], text: 'EDITED' })
  const message = session.deriveMessages().find((m) => m.role === 'assistant')
  check('edit keeps the tool call', message.content.some((b) => b.type === 'tool-call'), JSON.stringify(message.content.map((b) => b.type)))
  check('edit puts text first', message.content[0].type === 'text' && message.content[0].text === 'EDITED')
  check('the tool result is untouched', session.deriveMessages().some((m) => m.role === 'tool'))
}

// 4. Physical round-trip preserves the edit.
{
  const session = build('e4')
  appendPluginRecord(session, RECORD_TYPE, { op: 'edit', messageIds: [assistantId(session)], text: 'ROUNDTRIP' })
  const messages = roundTrip(session, [projection])
  check('round-trip keeps the edit', textOf(messages.at(-1)) === 'ROUNDTRIP', textOf(messages.at(-1)))
}

// 5. Restoring with NO projection registered still succeeds (plugin uninstalled).
{
  const session = build('e5')
  appendPluginRecord(session, RECORD_TYPE, { op: 'edit', messageIds: [assistantId(session)], text: 'X' })
  let ok = true
  try { roundTrip(session, []) } catch (error) { ok = false; failures.push(`uninstalled plugin broke restore — ${error.message}`) }
  check('uninstalled plugin leaves the log restorable', ok)
}

// 6. An unknown target is inert, not fatal.
{
  const session = build('e6')
  appendPluginRecord(session, RECORD_TYPE, { op: 'edit', messageIds: ['does-not-exist'], text: 'X' })
  let ok = true
  let messages
  try { messages = roundTrip(session, [projection]) } catch (error) { ok = false; failures.push(`unknown target broke fold — ${error.message}`) }
  check('an unknown target is inert', ok && messages.some((m) => textOf(m) === 'answer one'))
}

// 7. Deletion is gone: a delete record must not silently empty anything.
{
  const session = build('e7')
  let threw = false
  try {
    appendPluginRecord(session, RECORD_TYPE, { op: 'delete', messageIds: [assistantId(session)] })
  } catch {
    threw = true
  }
  check('a delete record is rejected by the projection', threw)
}

console.log(`\n${passed} checks passed, ${failures.length} failed`)
for (const failure of failures) console.log(`FAIL  ${failure}`)
process.exitCode = failures.length === 0 ? 0 : 1
