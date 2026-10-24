'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

module.exports = {
  name: 'preset-hotreload-and-meter',
  inject: ['agentPresets'],

  apply(ctx) {
    const agentPresets = ctx.get('agentPresets')
    if (!agentPresets) {
      console.error('[preset-hotreload] 缺少 agentPresets 服务；插件停用')
      return
    }

    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

    // ── 1. 预设热重载 ───────────────────────────────────────────────────────────
    // 预设是 patch 层里的 @deepseek-ai/dsh-agent-preset 声明行，来源目录为
    // ~/.dsh/.agent-presets/<id>/；dsh-hmr 会监听下列 patch 文件，并在
    // 变更时重放整层（行 dispose 后重新 init，注册表随之拿到新修订）。
    // 官方语义是「已有会话保持启动时的修订」，所以本插件只补最后一步：
    // 把已运行的会话重绑到重放后的新修订，使改动无需重启、也无需新建会话即可生效。
    const watchedFiles = [
      path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'),
      path.join(dshHome, 'cordis.patch.yml'),
    ]

    const fileStamps = new Map()
    const liveAgents = new Map()
    const changedPresetIds = new Set()
    const presetRowsSeen = new Set()
    let flushTimer

    const fileStamp = (file) => {
      try {
        const stat = fs.statSync(file)
        return stat.mtimeMs + ':' + stat.size
      } catch (error) {
        return undefined
      }
    }

    const scheduleFlush = () => {
      if (flushTimer !== undefined) return
      // 留出 patch 重放与注册表重注册的落地时间，再执行重绑。
      flushTimer = setTimeout(() => {
        flushTimer = undefined
        flush()
      }, 250)
    }

    /**
     * 会话当前是否真正静止（无活动回合，也不在维护中）。
     *
     * `agent.status` 在维护期间仍报 'idle'（官方语义：runMaintenance 执行时
     * public status stays idle），所以单看 status 无法区分「真空闲」与「正在维护」；
     * `agent.phase` 又是 agent-loop 的内部实现，不是公开 API。这里用公开的
     * `agent.whenIdle()` 做即时探测：真空闲时它在微任务内就 resolve，
     * 维护或回合进行中则要等，因此给一个很短的等待窗——等不到就按「忙」处理。
     * 语义：忙的会话本次跳过重绑，等下一次 patch 变更再试。
     * @param {object} agent - 目标 agent。
     * @returns {Promise<boolean>} 是否可立即重绑。
     */
    const quiescentNow = (agent) => {
      if (typeof agent.whenIdle !== 'function') return Promise.resolve(true)
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 50)
        const settle = (value) => { clearTimeout(timer); resolve(value) }
        agent.whenIdle().then(() => settle(true), () => settle(false))
      })
    }

    const flush = async () => {
      const ids = [...changedPresetIds]
      changedPresetIds.clear()
      const label = ids.length > 0 ? '（' + ids.join('、') + '）' : ''
      const targets = []
      for (const agent of liveAgents.values()) {
        let presetId
        try {
          presetId = agentPresets.composedPreset(agent.ctx)
        } catch (error) {
          presetId = undefined
        }
        if (presetId === undefined) continue
        if (ids.length > 0 && !ids.includes(presetId)) continue
        if (agent.status !== undefined && agent.status !== 'idle') {
          console.log('[preset-hotreload] 会话 ' + agent.id + ' 状态为 ' + agent.status + '，本次跳过重绑')
          continue
        }
        if (!(await quiescentNow(agent))) {
          console.log('[preset-hotreload] 会话 ' + agent.id + ' 仍在活动或维护中，本次跳过重绑')
          continue
        }
        targets.push({ agent, presetId })
      }
      if (targets.length === 0) {
        console.log('[preset-hotreload] 预设声明已更新' + label + '，当前无空闲会话需要重绑；新建会话将直接使用新修订。')
        return
      }
      console.log('[preset-hotreload] 检测到预设声明更新' + label + '，正在为 ' + targets.length + ' 个空闲会话重绑新修订...')
      for (const target of targets) {
        try {
          await agentPresets.recompose(target.agent.ctx, target.presetId)
          console.log('[preset-hotreload] 会话 ' + target.agent.id + ' 已重绑到预设「' + target.presetId + '」的最新修订。')
        } catch (error) {
          console.warn('[preset-hotreload] 会话 ' + target.agent.id + ' 重绑预设「' + target.presetId + '」失败：' + (error instanceof Error ? error.message : String(error)))
        }
      }
    }

    // 信号一：预设声明行的重新初始化。首次挂载只登记、不算变更，避免开机误报。
    ctx.on('loader/entry-init', (entry) => {
      const id = !entry || !entry.options ? undefined : entry.options.id
      if (typeof id !== 'string' || !id.startsWith('preset-')) return
      if (!presetRowsSeen.has(id)) {
        presetRowsSeen.add(id)
        return
      }
      changedPresetIds.add(id.slice('preset-'.length))
      scheduleFlush()
    })

    // 信号二：patch 文件时间戳（覆盖「patch 变更但预设行未重建」的情形），
    // 并在步骤边界登记活动会话，供重绑阶段定位。
    // agent/pre-step 由 agent 作用域载体派发（scopeTarget(agent, agent)），
    // 宿主行必须声明 global 才能收到会话作用域里的事件。
    ctx.on('agent/pre-step', async (payload, next) => {
      const agent = payload === undefined || payload === null ? undefined : payload.agent
      if (agent !== undefined && typeof agent.id === 'string') {
        liveAgents.set(agent.id, agent)
        // 上限兜底：只保留最近活动的 64 个会话，避免长期持有已结束会话的 Agent。
        if (liveAgents.size > 64) {
          const oldest = liveAgents.keys().next().value
          liveAgents.delete(oldest)
        }
      }
      for (const file of watchedFiles) {
        const stamp = fileStamp(file)
        if (stamp === undefined) continue
        const previous = fileStamps.get(file)
        fileStamps.set(file, stamp)
        if (previous !== undefined && previous !== stamp) {
          changedPresetIds.clear()
          scheduleFlush()
        }
      }
      return typeof next === 'function' ? next() : undefined
    }, { global: true })

    // ── 2. 上下文计量说明 ───────────────────────────────────────────────────────
    // 本插件不注册 contextBreakdown 投影，原因：
    //   (a) SessionProjectionRegistry.register() 为「先注册者胜」—— dsh-token-meter
    //       在构造时就注册了 contextBreakdown，插件后注册只增加引用计数，
    //       其 apply/view 会被直接丢弃，属于死代码；
    //   (b) 该 fold 只统计顶层 type==='text' 块，而 tool/result 内容嵌套在
    //       {type:'tool-result', content:[...]} 内部，工具消息被计为 0，且完全
    //       未处理压缩的 replace 操作——即便生效也会得到严重偏小的数字。
    // 面板「明细与总量对不上」的根因：头部数字取 contextPressure 的 projectedTokens
    // （provider usage 锚定的真实请求规模），三行明细取 contextBreakdown 的启发式估算，
    // 两者本就分属两套体系、上游明确不相加。修正只做在呈现层
    // （applyCorePatches 的 4.4：按明细权重把真实总量分配下去），
    // 不触碰估算器与压缩阈值，可随时回滚。
  },
}
