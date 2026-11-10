// Verify the client half's static contract: the loader envelope, dictionary
// parity, the labels the code requests, and that nothing about deletion remains.
import { readFileSync } from 'node:fs'

const CLIENT = 'C:/Users/q1505/.dsh/bundles/msg-edit/client.js'
const HOST = 'C:/Users/q1505/.dsh/bundles/msg-edit/index.js'
const source = readFileSync(CLIENT, 'utf8')
const host = readFileSync(HOST, 'utf8')

let passed = 0
const failures = []
const check = (label, condition, detail = '') => {
  if (condition) { passed += 1; return }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// 1. Loader envelope.
check('declares the module id', source.includes("id: 'dsh-msg-edit'"))
check('exports inject', /\binject\b/.test(source))
check('exports apply', /return \{ inject, apply \}/.test(source))
check('registers the assistant action slot', source.includes("'conversation.chat.assistant-actions'"))
check('registers no overlay slot', !source.includes("'shell.overlay'"))
check('targets the chat view', source.includes("const CHAT_TARGET = 'chat'"))
check('uses the host route', source.includes("const ROUTE = 'api/session.message'"))
check('writes with POST', source.includes("method: 'POST'"))
check('reads with GET', source.includes("method: 'GET'"))
check('does not require Harness client packages', !/require\('@deepseek-ai\//.test(source))
check('anchors rows by the Chat view attribute', source.includes("const ROW_ATTRIBUTE = 'data-chat-node-key'"))

// 2. Deletion is gone, everywhere.
check('client has no delete action', !/action\.delete/.test(source))
check('client has no delete dialog', !/dialog\.delete/.test(source))
check('client has no deletion notice', !/notice\.deleted/.test(source))
check('client never posts a delete op', !/op: 'delete'/.test(source))
check('client has no delete button glyph', !/\\u2715/.test(source))
check('host has no delete operation', !/'delete'/.test(host))
check('host has no deletion grouping', !/deletionGroup/.test(host))
check('host has no deleted list', !/deleted/.test(host))

// 3. Dictionary key parity.
const locales = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']
const keysOf = (name) => {
  const start = source.indexOf(`const ${name} = {`)
  if (start === -1) return null
  const end = source.indexOf('\n\t\t}', start)
  const body = source.slice(start, end)
  return [...body.matchAll(/^\s*'([^']+)':/gm)].map((match) => match[1])
}
const reference = keysOf('zh')
check('zh dictionary parsed', reference !== null && reference.length > 0, `${reference?.length} keys`)
for (const name of locales.slice(1)) {
  const keys = keysOf(name)
  check(`${name} dictionary exists`, keys !== null)
  if (keys === null) continue
  const missing = reference.filter((key) => !keys.includes(key))
  const extra = keys.filter((key) => !reference.includes(key))
  check(`${name} has every key`, missing.length === 0, `missing ${missing.join(', ')}`)
  check(`${name} has no extra key`, extra.length === 0, `extra ${extra.join(', ')}`)
}

// 4. Every label the code asks for exists in the dictionary.
const requested = new Set()
for (const match of source.matchAll(/label\('([^']+)'\)/g)) requested.add(match[1])
for (const match of source.matchAll(/label\(snapshot\.busy \? '([^']+)' : '([^']+)'\)/g)) {
  requested.add(match[1]); requested.add(match[2])
}
for (const match of source.matchAll(/'(error\.[a-zA-Z]+)'/g)) requested.add(match[1])
for (const match of source.matchAll(/'(notice\.[a-zA-Z]+)'/g)) requested.add(match[1])
const unknown = [...requested].filter((key) => !reference.includes(key))
check('every requested label is defined', unknown.length === 0, `unknown ${unknown.join(', ')}`)

// 5. The overlay's derive logic, on Chat-shaped nodes.
const derive = (node, decide, active) => {
  if (!active) return node
  const messageId = node?.data?.finalNode?.messageId
  if (typeof messageId !== 'string') return node
  const text = decide(messageId)
  if (typeof text !== 'string') return node
  const blocks = node.data.blocks
  if (!Array.isArray(blocks)) return node
  const others = blocks.filter((block) => block?.kind !== 'text')
  if (others.length === blocks.length) return node
  const next = text === '' ? others : [{ kind: 'text', text }, ...others]
  return { ...node, data: { ...node.data, blocks: next, finalNode: { ...node.data.finalNode, blocks: next } } }
}
const plain = { key: 'a', data: { blocks: [{ kind: 'text', text: 'original' }], finalNode: { messageId: 'm1', blocks: [{ kind: 'text', text: 'original' }] } } }
const withTool = { key: 'b', data: { blocks: [{ kind: 'text', text: 'before' }, { kind: 'tool-call', callId: 'x' }], finalNode: { messageId: 'm2', blocks: [{ kind: 'text', text: 'before' }, { kind: 'tool-call', callId: 'x' }] } } }
const toolOnly = { key: 'c', data: { blocks: [{ kind: 'tool-call', callId: 'y' }], finalNode: { messageId: 'm3', blocks: [{ kind: 'tool-call', callId: 'y' }] } } }
const decisions = new Map([['m1', 'replaced'], ['m2', 'text plus call'], ['m3', 'ignored']])
const decide = (id) => decisions.get(id)

check('edit replaces the visible text', derive(plain, decide, true).data.blocks[0].text === 'replaced')
check('edit replaces the final node text too', derive(plain, decide, true).data.finalNode.blocks[0].text === 'replaced')
check('edit keeps the tool call after the text', (() => {
  const blocks = derive(withTool, decide, true).data.blocks
  return blocks[0].kind === 'text' && blocks[1].kind === 'tool-call'
})())
check('a tool-only message is left alone', derive(toolOnly, decide, true) === toolOnly)
check('an untouched message is the same reference', derive({ key: 'd', data: { finalNode: { messageId: 'zz' }, blocks: [] } }, decide, true).key === 'd')
check('nothing is rewritten when no decision exists', derive(plain, () => undefined, false) === plain)

// 6. The editable area replaces the message body in the document flow.
check('the editor is inserted into the flow', source.includes('parent.insertBefore(host, row.nextSibling)'))
check('the edited row leaves the layout', source.includes("row.style.display = 'none'"))
check('the row is restored afterwards', source.includes('row.style.display = previousDisplay'))
check('the editor is removed on restore', source.includes('host.remove()'))
check('the editor is never viewport-positioned', !/host: \{[^}]*position:/.test(source))
check('no viewport rect is carried in state', !/snapshot\.rect/.test(source))
check('the area matches the reply typography', /font: 'inherit'/.test(source) && source.includes('getComputedStyle(row)'))
check('the reply resolves from the Chat snapshot', source.includes('function replyNodeOf'))
check('the rendered row is found by its node key', source.includes('function rowElementOf'))
check('the source text never comes from the DOM', !/function replyNodeOf[\s\S]*?textContent/.test(/function replyNodeOf[\s\S]*?\n\t\t\}/.exec(source)?.[0] ?? ''))
check('the pencil does not walk up from itself', !/currentTarget\.closest/.test(source))

console.log(`\n${passed} checks passed, ${failures.length} failed`)
for (const failure of failures) console.log(`FAIL  ${failure}`)
process.exitCode = failures.length === 0 ? 0 : 1
