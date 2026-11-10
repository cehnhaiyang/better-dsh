// Verify the in-place editor against a DOM and a structure faithful to the Chat
// view — including the two things that broke earlier versions.
//
// 1. The reply's action row is rendered in the TURN FOOTER (`turn-tail`), while
//    the text lives in an `assistant-step` row. Walking up from the clicked
//    button reaches the footer, finds no text, and reports "not editable".
// 2. The first repair drew a `position: fixed` overlay, which is not the message
//    body and can land off screen.
//
// The functions are extracted from the shipped bundle, so this cannot pass while
// the shipped code differs.
import { readFileSync } from 'node:fs'

const CLIENT = 'C:/Users/q1505/.dsh/bundles/msg-edit/client.js'
const source = readFileSync(CLIENT, 'utf8')

let passed = 0
const failures = []
const check = (label, condition, detail = '') => {
  if (condition) { passed += 1; return }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// --- extract the pure functions, binding the bundle's own constants ----------
function extract(name) {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`missing ${name}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced ${name}`)
}

/**
 * Compile one extracted function with the bundle's module constants bound.
 * Without this the free constants are unresolved inside `new Function` and every
 * call silently returns undefined — a false pass this suite once produced.
 * @param {string} name - the function to extract.
 * @returns {Function} the compiled function.
 */
function compile(name) {
  const literal = (constant) => {
    const match = new RegExp(`const ${constant} = '([^']*)'`).exec(source)
    if (match === null) throw new Error(`missing constant ${constant}`)
    return match[1]
  }
  const prelude = `
    const document = new Proxy({}, { get: (_t, prop) => getDocument()[prop] });
    const window = new Proxy({}, { get: (_t, prop) => getWindow()[prop] });
  `
  return new Function(
    'CHAT_TARGET',
    'ROW_ATTRIBUTE',
    'getDocument',
    'getWindow',
    `${prelude}\n${extract(name)}\nreturn ${name};`,
  )(literal('CHAT_TARGET'), literal('ROW_ATTRIBUTE'), () => globalThis.document, () => globalThis.window)
}

// --- a DOM faithful to what the Chat view renders ---------------------------
/** Element with just enough DOM for these functions. */
function element({ key, attrs = {}, text = '', children = [], rect = { top: 0, left: 0, width: 0, height: 0 } } = {}) {
  const node = {
    children,
    attrs: key === undefined ? { ...attrs } : { ...attrs, 'data-chat-node-key': key },
    ownText: text,
    parent: null,
    style: {},
    get textContent() {
      return this.ownText + this.children.map((child) => child.textContent).join('')
    },
    getBoundingClientRect() {
      return rect
    },
  }
  for (const child of children) child.parent = node
  return node
}

// The pencil sits in the Turn footer; the text sits in its own row.
const pencil = element({ attrs: { 'data-action': 'edit' } })
const actionRow = element({ children: [pencil] })
const tailRow = element({ key: 'turn-tail:1', children: [actionRow] })
const stepRow = element({ key: 'assistant-step:1', children: [element({ text: 'rendered markdown' })] })
const DOM = [stepRow, tailRow]
globalThis.document = {
  querySelectorAll(selector) {
    const match = /^\[data-chat-node-key="(.*)"\]$/.exec(selector)
    if (match === null) return []
    return DOM.filter((node) => node.attrs['data-chat-node-key'] === match[1])
  },
}

const replyNodeOf = compile('replyNodeOf')
const rowElementOf = compile('rowElementOf')

// --- 1. The original regression: the footer is not the reply -----------------
{
  let current = pencil
  while (current !== null && !Object.hasOwn(current.attrs, 'data-chat-node-key')) current = current.parent
  check('walking up from the pencil reaches the turn footer', current === tailRow)
  check('the footer is not the row that holds the text', current !== stepRow)
}

// --- 2. The reply resolves by identity, and is not vacuous -------------------
{
  const snapshot = {
    order: ['turn-tail:1', 'assistant-step:1'],
    nodes: {
      get: (key) => (key === 'assistant-step:1'
        ? { data: { blocks: [{ kind: 'text', text: '# heading\n\nbody **bold**' }], finalNode: { messageId: 'm1' } } }
        : key === 'turn-tail:1'
          ? { data: { closing: { finalNode: { messageId: 'm1' } } } }
          : undefined),
    },
  }
  const ui = { binding: () => ({ target: () => ({ getSnapshot: () => snapshot }) }) }
  const reply = replyNodeOf(ui, 'session-1', 'm1')
  check('the reply resolves to the step row', reply?.key === 'assistant-step:1', JSON.stringify(reply?.key))
  check('the source text is the raw Markdown', reply?.text === '# heading\n\nbody **bold**', JSON.stringify(reply?.text))
  check('the resolver is not vacuous', reply !== undefined)
}

// --- 3. Degenerate targets resolve to nothing -------------------------------
{
  const noText = { order: ['a'], nodes: { get: () => ({ data: { blocks: [{ kind: 'tool-call', callId: 'c' }], finalNode: { messageId: 'm1' } } }) } }
  const uiNoText = { binding: () => ({ target: () => ({ getSnapshot: () => noText }) }) }
  check('a tool-only message resolves to nothing', replyNodeOf(uiNoText, 's', 'm1') === undefined)
  const other = { order: ['a'], nodes: { get: () => ({ data: { blocks: [{ kind: 'text', text: 'x' }], finalNode: { messageId: 'zzz' } } }) } }
  const uiOther = { binding: () => ({ target: () => ({ getSnapshot: () => other }) }) }
  check('an unknown message resolves to nothing', replyNodeOf(uiOther, 's', 'm1') === undefined)
  check('a missing service yields nothing', replyNodeOf(undefined, 's', 'm1') === undefined)
  check('a missing binding yields nothing', replyNodeOf({ binding: () => undefined }, 's', 'm1') === undefined)
}

// --- 4. The rendered row resolves by key ------------------------------------
{
  check('the step row is found by key', rowElementOf('assistant-step:1') === stepRow)
  check('the footer row is found by key', rowElementOf('turn-tail:1') === tailRow)
  check('an unknown key finds nothing', rowElementOf('nope') === undefined)
  check('an empty key finds nothing', rowElementOf('') === undefined)
  check('a quote in the key cannot break the selector', rowElementOf('a"b') === undefined)
}

// --- 5. A zero-sized duplicate must not win ---------------------------------
{
  const hidden = element({ key: 'dup', rect: { top: 0, left: 0, width: 0, height: 0 } })
  const shown = element({ key: 'dup', rect: { top: 10, left: 10, width: 100, height: 40 } })
  DOM.push(hidden, shown)
  check('the laid-out duplicate wins', rowElementOf('dup') === shown)
  DOM.splice(DOM.indexOf(hidden), 1)
  DOM.splice(DOM.indexOf(shown), 1)
}

// --- 6. THE SECOND REGRESSION: the editor is in flow, not floating ----------
{
  const editorStyles = /host: \{[\s\S]*?\n\t\t\t\}/.exec(source)?.[0] ?? ''
  const areaStyles = /area: \{[\s\S]*?\n\t\t\t\}/.exec(source)?.[0] ?? ''
  check('the editor container has no position', !/position:/.test(editorStyles), editorStyles.slice(0, 60))
  check('the editable area has no position', !/position:/.test(areaStyles))
  check('the editor fills the row width instead of a measured box', /width: '100%'/.test(editorStyles))
  check('the editor never receives a viewport rect', !/snapshot\.rect|rect\.top|rect\.left/.test(source))
  check('the only fixed element left is the toast', (source.match(/position: 'fixed'/g) ?? []).length === 1)
}

// --- 7. It is mounted into the flow, replacing the row ----------------------
{
  const mount = /function mountInFlow[\s\S]*?\n\t\t\}/.exec(source)?.[0] ?? ''
  check('the editor is inserted as a sibling of the row', mount.includes('parent.insertBefore(host, row.nextSibling)'))
  check('the row is removed from layout', /row\.style\.display = 'none'/.test(mount))
  check('the row is restored', /row\.style\.display = previousDisplay/.test(mount))
  check('the editor is removed on restore', mount.includes('host.remove()'))
  check('the typography is read from the row', mount.includes('getComputedStyle(row)'))
}

// --- 8. The area is borderless, grows naturally, and cannot clip its text ---
{
  check('the area has no border of its own', /border: 'none'/.test(source))
  check('the area inherits the reply font', /font: 'inherit'/.test(source))
  // A textarea needs measured height; measuring it before layout and clipping the
  // overflow is what left only the last few lines visible. A contenteditable
  // block grows with its content, so no height formula exists to get wrong.
  check('the area is contenteditable, not a textarea', source.includes("setAttribute('contenteditable', 'true')"))
  check('no textarea is created', !/createElement\('textarea'\)/.test(source))
  // Strip comments first: the rationale names these APIs, the code must not use them.
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gmu, '')
  check('no height is pinned by script', !/scrollHeight|autosize/.test(codeOnly))
  check('the area does not clip its own overflow', !/overflow: 'hidden'/.test(source))
  check('the draft keeps line breaks', /whiteSpace: 'pre-wrap'/.test(source))
  check('the caret is placed without scrolling', source.includes('range.collapse(false)'))
}

// --- 9. It does not open a modal, and does not cover the screen -------------
{
  check('there is no modal scrim', !/styles\.scrim/.test(source))
  check('there is no dialog element', !/role: 'dialog'|'aria-modal'/.test(source))
  check('no overlay slot is registered', !source.includes("'shell.overlay'"))
}

// --- 10. The old content-matching approach is gone -------------------------
{
  check('no text-content matching remains', !/function textContainerIn/.test(source))
  check('the pencil no longer walks up from itself', !/currentTarget\.closest/.test(source))
  check('the source text never comes from the DOM', !/function replyNodeOf[\s\S]*?textContent/.test(/function replyNodeOf[\s\S]*?\n\t\t\}/.exec(source)?.[0] ?? ''))
}

console.log(`\n${passed} checks passed, ${failures.length} failed`)
for (const failure of failures) console.log(`FAIL  ${failure}`)
process.exitCode = failures.length === 0 ? 0 : 1
