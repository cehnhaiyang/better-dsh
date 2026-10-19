// 客户端 bundle 自检：用假的 __ModuleLoader__ / React / 插槽跑一遍 apply()。
//
// 这个测试卡的是「装配期」的契约，不是渲染结果：
//   · bundle 必须按 window.__ModuleLoader__.load({ id, factory }) 形式注册；
//   · 注册的 id 必须等于 package.json 的 name（否则 client-modules 判「loaded
//     without registering」，界面上什么都不出现，控制台只有一行警告）；
//   · factory 返回的插件体必须有 apply + inject，且 inject 里带 slots；
//   · apply 必须真的往 conversation.input.right 注册了一个条目。
//
// 跑法：node tools/clienttest.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))
const BUNDLE = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')

let failed = 0
function check(label, ok, detail) {
  if (ok) { console.log('ok   ' + label); return }
  failed += 1
  console.log('FAIL ' + label + (detail === undefined ? '' : ' :: ' + detail))
}

// ── 假的 React：只要够组件定义与 createElement 用 ──────────────────────
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}
const ReactDOM = { createPortal: (node) => node }

// ── 假 primitives：useAnchoredPosition / useDismissOnOutsidePointer / MenuSurface ──
const primitives = {
  useAnchoredPosition: () => ({ left: 0, top: 0 }),
  useDismissOnOutsidePointer: () => {},
  MenuSurface: 'MenuSurface',
  IconClockOutlineRegular: 'IconClockOutlineRegular',
}

// ── 假 __ModuleLoader__ ─────────────────────────────────────────────────
const loaded = []
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => { loaded.push({ id, factory }) },
  },
}

// bundle 是 CommonJS 风格的 IIFE，直接求值即可（它自己调用 window.__ModuleLoader__）。
// eslint-disable-next-line no-new-func
new Function('require', BUNDLE)((name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return ReactDOM
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error('unexpected require: ' + name)
})

// ── 1. 装配契约 ─────────────────────────────────────────────────────────
check('bundle calls __ModuleLoader__.load once', loaded.length === 1, 'got ' + loaded.length)
const entry = loaded[0]
check('bundle id present', entry && typeof entry.id === 'string' && entry.id !== '')
check('bundle id === package name', entry && entry.id === PKG.name, (entry && entry.id) + ' vs ' + PKG.name)
check('package exports ./client points at this file', PKG.exports && PKG.exports['./client'] === './lib/client.js')
check('package declares web platform', PKG.dsh && PKG.dsh.client && PKG.dsh.client.platform === 'web')
check('package injects locale', PKG.dsh && Array.isArray(PKG.dsh.client.inject) && PKG.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
check('package injects ui-conversation', PKG.dsh && PKG.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
check('package injects ui-primitives', PKG.dsh && PKG.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-primitives'))

// ── 2. factory 返回的插件体 ─────────────────────────────────────────────
const plugin = entry.factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return ReactDOM
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error('unexpected require: ' + name)
})
check('plugin has name', plugin && typeof plugin.name === 'string' && plugin.name !== '')
check('plugin has apply', plugin && typeof plugin.apply === 'function')
check('plugin inject has slots', plugin && Array.isArray(plugin.inject) && plugin.inject.includes('slots'))
check('plugin inject has locale', plugin && Array.isArray(plugin.inject) && plugin.inject.includes('locale'))

// ── 3. apply() 往正确的槽位注册 ─────────────────────────────────────────
const slots = []
const effects = []
const ctx = {
  slots: {
    inject: (name, factory) => { slots.push({ name, factory }); factory() },
    register: (meta, component) => { slots.push({ registered: meta, component }); return () => {} },
  },
  locale: { register: () => () => {} },
  effect: (fn, label) => { effects.push({ label, fn }); return () => {} },
}
plugin.apply(ctx)

const injections = slots.filter((s) => s.name !== undefined)
check('injects conversation.input.right', injections.some((s) => s.name === 'conversation.input.right'), JSON.stringify(injections.map((s) => s.name)))
const registrations = slots.filter((s) => s.registered !== undefined)
check('registers exactly one slot entry', registrations.length === 1, 'got ' + registrations.length)
const reg = registrations[0]
check('registered slot = conversation.input.right', reg && reg.registered.name === 'conversation.input.right', reg && reg.registered.name)
check('registered id = prompt-forge', reg && reg.registered.id === 'prompt-forge', reg && reg.registered.id)
check('registered order is a number', reg && typeof reg.registered.order === 'number')
check('registered locale = prompt-forge', reg && reg.registered.locale === 'prompt-forge', reg && reg.registered.locale)
check('registered a component', reg && typeof reg.component === 'function')

// ── 4. 样式与文案的 effect 都装上了 ─────────────────────────────────────
check('two effects registered', effects.length === 2, 'got ' + effects.length)
check('dictionaries effect', effects.some((e) => String(e.label).includes('dictionaries')))
check('styles effect', effects.some((e) => String(e.label).includes('styles')))

// 样式 effect 真的往 head 塞了 <style>，且 CSS 覆盖了面板定位这条命门。
const styleEffect = effects.find((e) => String(e.label).includes('styles'))
const appended = []
globalThis.document = {
  head: { appendChild: (el) => appended.push(el) },
  createElement: () => ({ dataset: {}, textContent: '' }),
  body: {},
}
styleEffect.fn()
check('style tag appended', appended.length === 1, 'got ' + appended.length)
const css = appended[0] && appended[0].textContent
check('css has panel position fixed', typeof css === 'string' && /\.dshForge_panel\{[^}]*position:fixed/.test(css))
check('css has trigger class', typeof css === 'string' && css.includes('.dshForge_trigger{'))
check('css uses theme tokens', typeof css === 'string' && css.includes('var(--dsw-alias-'))

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
