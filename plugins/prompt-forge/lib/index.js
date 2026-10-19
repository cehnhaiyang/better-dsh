// prompt-forge 宿主半边。
//
// 三条入口共用一份内核（lib/prompt.js 渲染 + lib/forge-prompts.js 提示词）：
//
//   ① /forge 命令          人在会话里触发，结果回聊天流
//   ② forge_prompt 工具    模型判断「用户在求改写提示词」时自动调用
//   ③ /api/forge/* 路由    客户端按钮与面板（自动填入输入框）
//
// 设计要点（逐条对应踩过的坑）：
//
// · **零 @deepseek-ai 依赖**。本文件位于 ~/.dsh/plugins/，不在任何 node_modules 链上，
//   Node 的 require 向上查找到不了 harness 的 node_modules。上游三个插件全部遵守这条，
//   这里也一样：只用 Node 内置能力 + ctx 注入的服务。
//
// · **模型调用走 ctx.llm**（复用主对话路由），不自己读 API Key。这是零密钥的关键：
//   用户配过哪个模型就用哪个，插件不引入第二套凭据。
//
// · **路由注册必须容错重试**。boot 早期 webServer 可能尚未就绪，把注册锁死在
//   if (web) 里会让路由永久缺失且不报错（上游 prompt-optimizer 的两次事故）。
//   这里的看门狗每轮重新解析服务，就绪即注册，并用 owned Map 记住自己持有了哪些，
//   fiber 停止时只回收自己注册的。
//
// · **注册撞车要自愈**。register() 遇到重复路径会 throw；落败方若按路径无条件删表，
//   会产生「命令活着但 HTTP 全 404」。这里只在「表里确实没有该路径」时才注册，
//   清理也只清自己 Map 里的条目。

import { join, dirname } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import {
  buildPrompt, buildSections, completeForm, narrowArgs, prefer,
  applyFormatChoice, splitCallableTools, isProvidedList, cleanOutput,
  createEmptyForm, parseFormDocument, serializeForm, validateForm,
  FORM_DOCUMENT_VERSION,
} from './prompt.js'
import { TEMPLATES, TEMPLATE_IDS, findTemplate } from './templates.js'
import { MODES, MODE_LABELS, buildSystem, buildUser } from './forge-prompts.js'

export const name = 'prompt-forge'
export const inject = ['tools', 'commands', 'llm']

/** 配置默认值。 */
const DEFAULTS = {
  /** 改写强度默认值：rewrite / augment / structure。 */
  mode: 'augment',
  /** 单次调用超时（毫秒）。 */
  timeoutMs: 90000,
  /** 输出 token 上限。带思考的模型思考过程也吃这个预算，给足。 */
  maxTokens: 8000,
  /** 输入草稿字符上限。 */
  maxInputChars: 6000,
  /** 结果是否自动填入输入框（客户端轮询消费）。 */
  autoFill: true,
  /** 上下文感知：auto = 仅指代不明/输入过短时读本会话最近消息；true = 总是；false = 从不。 */
  contextAware: 'auto',
  /** 自动读取的会话上下文长度上限（字符）。 */
  contextMaxChars: 1800,
  /** 提示词库上游（供面板检索）。 */
  libraryBaseUrl: 'https://prompts.chat',
}

/** 指代不明的信号词：命中才去读会话上文。 */
const CONTEXT_HINT = /(这个|这些|那个|那篇|那份|它|上面|刚才|刚刚|继续|这条|这篇|之前|前面|咱们|我们)/

/**
 * 判断是否需要会话上下文。
 *
 * 自包含的需求（「帮我写个快排」）不附加任何东西，零增量 token；只有指代不明或
 * 短到无法判断意图时才去读——这正是「上下文感知」的成本闸门。
 */
function wantsContext(text) {
  return text.length < 40 || CONTEXT_HINT.test(text)
}

/**
 * 读会话最近若干条 user/assistant 文本，组成锚定摘要。
 *
 * 只取叶子字段、从尾部反向遍历：DSH 日志可能上百万条，正序遍历会在长会话里卡住。
 * @param {object} agent - 会话 agent。
 * @param {number} maxChars - 长度上限。
 * @returns {string} 摘要文本；无可用消息时为空串。
 */
function extractDigest(agent, maxChars) {
  const events = agent && agent.session && Array.isArray(agent.session.events) ? agent.session.events : null
  if (!events || events.length === 0) return ''
  const picks = []
  const floor = Math.max(0, events.length - 3000)
  for (let i = events.length - 1; i >= floor && picks.length < 8; i--) {
    const e = events[i]
    const type = String((e && e.type) || '')
    if (type !== 'user/message' && type !== 'assistant/message') continue
    const msg = e.data && e.data.message ? e.data.message : e.data
    const blocks = msg && Array.isArray(msg.content) ? msg.content : null
    if (!blocks) continue
    let text = ''
    for (const b of blocks) {
      if (b && b.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text
    }
    text = text.replace(/\s+/g, ' ').trim().slice(0, 220)
    if (!text) continue
    picks.push((type === 'user/message' ? '用户：' : '助手：') + text)
  }
  return picks.reverse().join('\n').slice(-Math.max(200, Number(maxChars) || 1800))
}

/**
 * 单次非流式补全（聚合流式 chunk）。
 *
 * 参照 @deepseek-ai/dsh-session-title-llm 的调用形态：自己 push 每个 chunk，
 * 最后看 finish.kind 决定成功还是抛错。不 import BlockAssembler 是因为
 * 本文件零依赖——这里手写等价逻辑，只取 text 块。
 *
 * @param {object} llm - ctx.llm。
 * @param {object|null} route - {provider, model}；null 表示用服务默认解析。
 * @param {string} system - system 文本。
 * @param {string} user - 用户消息。
 * @param {AbortSignal} signal - 取消信号。
 * @param {object} options - maxTokens 与 mode。
 * @returns {Promise<string>} 模型输出的纯文本。
 */
async function callLlm(llm, route, system, user, signal, options) {
  const call = {
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    system,
    maxTokens: options.maxTokens,
    signal,
  }
  // 确定性任务压低温度；带 reasoningEffort 的链节由 effort 控制，不再传 temperature。
  if (route && route.reasoningEffort) call.reasoningEffort = route.reasoningEffort
  else call.temperature = 0.3
  if (route && route.provider && route.model) {
    call.provider = route.provider
    call.model = route.model
  }

  let text = ''
  const blockTexts = []
  let finish
  for await (const chunk of llm.stream(call)) {
    if (signal.aborted) break
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') blockTexts.push(chunk.block.text)
    else if (chunk.type === 'finish') { finish = chunk.reason; break }
  }
  signal.throwIfAborted()

  if (finish === undefined) {
    // 部分网关对极短请求直接结束流不发 finish —— 收到过文本即视为成功。
    if (text !== '' || blockTexts.length > 0) return text !== '' ? text : blockTexts.join('')
    throw new Error('模型未返回任何内容')
  }
  if (finish.kind === 'stop') return text !== '' ? text : blockTexts.join('')
  if (finish.kind === 'max-tokens') return text !== '' ? text : blockTexts.join('')
  const failure = finish.failure || {}
  const error = new Error(failure.message || ('模型返回终止状态 "' + String(finish.kind) + '"'))
  if (failure.code) error.code = failure.code
  throw error
}

/**
 * 把模型输出收成结构化结果。
 *
 * structure 强度下模型可能带 `# 板块` 标题，此时直接按原样返回（模型已经按板块写了）；
 * 其它强度返回清洗后的纯文本。
 */
function shapeResult(raw, mode, originalText) {
  const cleaned = cleanOutput(raw, originalText)
  if (cleaned === '') throw new Error('模型输出为空')
  return cleaned
}

/** 插件体。 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }

  /** 每会话的迭代历史：sessionId -> [{ raw, optimized, mode }]。 */
  const history = new Map()
  /** 客户端草稿态的历史（无会话时按草稿 key 记账）。 */
  const pendingClarify = new Map()

  /**
   * 投递队列：客户端轮询取走最近一次结果。
   *
   * seq 递增即新结果。持久化到 ~/.dsh/prompt-forge/delivery.json，使页面刷新后
   * 5 分钟内的新结果仍能补填 —— 上游 prompt-optimizer 靠这个解决了「刷新就丢」。
   */
  let delivery = { seq: 0, kind: 'fill', text: '', full: '', ts: 0 }
  let deliveryFile = null
  try {
    // dshHomePath 是 @deepseek-ai/dsh-home-paths 导出的**函数**，不是注册的服务，
    // 所以 ctx.get('dshHomePath') 永远拿不到它。这里按它的同一套规则自己算：
    // DSH_HOME 优先，否则 ~/.dsh。
    const home = process.env.DSH_HOME
      || String(process.env.USERPROFILE || process.env.HOME || '') + '/.dsh'
    if (home !== '' && home !== '/.dsh') {
      deliveryFile = join(home, 'prompt-forge', 'delivery.json')
    }
  } catch { deliveryFile = null }

  /** 读取当前默认路由。 */
  function resolveRoute() {
    try {
      const sel = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (sel && sel.provider && sel.model) {
        const route = { provider: sel.provider, model: sel.model }
        if (sel.reasoningEffort) route.reasoningEffort = sel.reasoningEffort
        return route
      }
    } catch { /* 服务缺失时走默认解析 */ }
    return null
  }

  /**
   * 核心管线：草稿 → 模型 → 清洗后的提示词。
   *
   * @param {object} input - { text, mode, digest, previous, feedback, sessionId }。
   * @returns {Promise<{ok: boolean, text: string, mode: string, raw?: string}>} 结果。
   */
  async function runForge(input) {
    const raw = String(input.text ?? '').trim()
    const mode = MODES.includes(input.mode) ? input.mode : cfg.mode
    if (raw === '') return { ok: false, text: '用法：/forge [--rewrite|--augment|--structure] <你的草稿>', mode }
    if (raw.length > cfg.maxInputChars) {
      return { ok: false, text: `草稿过长（${raw.length} 字符 > 上限 ${cfg.maxInputChars}），请精简或分段后重试。`, mode }
    }

    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') {
      return { ok: false, text: '当前 profile 没有 llm 服务，无法改写。请确认模型已在设置里配置。', mode }
    }

    const signal = AbortSignal.timeout(cfg.timeoutMs)
    let output
    try {
      output = await callLlm(llm, resolveRoute(), buildSystem(mode), buildUser(raw, {
        digest: input.digest,
        previous: input.previous,
        feedback: input.feedback,
      }), signal, { maxTokens: cfg.maxTokens, mode })
    } catch (error) {
      const message = signal.aborted
        ? `改写超时（${cfg.timeoutMs}ms），请稍后重试或换更快的模型。`
        : `改写失败：${(error && error.message) || String(error)}`
      return { ok: false, text: message, mode }
    }

    let result
    try {
      result = shapeResult(output, mode, raw)
    } catch (error) {
      return { ok: false, text: '改写失败：' + ((error && error.message) || String(error)), mode }
    }
    return { ok: true, text: result, mode, raw: output }
  }

  /** 投递一条结果给客户端（seq 递增，客户端按水位消费）。 */
  function arm(kind, text, full) {
    delivery = { seq: delivery.seq + 1, kind, text: String(text || ''), full: String(full || ''), ts: Date.now() }
    if (deliveryFile !== null) {
      void (async () => {
        try {
          await mkdir(dirname(deliveryFile), { recursive: true })
          await writeFile(deliveryFile, JSON.stringify(delivery), 'utf8')
        } catch { /* 持久化失败不影响主流程 */ }
      })()
    }
    return delivery
  }

  // ── 通道 ②：forge_prompt 工具 ────────────────────────────────────────────
  ctx.tools.register({
    name: 'forge_prompt',
    description:
      '把用户口语化、非结构化的草稿改写成高质量提示词。三种强度：'
      + 'rewrite（只重述+明确化，最保守）、augment（保守补充缺失的大逻辑）、'
      + 'structure（产出七段结构化提示词）。'
      + '当用户说「帮我把这段改写成提示词」「把这个 prompt 结构化」「优化一下这个需求」时调用。'
      + '输出是可直接使用的提示词本体，不含解释。',
    parameters: {
      type: 'object',
      properties: {
        draft: { type: 'string', description: '用户原始草稿，完整粘贴、不要先行改写' },
        mode: {
          type: 'string',
          enum: MODES,
          description: '改写强度：rewrite=只重述 / augment=保守增量（默认） / structure=七段结构化',
        },
        digest: { type: 'string', description: '可选：与本次改写相关的对话上文摘要' },
        feedback: { type: 'string', description: '可选：用户对上一版结果的修改意见（迭代模式）' },
      },
      required: ['draft'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string' },
          mode: { type: 'string' },
        },
        required: ['prompt', 'mode'],
      },
      render: (_args, value) => [{ type: 'text', text: value.prompt }],
    },
    async execute(args, exec) {
      const result = await runForge({
        text: args.draft,
        mode: args.mode,
        digest: args.digest,
        feedback: args.feedback,
        sessionId: exec && exec.agent && exec.agent.session ? exec.agent.session.id : undefined,
      })
      if (!result.ok) throw new Error(result.text)
      return { prompt: result.text, mode: result.mode }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '改写提示词',
      kind: 'other',
      rawInput: String((args && args.draft) || '').slice(0, 60),
    }),
  })

  // ── 通道 ①：/forge 命令 ─────────────────────────────────────────────────
  /**
   * 解析命令行参数。
   *
   * 支持 --rewrite / --augment / --structure 指定强度，--fresh 强制换话题，
   * revise <意见> 进入迭代模式。
   */
  function parseCommand(rawLine) {
    let input = String(rawLine ?? '').trim()
    let mode
    for (const candidate of MODES) {
      const re = new RegExp('(?:^|\\s)--?' + candidate + '(?:\\s|$)', 'i')
      if (re.test(input)) {
        mode = candidate
        input = input.replace(re, ' ').trim()
        break
      }
    }
    let fresh = false
    if (/(?:^|\s)--?fresh(?:\s|$)/i.test(input)) {
      fresh = true
      input = input.replace(/\s*--?fresh\s*/gi, ' ').trim()
    }
    if (!input) return null
    const revise = /^revise\s+([\s\S]+)$/i.exec(input)
    return revise
      ? { mode, fresh, feedback: revise[1].trim() }
      : { mode, fresh, text: input }
  }

  ctx.commands.register({
    name: 'forge',
    description: '把口语化草稿改写成高质量提示词（--rewrite 只重述 / --augment 保守增量 / --structure 七段结构化；revise <意见> 迭代）',
    input: { hint: '[--rewrite|--augment|--structure] <草稿> | revise <修改意见>' },
    async handler(invocation) {
      const parsed = parseCommand(invocation && invocation.rawInput)
      if (parsed === null) {
        return {
          kind: 'error',
          text: '用法：/forge <你的草稿>；加 --structure 产出七段结构化提示词；/forge revise <修改意见> 迭代上一版。',
        }
      }
      const sessionId = invocation && invocation.agent && invocation.agent.session
        ? invocation.agent.session.id
        : undefined
      const stack = sessionId ? (history.get(sessionId) ?? []) : []
      const prev = stack.length > 0 ? stack[stack.length - 1] : null

      if (parsed.feedback !== undefined && prev === null) {
        return { kind: 'error', text: '迭代模式没有可修订的上一版结果，请先执行 /forge <草稿>。' }
      }

      const text = parsed.feedback !== undefined ? prev.raw : parsed.text
      // 上下文感知：只有指代不明或输入过短才读会话上文，自包含需求零增量。
      let digest
      const contextOn = cfg.contextAware === true || (cfg.contextAware === 'auto' && wantsContext(text))
      if (contextOn && invocation && invocation.agent) {
        digest = extractDigest(invocation.agent, Number(cfg.contextMaxChars) || 1800)
      }

      const result = await runForge({
        text,
        mode: parsed.mode || (prev && parsed.feedback !== undefined ? prev.mode : cfg.mode),
        digest,
        previous: parsed.feedback !== undefined ? prev.optimized : undefined,
        feedback: parsed.feedback,
        sessionId,
      })
      if (!result.ok) return { kind: 'error', text: result.text }

      if (sessionId) {
        const next = [...stack, { raw: text, optimized: result.text, mode: result.mode }].slice(-5)
        history.set(sessionId, next)
      }
      if (cfg.autoFill === true) arm('fill', result.text, result.text)
      return { kind: 'success', text: result.text }
    },
  })

  // ── 通道 ③：客户端路由（轮询取结果 / 提交 / 模板库 / 表单文档）─────────
  const routeDefs = [
    {
      kind: 'exact',
      path: '/api/forge/latest',
      handler: async (req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        const url = new URL(req.url ?? '/', 'http://x')
        const since = Number(url.searchParams.get('since')) || 0
        const fresh = delivery.text !== '' && delivery.seq > since
        res.end(JSON.stringify({
          ok: true,
          autoFill: cfg.autoFill === true,
          seq: delivery.seq,
          kind: delivery.kind,
          ts: delivery.ts,
          text: fresh ? delivery.text : '',
          full: fresh ? delivery.full : '',
        }))
      },
    },
    {
      kind: 'exact',
      path: '/api/forge/submit',
      handler: async (req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        if (String(req.method || 'GET').toUpperCase() !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'POST only' }))
          return
        }
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 64 * 1024) {
            res.statusCode = 413
            res.end(JSON.stringify({ ok: false, error: 'body too large' }))
            return
          }
        }
        let payload
        try { payload = JSON.parse(body || '{}') } catch {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }))
          return
        }
        const parsed = parseCommand(payload.line)
        if (parsed === null) {
          res.end(JSON.stringify({ ok: false, error: 'usage' }))
          return
        }
        // 后台跑，立刻回执：慢 handler 会卡住客户端提交链路（上游实测踩过）。
        void runForge({
          text: parsed.feedback !== undefined ? '' : parsed.text,
          mode: parsed.mode || cfg.mode,
          feedback: parsed.feedback,
        }).then((result) => {
          arm(result.ok ? 'fill' : 'error', result.text, result.text)
        }).catch((error) => {
          arm('error', '改写失败：' + ((error && error.message) || String(error)), '')
        })
        res.end(JSON.stringify({ ok: true, seq: delivery.seq }))
      },
    },
    {
      kind: 'exact',
      path: '/api/forge/build',
      handler: async (req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        if (String(req.method || 'GET').toUpperCase() !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'POST only' }))
          return
        }
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 128 * 1024) {
            res.statusCode = 413
            res.end(JSON.stringify({ ok: false, error: 'body too large' }))
            return
          }
        }
        let payload
        try { payload = JSON.parse(body || '{}') } catch {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }))
          return
        }
        // 本地纯构建：不起模型、不花钱。模板字段垫底，面板里的编辑覆盖它。
        const base = findTemplate(String(payload.template || ''))
        const form = completeForm(base === undefined ? {} : base.fields)
        for (const [key, value] of Object.entries(payload.fields || {})) {
          if (Object.hasOwn(form, key) && value !== undefined) form[key] = value
        }
        const prompt = buildPrompt(form)
        res.end(JSON.stringify({
          ok: true,
          prompt,
          missing: validateForm(form),
          template: base === undefined ? '' : base.id,
        }))
      },
    },
    {
      kind: 'exact',
      path: '/api/forge/run',
      handler: async (req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        if (String(req.method || 'GET').toUpperCase() !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'POST only' }))
          return
        }
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 64 * 1024) {
            res.statusCode = 413
            res.end(JSON.stringify({ ok: false, error: 'body too large' }))
            return
          }
        }
        let payload
        try { payload = JSON.parse(body || '{}') } catch {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }))
          return
        }
        // 模板作为「底座」参与改写：把模板字段渲染成提示词，作为参考材料交给模型。
        // 只有 structure 强度下有意义 —— 其它强度是「重述/增量」，塞一份七段底座
        // 会把模型往结构化方向拽，反而违反「不扩展信息」的约束。
        let digest = payload.digest
        const templateId = String(payload.template || '')
        if (templateId !== '' && (payload.mode === 'structure' || (payload.mode === undefined && cfg.mode === 'structure'))) {
          const base = findTemplate(templateId)
          if (base !== undefined) {
            const seed = buildPrompt(completeForm(base.fields))
            digest = (typeof digest === 'string' && digest !== '' ? digest + '\n\n' : '')
              + '【模板底座（沿用其板块与字段，但按本次草稿重写内容）】\n' + seed
          }
        }
        // 同步等结果：面板要立刻显示，不像 /submit 那样后台跑。
        // 超时由 cfg.timeoutMs 兜住，不会无限挂。
        const result = await runForge({
          text: payload.text,
          mode: payload.mode,
          digest,
          previous: payload.previous,
          feedback: payload.feedback,
        })
        if (result.ok && cfg.autoFill === true) arm('fill', result.text, result.text)
        else if (!result.ok) arm('error', result.text, '')
        res.end(JSON.stringify({ ok: result.ok, text: result.text, mode: result.mode }))
      },
    },
    {
      kind: 'exact',
      path: '/api/forge/meta',
      handler: async (req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({
          ok: true,
          modes: MODES.map((id) => ({ id, label: MODE_LABELS[id] })),
          defaultMode: cfg.mode,
          templates: TEMPLATES.map((t) => ({ id: t.id, label: t.label, whenToUse: t.whenToUse })),
          formVersion: FORM_DOCUMENT_VERSION,
          autoFill: cfg.autoFill === true,
        }))
      },
    },
    {
      kind: 'exact',
      path: '/api/forge/template',
      handler: async (req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        const url = new URL(req.url ?? '/', 'http://x')
        const id = String(url.searchParams.get('id') || '')
        const template = findTemplate(id)
        if (template === undefined) {
          res.statusCode = 404
          res.end(JSON.stringify({ ok: false, error: 'unknown template: ' + id }))
          return
        }
        res.end(JSON.stringify({ ok: true, template }))
      },
    },
  ]

  const owned = new Map()
  let sweeps = 0
  let lastError = ''

  const ensureWeb = () => {
    sweeps += 1
    const web = ctx.get('webServer')
    if (!web) { lastError = 'sweep#' + sweeps + ' webServer 未就绪'; return }
    const report = []
    for (const def of routeDefs) {
      const short = def.path.split('/').pop()
      const hasMap = !!(web.exact && typeof web.exact.has === 'function')
      if (hasMap ? web.exact.has(def.path) : owned.has(def.path)) continue
      try {
        owned.set(def.path, web.register(def))
        report.push('+' + short)
      } catch (error) {
        report.push('!' + short + ':' + ((error && error.message) || String(error)).slice(0, 80))
      }
    }
    if (report.length > 0) lastError = 'sweep#' + sweeps + ' ' + report.join(' ')
  }

  ctx.effect(() => {
    ensureWeb()
    let stop = null
    const timerSvc = ctx.get('timer')
    if (timerSvc && typeof timerSvc.interval === 'function') {
      stop = timerSvc.interval(() => ensureWeb(), 10000)
    } else {
      const id = setInterval(() => ensureWeb(), 10000)
      stop = () => clearInterval(id)
    }
    return () => {
      try { if (typeof stop === 'function') stop() } catch { /* ignore */ }
      // 只回收本 fiber 持有的注册：按路径无条件删表会让落败 fiber 摘掉别人的路由。
      for (const dispose of owned.values()) {
        try { dispose() } catch { /* 已被外界移除 */ }
      }
      owned.clear()
    }
  })

  // ── 宿主服务：供其它插件/测试复用 ──────────────────────────────────────
  ctx.provide('promptForge', {
    version: '1.0.0',
    forge: runForge,
    route: () => resolveRoute(),
    templates: () => TEMPLATES.map((t) => ({ id: t.id, label: t.label })),
    build: (form) => buildPrompt(completeForm(form)),
    sections: (form) => buildSections(completeForm(form)),
    clean: (text, original) => cleanOutput(text, original),
    parseForm: (text) => parseFormDocument(text),
    serializeForm: (form) => serializeForm(completeForm(form)),
    status: () => ({ sweeps, lastError, routes: [...owned.keys()], deliverySeq: delivery.seq }),
  })
}
