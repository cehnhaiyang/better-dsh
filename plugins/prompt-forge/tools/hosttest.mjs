// 宿主半边的契约自检：用一个假的 ctx 跑 apply()，核对它到底注册了什么。
//
// 这个测试存在的理由：插件加载失败在 DSH 里是**静默**的（ESM 报错不冒泡到部署脚本，
// fiber 停在未激活），唯一能在重启前发现问题的地方就是这里。
//
// 跑法：node tools/hosttest.mjs

const registered = {
  tools: [],
  commands: [],
  provides: [],
  routes: [],
  effects: [],
  listeners: [],
}

function makeCtx() {
  const ctx = {
    // dsh-tools 的 register 接受裸 JSON Schema 定义（tools.js 也这么用）。
    tools: { register: (def) => { registered.tools.push(def); return () => {} } },
    commands: { register: (def) => { registered.commands.push(def); return () => {} } },
    provide: (name, value) => { registered.provides.push({ name, value }) },
    get: (name) => {
      if (name === 'tools') return ctx.tools
      if (name === 'commands') return ctx.commands
      // llm 故意给一个能流式返回的假实现，让 runForge 能真的跑通一次。
      if (name === 'llm') return ctx.__llm
      return undefined
    },
    effect: (fn) => { registered.effects.push(fn) },
    on: (...args) => { registered.listeners.push(args) },
    __llm: undefined,
    __web: undefined,
  }
  // effect 立刻执行一次（模拟 fiber 激活），返回的 disposer 留着。
  ctx.effect = (fn, label) => {
    registered.effects.push({ label, run: fn })
    return () => {}
  }
  return ctx
}

/** 假 llm：按 chunk 协议吐一段文本。 */
function makeFakeLlm(output) {
  return {
    stream(options) {
      // 记录调用参数，供断言使用。
      makeFakeLlm.lastOptions = options
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: output }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

const mod = await import('../lib/index.js')

let failed = 0
function check(label, ok, detail) {
  if (ok) { console.log('ok   ' + label); return }
  failed += 1
  console.log('FAIL ' + label + (detail === undefined ? '' : ' :: ' + detail))
}

// ── 1. 模块导出契约 ──────────────────────────────────────────────────────
check('exports name', typeof mod.name === 'string' && mod.name !== '')
check('exports apply', typeof mod.apply === 'function')
check('inject has tools', Array.isArray(mod.inject) && mod.inject.includes('tools'))
check('inject has commands', Array.isArray(mod.inject) && mod.inject.includes('commands'))
check('inject has llm', Array.isArray(mod.inject) && mod.inject.includes('llm'))

// ── 2. apply() 注册清单 ──────────────────────────────────────────────────
const ctx = makeCtx()
ctx.__llm = makeFakeLlm('请编写一个快速排序算法，接受整数数组，返回升序结果。')
mod.apply(ctx, {})

check('registers 1 tool', registered.tools.length === 1, 'got ' + registered.tools.length)
const tool = registered.tools[0]
check('tool name = forge_prompt', tool && tool.name === 'forge_prompt', tool && tool.name)
check('tool has parameters', tool && typeof tool.parameters === 'object')
check('tool parameters require draft', tool && Array.isArray(tool.parameters.required) && tool.parameters.required.includes('draft'))
check('tool has output schema', tool && tool.output && tool.output.schema && tool.output.schema.type === 'object')
check('tool has execute', tool && typeof tool.execute === 'function')
check('tool has presentCall', tool && typeof tool.presentCall === 'function')

check('registers 1 command', registered.commands.length === 1, 'got ' + registered.commands.length)
const command = registered.commands[0]
check('command name = forge', command && command.name === 'forge', command && command.name)
check('command has handler', command && typeof command.handler === 'function')

check('provides promptForge', registered.provides.some((p) => p.name === 'promptForge'))
const service = registered.provides.find((p) => p.name === 'promptForge')
check('service has forge()', service && typeof service.value.forge === 'function')
check('service has build()', service && typeof service.value.build === 'function')
check('service build renders', service && service.value.build({ role: 'R', goal: 'G' }) === '# 身份\nR\n\n# 目标\nG')

// ── 3. 工具 execute 端到端（假 llm）─────────────────────────────────────
const value = await tool.execute({ draft: '帮我写个快排', mode: 'rewrite' }, { agent: undefined, signal: new AbortController().signal })
check('tool returns prompt', value && typeof value.prompt === 'string' && value.prompt.includes('快速排序'), value && value.prompt)
check('tool returns mode', value && value.mode === 'rewrite', value && value.mode)

// system 里必须同时有底座与纪律，且强度段落正确
const sent = makeFakeLlm.lastOptions
check('llm got system', sent && typeof sent.system === 'string')
check('system has discipline', sent && sent.system.includes('输出纪律'))
check('system has rewrite section', sent && sent.system.includes('本次强度：重述'))
check('system has no structure section', sent && !sent.system.includes('本次强度：结构化'))
check('llm temperature = 0.3', sent && sent.temperature === 0.3)
check('llm has maxTokens', sent && typeof sent.maxTokens === 'number')
check('user message wraps draft', sent && sent.messages[0].content[0].text.includes('"""'))

// ── 4. structure 强度的 system 段落 ─────────────────────────────────────
ctx.__llm = makeFakeLlm('# 身份\n执行者\n\n# 目标\n完成任务')
const value2 = await tool.execute({ draft: '做个登录页', mode: 'structure' }, { agent: undefined, signal: new AbortController().signal })
check('structure returns prompt', value2 && value2.prompt.includes('# 身份'), value2 && value2.prompt)
check('structure system has section', makeFakeLlm.lastOptions.system.includes('本次强度：结构化'))
check('structure system lists seven sections', makeFakeLlm.lastOptions.system.includes('# 数据不足时'))

// ── 5. 命令 handler：成功 / 用法错误 / 迭代 ─────────────────────────────
ctx.__llm = makeFakeLlm('请编写一个排序算法。')
const ok = await command.handler({ rawInput: '--rewrite 帮我写个排序', agent: undefined })
check('command success kind', ok && ok.kind === 'success', ok && ok.kind)
check('command success text', ok && ok.text.includes('排序'), ok && ok.text)

const usage = await command.handler({ rawInput: '   ', agent: undefined })
check('command empty → error', usage && usage.kind === 'error', usage && usage.kind)

// 会话级迭代：先跑一次拿历史，再 revise
const fakeAgent = { session: { id: 'sess-1', events: [] } }
ctx.__llm = makeFakeLlm('第一版提示词。')
await command.handler({ rawInput: '--rewrite 原始需求', agent: fakeAgent })
ctx.__llm = makeFakeLlm('第二版提示词。')
const revised = await command.handler({ rawInput: 'revise 再简洁一点', agent: fakeAgent })
check('command revise works', revised && revised.kind === 'success' && revised.text.includes('第二版'), revised && revised.text)
check('revise passed previous', makeFakeLlm.lastOptions.messages[0].content[0].text.includes('第一版提示词'))

// ── 6. 模型报错要变成可读文案，不是崩栈 ─────────────────────────────────
ctx.__llm = {
  stream() {
    return (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_CREDENTIAL', message: 'bad key' } } }
    })()
  },
}
let threw = false
try { await tool.execute({ draft: 'x', mode: 'rewrite' }, { agent: undefined, signal: new AbortController().signal }) } catch (error) {
  threw = true
  check('llm error surfaces message', String(error.message).includes('bad key'), error.message)
}
check('llm error throws (tool contract)', threw)

// ── 7. 空输出要报错，不能返回空串 ───────────────────────────────────────
ctx.__llm = makeFakeLlm('')
threw = false
try { await tool.execute({ draft: 'x', mode: 'rewrite' }, { agent: undefined, signal: new AbortController().signal }) } catch { threw = true }
check('empty output throws', threw)

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
