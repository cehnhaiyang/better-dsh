// 路由自检：验证 webServer 看门狗真的把 6 条路由注册上去了，以及重复 apply 不会撞车。
//
// 这里模拟的是真实 webServer 的两个关键行为：
//   · register() 遇到重复 (kind, path) 会 throw；
//   · 服务可能在 apply 之后才就绪（这里先给 undefined，再手动触发一次看门狗）。
//
// 跑法：node tools/routetest.mjs

const mod = await import('../lib/index.js')

let failed = 0
function check(label, ok, detail) {
  if (ok) { console.log('ok   ' + label); return }
  failed += 1
  console.log('FAIL ' + label + (detail === undefined ? '' : ' :: ' + detail))
}

/** 假 webServer：行为对齐 dsh-host-webserver（重复路径 throw，返回 disposer）。 */
function makeWebServer() {
  const exact = new Map()
  return {
    exact,
    register(route) {
      if (route.kind === 'exact') {
        if (exact.has(route.path)) throw new Error('webserver: duplicate exact route "' + route.path + '"')
        exact.set(route.path, route)
        return () => { exact.delete(route.path) }
      }
      throw new Error('unexpected kind ' + route.kind)
    },
  }
}

/** 假 timer：让看门狗可控（不真的起 interval）。 */
function makeTimer() {
  const timers = []
  return {
    timers,
    interval(fn, ms) {
      timers.push({ fn, ms })
      return () => {}
    },
  }
}

function makeCtx(web, timer) {
  const effects = []
  const ctx = {
    tools: { register: () => () => {} },
    commands: { register: () => () => {} },
    provide: () => {},
    get(name) {
      if (name === 'tools') return ctx.tools
      if (name === 'commands') return ctx.commands
      if (name === 'webServer') return web.value
      if (name === 'timer') return timer
      if (name === 'llm') return { stream: () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })() }
      return undefined
    },
    effect(fn, label) {
      effects.push({ fn, label })
      // 立刻执行一次（真实 fiber 激活也是这样），并留住 disposer。
      const dispose = fn()
      effects[effects.length - 1].dispose = dispose
      return () => {}
    },
    on: () => {},
  }
  return { ctx, effects }
}

// ── 1. webServer 未就绪时 apply 不炸，且看门狗在就绪后补齐路由 ──────────
const web = { value: undefined }
const timer = makeTimer()
const { ctx, effects } = makeCtx(web, timer)
mod.apply(ctx, {})
check('apply survives missing webServer', true)
check('watchdog interval registered', timer.timers.length === 1, 'got ' + timer.timers.length)
check('watchdog period = 10s', timer.timers[0] && timer.timers[0].ms === 10000, timer.timers[0] && timer.timers[0].ms)

web.value = makeWebServer()
timer.timers[0].fn()
const paths = [...web.value.exact.keys()]
check('routes registered after ready', paths.length === 6, 'got ' + paths.length + ': ' + paths.join(', '))
for (const expected of ['/api/forge/latest', '/api/forge/submit', '/api/forge/build', '/api/forge/run', '/api/forge/meta', '/api/forge/template']) {
  check('route ' + expected, web.value.exact.has(expected))
}

// ── 2. 再跑一轮看门狗不能撞车（重复注册会 throw）──────────────────────
let crashed = false
try { timer.timers[0].fn() } catch { crashed = true }
check('second sweep does not throw', crashed === false)
check('still 6 routes', web.value.exact.size === 6, 'got ' + web.value.exact.size)

// ── 3. dispose 只回收自己注册的，不误删别人的路由 ───────────────────────
// 先塞一条「别人的」路由，再 dispose 本插件。
const foreign = web.value.register({ kind: 'exact', path: '/api/someone-else/x', handler: () => {} })
const mainEffect = effects.find((e) => typeof e.dispose === 'function')
mainEffect.dispose()
check('dispose removes own routes', !web.value.exact.has('/api/forge/latest'))
check('dispose keeps foreign route', web.value.exact.has('/api/someone-else/x'))
foreign()

// ── 4. 路由 handler 形状 ────────────────────────────────────────────────
const web2 = { value: makeWebServer() }
const timer2 = makeTimer()
const { ctx: ctx2 } = makeCtx(web2, timer2)
mod.apply(ctx2, {})
const meta = web2.value.exact.get('/api/forge/meta')
check('meta route has handler', meta && typeof meta.handler === 'function')

/** 造一对假 req/res，跑一次 handler。 */
async function callRoute(route, { method = 'GET', url = '/', body = undefined } = {}) {
  const chunks = []
  const headers = new Map()
  const res = {
    statusCode: 200,
    setHeader: (k, v) => headers.set(k.toLowerCase(), v),
    end: (payload) => chunks.push(payload === undefined ? '' : String(payload)),
  }
  const req = {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body, 'utf8') },
  }
  await route.handler(req, res)
  const text = chunks.join('')
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.statusCode, json, text }
}

const metaRes = await callRoute(meta, { url: '/api/forge/meta' })
check('meta 200', metaRes.status === 200, String(metaRes.status))
check('meta has modes', metaRes.json && Array.isArray(metaRes.json.modes) && metaRes.json.modes.length === 3)
check('meta has templates', metaRes.json && Array.isArray(metaRes.json.templates) && metaRes.json.templates.length === 8)
check('meta defaultMode', metaRes.json && metaRes.json.defaultMode === 'augment', metaRes.json && metaRes.json.defaultMode)

const tpl = web2.value.exact.get('/api/forge/template')
const tplOk = await callRoute(tpl, { url: '/api/forge/template?id=debug' })
check('template 200', tplOk.status === 200, String(tplOk.status))
check('template id echoed', tplOk.json && tplOk.json.template && tplOk.json.template.id === 'debug')
const tplMiss = await callRoute(tpl, { url: '/api/forge/template?id=nope' })
check('template unknown → 404', tplMiss.status === 404, String(tplMiss.status))

const build = web2.value.exact.get('/api/forge/build')
const built = await callRoute(build, { method: 'POST', url: '/api/forge/build', body: JSON.stringify({ template: 'debug', fields: { goal: '定位这个 bug' } }) })
check('build 200', built.status === 200, String(built.status))
check('build has prompt', built.json && typeof built.json.prompt === 'string' && built.json.prompt.startsWith('# 身份'))
check('build template echoed', built.json && built.json.template === 'debug')
check('build field overridden', built.json && built.json.prompt.includes('定位这个 bug'))
const buildGet = await callRoute(build, { method: 'GET', url: '/api/forge/build' })
check('build GET → 405', buildGet.status === 405, String(buildGet.status))

const latest = web2.value.exact.get('/api/forge/latest')
const latestRes = await callRoute(latest, { url: '/api/forge/latest?since=0' })
check('latest 200', latestRes.status === 200, String(latestRes.status))
check('latest has seq', latestRes.json && typeof latestRes.json.seq === 'number')

const submit = web2.value.exact.get('/api/forge/submit')
const submitGet = await callRoute(submit, { method: 'GET', url: '/api/forge/submit' })
check('submit GET → 405', submitGet.status === 405, String(submitGet.status))

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
