// End-to-end: record a real edit through the running server, then prove the
// model-visible history changed by folding the Session's own log with the
// installed projection. The edit is reverted and its record removed at the end.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const BASE = 'http://127.0.0.1:3080'
const SESSIONS = 'C:/Users/q1505/.dsh/sessions'
const DSH = 'C:/Users/q1505/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

const { foldSurface } = await import(`file:///${DSH}/dsh-session/lib/index.js`)
const { sessionFormatCatalog } = await import(`file:///${DSH}/dsh-session-format-catalog/lib/index.js`)
const host = await import('file:///C:/Users/q1505/.dsh/bundles/msg-edit/index.js')

let passed = 0
const failures = []
const check = (label, condition, detail = '') => {
  if (condition) { passed += 1; return }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const raw = readFileSync('C:/Users/q1505/.dsh/.credentials.yaml', 'utf8')
const secret = Buffer.from(/browser-session:[\s\S]*?secret:\s*(\S+)/u.exec(raw)[1], 'base64url')
const base64url = (buffer) => Buffer.from(buffer).toString('base64url')
const authority = '127.0.0.1:3080'
const cookieName = `dsh-auth-${base64url(createHash('sha256').update(authority).digest())}`
const payload = { version: 1, authority, issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 }
const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'))
const cookie = `${cookieName}=v1.${body}.${base64url(createHmac('sha256', secret).update(body).digest())}`

const call = async (path, init = {}) => {
  const response = await fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), cookie } })
  let json
  try { json = await response.json() } catch { json = undefined }
  return { status: response.status, json }
}

/** Decode one Session's physical log into rows, keeping frame boundaries. */
function readFrames(project, id) {
  const file = join(SESSIONS, project, id, 'session.v4.jsonl.zstd')
  const buffer = readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let at = -1
  while ((at = buffer.indexOf(magic, at + 1)) !== -1) starts.push(at)
  const frames = []
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : buffer.length
    let text
    try { text = zstdDecompressSync(buffer.subarray(from, to)).toString('utf8') } catch { continue }
    frames.push({ from, to, lines: text.split('\n').filter((line) => line !== '') })
  }
  return { file, buffer, frames }
}

/** Fold a Session's physical log into current model-visible messages. */
function derivedMessages(project, id, projection) {
  const { frames } = readFrames(project, id)
  const rows = frames.flatMap((frame) => frame.lines).map((line) => JSON.parse(line))
  const restore = sessionFormatCatalog.createRestore(rows[0], { recovery: 'recoverable', validation: 'current' })
  for (const row of rows.slice(1)) restore.decodeRow(row)
  const artifact = restore.finish()
  const fold = foldSurface(artifact.events, projection === undefined ? [] : [projection])
  const messages = []
  for (const seq of fold.nodes) {
    const projected = fold.projectedMessages.get(seq)
    if (projected === null) continue
    const event = artifact.events[seq]
    const message = projected ?? (event.type === 'user/message' ? event.data : event.data.message)
    if (message === undefined || message.content.length === 0) continue
    messages.push({ seq, message })
  }
  return { messages, events: artifact.events }
}

/** The projection under test, taken from the installed host module. */
function projectionOf() {
  return {
    type: host.RECORD_TYPE,
    project: (event, context) => {
      const { op, messageIds, text } = event.data ?? {}
      if (op !== 'edit' || typeof text !== 'string') throw new Error('not an edit')
      const wanted = new Set(messageIds ?? [])
      const updates = new Map()
      for (const seq of context.nodes) {
        const source = context.events[seq - context.baseSeq]
        if (source?.type !== 'assistant/message') continue
        if (!wanted.has(source.data?.message?.id)) continue
        const original = context.messages.get(seq) ?? source.data.message
        const others = original.content.filter((block) => block?.type !== 'text')
        updates.set(seq, { ...original, content: text === '' ? others : [{ type: 'text', text }, ...others] })
      }
      return updates
    },
  }
}

const textOf = (message) => message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n')

// Find a target.
let target
for (const project of readdirSync(SESSIONS)) {
  let ids
  try { ids = readdirSync(join(SESSIONS, project)) } catch { continue }
  for (const id of ids) {
    let derived
    try { derived = derivedMessages(project, id) } catch { continue }
    const found = derived.messages.find((entry) => entry.message.role === 'assistant' && entry.message.content.some((b) => b.type === 'text'))
    if (found === undefined) continue
    target = { project, sessionId: id, messageId: found.message.id, original: textOf(found.message) }
    break
  }
  if (target !== undefined) break
}
if (target === undefined) { console.log('no addressable message'); process.exit(1) }

// 1. Baseline.
{
  const derived = derivedMessages(target.project, target.sessionId)
  const same = derived.messages.find((entry) => entry.message.id === target.messageId)
  check('baseline derives the original message', same !== undefined)
  check('baseline text matches the recorded text', textOf(same.message) === target.original)
}

// 2. Record a real edit through the route.
const marker = `MSG-EDIT-PROBE ${Date.now()}`
{
  const result = await call('/api/session.message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: target.sessionId, messageId: target.messageId, text: marker }),
  })
  check('edit is accepted', result.status === 200, `status ${result.status} ${JSON.stringify(result.json)}`)
  check('edit reports the record seq', typeof result.json?.recordSeq === 'number', JSON.stringify(result.json))
  check('edit echoes the operation', result.json?.op === 'edit', JSON.stringify(result.json))
}

// 3. The decision is readable.
{
  const read = await call(`/api/session.message?sessionId=${encodeURIComponent(target.sessionId)}`)
  check('read back reports a revision', read.json?.revision >= 1, JSON.stringify(read.json?.revision))
  check('read back carries the replacement', read.json?.edited?.[target.messageId] === marker)
}

// 4. The model-visible history carries the replacement; identity survived.
{
  const after = derivedMessages(target.project, target.sessionId, projectionOf())
  const edited = after.messages.find((entry) => entry.message.id === target.messageId)
  check('the message is still present', edited !== undefined)
  check('the model now sees the replacement', textOf(edited.message) === marker, textOf(edited.message).slice(0, 40))
  check('the durable log still holds the original', JSON.stringify(after.events).includes(target.original.slice(0, 40)))
}

// 5. Without the projection the log derives the ORIGINAL text.
{
  const plain = derivedMessages(target.project, target.sessionId)
  const same = plain.messages.find((entry) => entry.message.id === target.messageId)
  check('the durable message is unchanged', textOf(same.message) === target.original)
}

// 6. Revert by editing back to the original text.
{
  const revert = await call('/api/session.message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: target.sessionId, messageId: target.messageId, text: target.original }),
  })
  check('revert is accepted', revert.status === 200, `status ${revert.status}`)
}

// 7. Remove this suite's own records, restoring the log exactly.
{
  const { file, frames } = readFrames(target.project, target.sessionId)
  const keep = frames.filter((frame) => !frame.lines.some((line) => JSON.parse(line).type === host.RECORD_TYPE))
  const removed = frames.length - keep.length
  if (removed > 0) {
    writeFileSync(file, Buffer.concat(keep.map((frame) => readFileSync(file).subarray(frame.from, frame.to))))
  }
  const after = readFrames(target.project, target.sessionId)
  const rows = after.frames.flatMap((frame) => frame.lines).map((line) => JSON.parse(line))
  const events = rows.slice(1)
  check('probe records are removed', events.filter((row) => row.type === host.RECORD_TYPE).length === 0, `removed ${removed} frames`)
  check('the log is still dense', events.every((row, index) => row.seq === index))
  let restored = true
  try {
    const restore = sessionFormatCatalog.createRestore(rows[0], { recovery: 'strict', validation: 'current' })
    for (const row of rows.slice(1)) restore.decodeRow(row)
    restore.finish()
  } catch (error) {
    restored = false
    failures.push(`the cleaned log does not restore — ${error.message}`)
  }
  check('the cleaned log restores strictly', restored)
}

console.log(`\n${passed} checks passed, ${failures.length} failed`)
for (const failure of failures) console.log(`FAIL  ${failure}`)
console.log(`\ntarget: session ${target.sessionId} / message ${target.messageId}`)
process.exitCode = failures.length === 0 ? 0 : 1
