'use strict'

// keep-partial-output.js —— 保留已流出的部分内容（宿主级持久插件）
//
// 症状：模型流式输出到一半时以 error 收尾（provider 的 content_filter、限流、
// 上游 5xx、传输中断……），前端已经把内容显示出来了，随后整段消失。
//
// 根因不在 content filter，而在两条收尾分支写得不对称：
//   · 中断路径（dsh-agent-loop step()）：写 `assistant/message` + `interrupted: true`
//     —— 内容保留。
//   · 错误路径（同一函数，紧邻的下一段）：只写 `assistant/attempt`，那是不带
//     message 的原始流记录。前端据此把该 attempt 的 transient 行整体退休
//     （dsh-client-ui-conversation 的 settleAssistant），内容就没了。
//
// 因此 content_filter 只是众多错误来源之一，任何 error 收尾都会丢内容。
//
// 接入点：`agent/request-error` 是 agent 作用域的 waterfall 钩子，由 agent-loop
// 在落完 `assistant/attempt` 之后、抛 LlmError 之前调用。在这里补写一条带内容的
// `assistant/message`，错误本身与重试语义完全不动。
//
// 不变量：
//   1. 只在真的流出过可见文本时才补写；空流仍走原本的 attempt 收尾。
//   2. 补写带 `interrupted: true`，与中断路径同一语义：前端显示为“已中断”的
//      内容，而不是伪装成完整回答。
//   3. 不保留 tool-call 块。被中断的调用没有 tool/result，留下它会让下一次请求
//      带一条无应答的调用，直接触发 provider 报错。
//   4. 重试决策优先。先让下游（llm-retry）表态，若它要重试就什么都不写——
//      重试会用完整回答替换这段内容，提前写入只会在历史里多出一条半截消息。
//   5. 幂等。同一 turn/step 只补写一次。
//   6. 补写失败绝不外抛。否则原本要抛的 provider 错误会被一条本地写日志错误
//      顶掉，用户就看不到真正的失败原因了。
//
// 零依赖：本文件位于 ~/.dsh/plugins/，不在任何 node_modules 链上，require 向上
// 查找到不了 harness 的包。消息对象按校验要求手工构造（id/role/source/content），
// 与 dsh-llm 的 createAssistantMessage 产出同形。

const { randomUUID } = require('node:crypto')

/** 回溯查找本次失败对应的 assistant/attempt 的最大事件数。 */
const TAIL_SCAN_LIMIT = 16

/**
 * 从一段 assistant 流记录里取回已经流出的可见块。
 *
 * 流的记录有两种形态：dense chunk（`type: 'chunk'`，逐块原样记录）与 compact
 * 聚合记录（text-chunks / reasoning-chunks / tool-call-chunks）。这里重建
 * text 与 reasoning，并按 index 保持顺序。
 *
 * @param {readonly unknown[]} stream - assistant 流的记录数组。
 * @returns {{type: 'text'|'reasoning', text: string}[]} 有序、去空的可见块。
 */
function visibleBlocksOf(stream) {
  /** @type {Map<number, {kind: 'text'|'reasoning', text: string}>} */
  const blocks = new Map()

  /** @param {unknown} index @param {'text'|'reasoning'} kind */
  const slot = (index, kind) => {
    const key = Number(index)
    const found = blocks.get(key)
    if (found !== undefined) return found
    const created = { kind, text: '' }
    blocks.set(key, created)
    return created
  }

  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue

    const type = record.type
    if (type === 'text-chunks' || type === 'reasoning-chunks') {
      const kind = type === 'text-chunks' ? 'text' : 'reasoning'
      if (!Array.isArray(record.texts)) continue
      const block = slot(record.index, kind)
      for (const piece of record.texts) if (typeof piece === 'string') block.text += piece
      continue
    }
    if (type !== 'chunk') continue

    const chunk = record.chunk
    if (chunk === null || typeof chunk !== 'object') continue

    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const kind = chunk.type === 'text-delta' ? 'text' : 'reasoning'
      if (typeof chunk.text !== 'string') continue
      slot(chunk.index, kind).text += chunk.text
      continue
    }
    if (chunk.type === 'block-end') {
      const block = chunk.block
      if (block === null || typeof block !== 'object') continue
      if (block.type !== 'text' && block.type !== 'reasoning') continue
      if (typeof block.text !== 'string') continue
      // block-end 是权威的整块内容：覆盖累加结果，避免 delta 缺失时短一截。
      blocks.set(Number(chunk.index), { kind: block.type, text: block.text })
    }
  }

  return [...blocks.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, block]) => ({ type: block.kind, text: block.text }))
    .filter((block) => block.text.trim() !== '')
}

module.exports = {
  name: 'keep-partial-output',
  inject: [],
  apply(ctx) {
    // 会话 → 已补写的 `turn:step` 集合，用于幂等。会话回收时自动释放。
    /** @type {WeakMap<object, Set<string>>} */
    const written = new WeakMap()

    /**
     * 在日志尾部回溯本次失败对应的 `assistant/attempt`。
     *
     * 不能假定它就是最后一条：本钩子是 waterfall，外层监听者（llm-retry）可能在
     * 我们之前落过别的记录。只认 turn/step 精确匹配的那一条，宁可找不到也不猜。
     *
     * @param {object} session - 出错的会话。
     * @param {number} turn - 失败的 turn。
     * @param {number} step - 失败的 step。
     * @returns {object|undefined} 匹配的 attempt 事件。
     */
    const findAttempt = (session, turn, step) => {
      const end = session.seq
      const floor = Math.max(0, end - TAIL_SCAN_LIMIT)
      for (let seq = end - 1; seq >= floor; seq -= 1) {
        const candidate = session.eventAt(seq)
        if (candidate === undefined) return undefined
        const data = candidate.data
        if (candidate.type === 'assistant/attempt') {
          if (data.turn === turn && data.step === step) return candidate
          continue
        }
        // 只跨过无关的边界记录；遇到别的 assistant 结算就停，避免张冠李戴。
        if (candidate.type === 'assistant/message') return undefined
      }
      return undefined
    }

    /**
     * 取本次请求的 provider/model，用于补写消息的 source。
     * 校验要求两者都是非空字符串，取不到时用占位符而不是留空。
     *
     * @param {object} session - 出错的会话。
     * @returns {{provider: string, model: string}} 模型来源。
     */
    const modelOf = (session) => {
      const context = session.requestContext()
      if (context !== undefined && typeof context.provider === 'string' && typeof context.model === 'string') {
        return { provider: context.provider, model: context.model }
      }
      const header = session.requestHeader()
      const config = header === undefined ? undefined : header.config
      if (config !== undefined && typeof config.provider === 'string' && typeof config.model === 'string') {
        return { provider: config.provider, model: config.model }
      }
      return { provider: 'unknown', model: 'unknown' }
    }

    ctx.on('agent/request-error', async (payload, next) => {
      const agent = payload.agent
      const session = agent === undefined ? undefined : agent.session
      const turn = payload.turn
      const step = payload.step
      if (session === undefined) return next()

      // 先取证：此刻日志尾部仍是本次失败的 attempt。取不到就完全不介入。
      const attempt = findAttempt(session, turn, step)
      const stream = attempt === undefined ? undefined : attempt.data.stream
      const blocks = Array.isArray(stream) ? visibleBlocksOf(stream) : []
      if (blocks.length === 0) return next()

      // 让下游先表态：要重试就不补写（重试会用完整回答替换这段）。
      const action = await next()
      if (action !== null && typeof action === 'object' && action.kind === 'retry') return action

      const key = String(turn) + ':' + String(step)
      let seen = written.get(session)
      if (seen === undefined) {
        seen = new Set()
        written.set(session, seen)
      }
      if (seen.has(key)) return action
      seen.add(key)

      try {
        const source = modelOf(session)
        session.append(
          'assistant/message',
          {
            turn,
            step,
            message: {
              id: randomUUID(),
              role: 'assistant',
              content: blocks,
              source: { kind: 'model', provider: source.provider, model: source.model },
            },
            stream,
            interrupted: true,
          },
          { surfaceOp: 'append' },
        )
      } catch (error) {
        // 补写是增强，绝不能顶掉原本要抛的 provider 错误。
        ctx.logger?.warn?.('keep-partial-output: 补写部分内容失败: ' + String(error))
      }

      return action
      // prepend 让本监听者成为链上最外层：先取证（此刻尾部还是本次的 attempt），
      // 再通过 next() 取得下游（llm-retry）的最终决策。若排在里层，next() 只包含
      // 更内层的默认行为，就看不到重试决策了。
    }, { global: true, prepend: true })
  },
}
