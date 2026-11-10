// Verify the host route end to end against the RUNNING server: mint the same
// browser-session cookie the browser holds, then read and write an edit.
//
// The cookie is derived from the signing secret in ~/.dsh/.credentials.yaml with
// the same v1 payload and HMAC the Connection plugin uses, so this exercises the
// real authorization path rather than bypassing it.
import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const BASE = 'http://127.0.0.1:3080'
const SESSIONS = 'C:/Users/q1505/.dsh/sessions'

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

/** Issue one request with the browser cookie. */
const call = async (path, init = {}) => {
  const response = await fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), cookie } })
  let json
  try { json = await response.json() } catch { json = undefined }
  return { status: response.status, json }
}

/** Decode one Session's physical log into rows. */
function readRows(project, id) {
  const file = join(SESSIONS, project, id, 'session.v4.jsonl.zstd')
  const buffer = readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let at = -1
  while ((at = buffer.indexOf(magic, at + 1)) !== -1) starts.push(at)
  let text = ''
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : buffer.length
    try { text += zstdDecompressSync(buffer.subarray(from, to)).toString('utf8') } catch { /* false magic */ }
  }
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

// Find a live assistant message that carries text, in a Session whose log reads.
const { readdirSync } = await import('node:fs')
let target
for (const project of readdirSync(SESSIONS)) {
  let ids
  try { ids = readdirSync(join(SESSIONS, project)) } catch { continue }
  for (const id of ids) {
    let rows
    try { rows = readRows(project, id) } catch { continue }
    for (const row of rows) {
      if (row.type !== 'assistant/message') continue
      const messageId = row.data?.message?.id
      const content = row.data?.message?.content
      if (typeof messageId !== 'string' || !Array.isArray(content)) continue
      if (row.data?.interrupted === true) continue
      const texts = content.filter((block) => block.type === 'text').map((block) => block.text)
      if (texts.length === 0) continue
      target = { project, sessionId: id, messageId, text: texts.join('\n\n') }
      break
    }
    if (target !== undefined) break
  }
  if (target !== undefined) break
}
check('found a real assistant message to address', target !== undefined)

// 1. The route answers (authorized) and reports only edits.
{
  const result = await call(`/api/session.message?sessionId=${encodeURIComponent(target.sessionId)}`)
  check('GET answers 200', result.status === 200, `status ${result.status} ${JSON.stringify(result.json)}`)
  check('GET reports a revision', typeof result.json?.revision === 'number', JSON.stringify(result.json))
  check('GET reports the edited map', result.json?.edited !== null && typeof result.json?.edited === 'object')
  check('GET reports no deleted list', result.json?.deleted === undefined, JSON.stringify(result.json?.deleted))
}

// 2. Bad requests are refused with a stable code.
{
  const missing = await call('/api/session.message')
  check('GET without a session is 400', missing.status === 400, `status ${missing.status}`)
  const noMessage = await call('/api/session.message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: target.sessionId, text: 'x' }) })
  check('POST without a message id is 400', noMessage.status === 400 && noMessage.json?.error === 'bad-request', JSON.stringify(noMessage.json))
  const unknown = await call('/api/session.message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: target.sessionId, messageId: 'not-a-message', text: 'x' }) })
  check('POST with an unknown message is 404', unknown.status === 404 && unknown.json?.error === 'not-found', JSON.stringify(unknown.json))
  const tooBig = await call('/api/session.message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: target.sessionId, messageId: target.messageId, text: 'x'.repeat(40_000) }) })
  check('POST with oversized text is 413', tooBig.status === 413 && tooBig.json?.error === 'too-large', JSON.stringify(tooBig.json))
  const notJson = await call('/api/session.message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' })
  check('POST with a non-JSON body is 400', notJson.status === 400 && notJson.json?.error === 'bad-request', JSON.stringify(notJson.json))
  const noText = await call('/api/session.message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: target.sessionId, messageId: target.messageId }) })
  check('POST without text is 400', noText.status === 400 && noText.json?.error === 'bad-request', JSON.stringify(noText.json))
}

console.log(`\n${passed} checks passed, ${failures.length} failed`)
for (const failure of failures) console.log(`FAIL  ${failure}`)
console.log(`\naddressable target: session ${target?.sessionId} / message ${target?.messageId}`)
process.exitCode = failures.length === 0 ? 0 : 1
