// Verify the two halves wired together, headlessly.
//
// Loads the REAL client bundle with a stub module loader, a stub `require`, and a
// stub context, then drives the registered component the way the Harness does.
// This answers what a static read cannot: does apply() throw, does the pencil
// carry its Session, and does a click reach the editor at all.
import { readFileSync } from 'node:fs'

const CLIENT = 'C:/Users/q1505/.dsh/bundles/msg-edit/client.js'

let passed = 0
const failures = []
const check = (label, condition, detail = '') => {
  if (condition) { passed += 1; return }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// --- minimal React -----------------------------------------------------------
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children }, $$element: true }),
  Fragment: Symbol('Fragment'),
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useState: (initial) => [initial, () => {}],
  useSyncExternalStore: (subscribe, get) => get(),
  memo: (component) => component,
}

// --- capture the module ------------------------------------------------------
let exported
// One object carries both the module loader the bundle calls into and the layout
// API the editor reads. Installing them separately used to overwrite the loader,
// which left `exported` undefined and made the whole suite vacuous.
const window = {}
window.__ModuleLoader__ = { load({ id, factory }) { exported = factory(requireStub); return { id } } }
window.getComputedStyle = () => ({ fontFamily: 'Inter', fontSize: '14px', lineHeight: '22px', letterSpacing: 'normal', color: 'rgb(0,0,0)', textAlign: 'start' })
window.getSelection = () => ({ removeAllRanges() {}, addRange() {} })
globalThis.window = window
const requireStub = (name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return { createPortal: (node) => node }
  throw new Error(`unexpected require: ${name}`)
}

// --- a DOM good enough for the in-flow editor --------------------------------
/**
 * Element with the subset of the DOM the controller uses.
 * @param {object} options - tag, attributes, children, and measured height.
 * @returns {object} the element.
 */
function element({ tag = 'div', attrs = {}, children = [], scrollHeight = 40 } = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    attrs: { ...attrs },
    style: {},
    parentElement: null,
    disabled: false,
    value: '',
    textContent: '',
    spellcheck: true,
    rows: 0,
    scrollHeight,
    listeners: new Map(),
    setAttribute(name, value) { this.attrs[name] = value },
    addEventListener(name, handler) { this.listeners.set(name, handler) },
    append(...nodes) {
      for (const child of nodes) {
        child.parentElement = this
        this.children.push(child)
      }
    },
    insertBefore(child, before) {
      child.parentElement = this
      const at = before === null ? this.children.length : this.children.indexOf(before)
      this.children.splice(at === -1 ? this.children.length : at, 0, child)
    },
    remove() {
      if (this.parentElement === null) return
      const at = this.parentElement.children.indexOf(this)
      if (at !== -1) this.parentElement.children.splice(at, 1)
      this.parentElement = null
    },
    querySelector(selector) {
      // The bundle looks its editor up by `[data-msg-edit-area]`.
      if (selector === '[data-msg-edit-area]') {
        const walk = (current) => {
          for (const child of current.children) {
            if (Object.hasOwn(child.attrs, 'data-msg-edit-area')) return child
            const found = walk(child)
            if (found !== null) return found
          }
          return null
        }
        return walk(this)
      }
      const wanted = selector.toUpperCase()
      const walk = (current) => {
        for (const child of current.children) {
          if (child.tagName === wanted) return child
          const found = walk(child)
          if (found !== null) return found
        }
        return null
      }
      return walk(this)
    },
    focus() { this.focused = true },
    setSelectionRange() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 600, height: 40 } },
  }
  for (const child of children) node.append(child)
  return node
}

const stepRow = element({ attrs: { 'data-chat-node-key': 'assistant-step:1' } })
const column = element({ children: [stepRow] })
const body = element()
globalThis.document = {
  body,
  createElement: (tag) => element({ tag }),
  // The editor places the caret with a Range; the stub only needs the shape.
  createRange: () => ({ selectNodeContents() {}, collapse() {} }),
  querySelectorAll(selector) {
    const match = /^\[data-chat-node-key="(.*)"\]$/.exec(selector)
    if (match === null) return []
    return column.children.filter((node) => node.attrs['data-chat-node-key'] === match[1])
  },
}

// --- stub context ------------------------------------------------------------
const registrations = []
const localeDictionaries = []
const slots = { inject: (name, run) => run(), register: (options, component) => { registrations.push({ options, component }); return () => {} } }
const chatSnapshot = {
  order: ['assistant-step:1'],
  nodes: {
    get: (key) => (key === 'assistant-step:1'
      ? { key, data: { blocks: [{ kind: 'text', text: 'original reply' }], finalNode: { messageId: 'm1' } } }
      : undefined),
  },
}
const uiConversation = {
  views: { entries: () => [], subscribe: () => () => {} },
  binding: () => ({ target: () => ({ getSnapshot: () => chatSnapshot }) }),
  sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } },
}
const ctx = {
  effect: (run) => run(),
  get: (name) => (name === 'uiConversation' ? uiConversation : undefined),
  inject: (names, callback) => { callback({ get: () => uiConversation }) },
  slots,
  locale: {
    register: (ns, dictionaries) => { localeDictionaries.push({ ns, dictionaries }); return () => {} },
    bind: () => () => undefined,
  },
}

// --- run it ------------------------------------------------------------------
const code = readFileSync(CLIENT, 'utf8')
let loadError
try {
  new Function('window', 'document', 'fetch', code)(globalThis.window, globalThis.document, () => { throw new Error('no network') })
} catch (error) {
  loadError = error
}
check('the bundle parses and loads', loadError === undefined, String(loadError))
// A false pass this suite once produced: if the module loader never ran, every
// later "does nothing" assertion would pass vacuously. Pin that it produced an API.
check('the bundle exports an API', typeof exported?.apply === 'function', String(typeof exported))

let applyError
try {
  exported?.apply?.(ctx)
} catch (error) {
  applyError = error
}
check('apply() does not throw', applyError === undefined, String(applyError))
check('registers the dictionaries', localeDictionaries.length === 1)

const actions = registrations.find((entry) => entry.options.name === 'conversation.chat.assistant-actions')
check('registers the action row', actions !== undefined)
check('registers nothing else', registrations.length === 1, String(registrations.map((entry) => entry.options.name)))

// `inject` is evaluated by the Harness per (entry × session); calling it here is
// what produces the face the component renders with.
const sessionId = 'session-abc'
const face = actions?.options.inject(sessionId)
check('the pencil receives an edit face', typeof face?.edit?.open === 'function', JSON.stringify(Object.keys(face ?? {})))
check('the pencil receives its Session', face?.sessionId === sessionId, String(face?.sessionId))
check('the pencil can reach the Chat snapshot', typeof face?.ui === 'function')

// --- the click reaches the editor, and edits in flow ------------------------
{
  const before = column.children.length
  face.edit.open({ messageId: 'm1', sessionId, text: 'original reply', row: stepRow })
  const editor = column.children.find((node) => node !== stepRow)
  check('an editor is inserted next to the row', editor !== undefined && column.children.length === before + 1)
  check('the edited row leaves the layout', stepRow.style.display === 'none', String(stepRow.style.display))
  check('the editor holds an editable area', editor?.querySelector('[data-msg-edit-area]') !== undefined)
  check('the draft starts from the source text', editor.querySelector('[data-msg-edit-area]')?.textContent === 'original reply')
  check('the editor is in the document flow', editor?.style.position === undefined, String(editor?.style.position))
  check('the editor has no viewport offset', editor?.style.top === undefined && editor?.style.left === undefined)
}

// --- cancelling restores the row --------------------------------------------
{
  face.edit.open({ messageId: 'm1', sessionId, text: 'original reply', row: stepRow })
  const editor = column.children.find((node) => node !== stepRow)
  const bar = editor.children.find((node) => node.tagName === 'DIV' && node !== editor.children[0])
  const buttons = bar.children.filter((node) => node.tagName === 'BUTTON')
  buttons[0]?.listeners.get('click')?.()
  check('cancelling restores the row', stepRow.style.display === '' || stepRow.style.display === undefined, String(stepRow.style.display))
  check('cancelling removes the editor', column.children.includes(editor) === false)
}

// --- only one editor at a time ----------------------------------------------
{
  face.edit.open({ messageId: 'm1', sessionId, text: 'first', row: stepRow })
  face.edit.open({ messageId: 'm1', sessionId, text: 'second', row: stepRow })
  const editors = column.children.filter((node) => node !== stepRow)
  check('opening twice leaves one editor', editors.length === 1, String(editors.length))
  const latest = editors[0]
  check('the latest draft wins', latest.querySelector('[data-msg-edit-area]')?.textContent === 'second')
}

// --- an unaddressable reply reports, and opens nothing ----------------------
{
  face.edit.open({ messageId: 'm1', sessionId, text: 'x', row: element() })
  const toasts = body.children.length
  check('a row without a parent reports instead of opening', column.children.filter((node) => node !== stepRow).length === 0)
  check('a report is raised', toasts > 0, String(toasts))
}

console.log(`\n${passed} checks passed, ${failures.length} failed`)
for (const failure of failures) console.log(`FAIL  ${failure}`)
process.exitCode = failures.length === 0 ? 0 : 1
