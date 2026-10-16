'use strict'

// idle-guard.js —— 闲置落盘拦截（宿主级持久插件）
module.exports = {
  name: 'idle-guard',
  inject: ['webServer', 'connection'],
  apply(ctx) {
    // 会落盘的工具。它们一到就把计时清零——本规则唯一认可的生产行为。
    const EDIT_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
    const MINUTE_MS = 60000
    // 起拦分钟数的合法区间。下限取 3 而非 1：单段间隔的下限就是 3 分钟，允许更小的
    // 起拦时间会让首段间隔低于下限——要么静默按 3 跑（用户填的数被改写），要么违反
    // 「每段不少于 3 分钟」。把区间收在 3 上，两个毛病一起没有。
    const MIN_MINUTES = 3
    const MAX_MINUTES = 600
    // 单段间隔下限：读一次警告、判断、落实成一次落盘所需的最短时间。
    const MIN_GAP = 3
    // 每个阶段要送达几次拦截：软阶段 1 次，严厉阶段连拦 2 次，之后进入闩锁（无限次）。
    // 阶段边界由这张表推出，不在别处硬编码——改「连拦几次」只需要改这里一个数字。
    const STRIKES_PER_STAGE = [1, 2]
    // 送满这些次数就进入闩锁阶段。
    const TERMINAL_SERVED = STRIKES_PER_STAGE.reduce((a, b) => a + b, 0)
    // 武装端点。kind 为 exact，只接 POST。
    const ARM_PATH = '/idle-arm/arm'

    /**
     * 三阶段警告词，下标 = 阶段（0/1/2），二级下标 = 是否已经落过盘。
     *
     * 阶段按**已送达的拦截次数**递增：用户说的是「第几次拦截」，压力理应随
     * 「被警告过几次」上升。而「何时允许拦」仍由时间曲线决定——两者是正交的，
     * 阶段管措辞与重复方式，曲线管节奏。
     *
     * 每一级都保留「尚未落盘 / 落盘后又空转」的区分：模型明明落过盘却被说成
     * 「从未编辑」，会把它往错误方向推，这条区分在任何一级都成立。
     */
    const WARNINGS = [
      // 第一阶段：软拦截。措辞保持最初版本不变。
      [
        '【警告】自本任务开始已过去 {m} 分钟，你仍未进行过任何文件编辑，请你提高工作效率，减少低效检索、重复思考与无目的空转，专注于用户给予的任务本身，不要分散注意力，并尽快落盘修改！',
        '【警告】距上次落盘已过去 {m} 分钟，这段时间你没有产生新的落盘成果。请你提高工作效率，减少低效检索、重复思考与无目的空转，专注于用户给予的任务本身，不要分散注意力，尽快把新的成果落盘修改！',
      ],
      // 第二阶段：措辞更严厉，且本阶段要连拦两次才放行。
      [
        '【严重警告】自本任务开始已过去 {m} 分钟，你依然没有进行过任何文件编辑。这是第二次拦截，下一次将不再放行你的任何非落盘调用。立刻停止检索与空转，现在就去落盘。',
        '【严重警告】距上次落盘已过去 {m} 分钟，你依然没有产生新的落盘成果。这是第二次拦截，下一次将不再放行你的任何非落盘调用。立刻停止检索与空转，现在就把新成果落盘。',
      ],
      // 第三阶段：强制状态。不再看时钟，重复拦截直到出现一次落盘。
      [
        '【强制拦截】自本任务开始已过去 {m} 分钟，你始终没有进行过任何文件编辑。在你完成一次文件编辑之前，每一次非落盘的工具调用都会被拒绝。立即停止一切检索，直接落盘。',
        '【强制拦截】距上次落盘已过去 {m} 分钟，你始终没有产生新的落盘成果。在你完成一次新的文件编辑之前，每一次非落盘的工具调用都会被拒绝。立即停止一切检索，直接落盘修改。',
      ],
    ]

    /**
     * 已送达 served 次拦截时，该用哪个阶段。
     *
     * 按累计次数逐级扣除，而不是写死 served 与阶段号的对应关系：后者
     * 一旦改了 STRIKES_PER_STAGE 就会悄悄错位，而且「第二阶段连拦两次」的第二次
     * 极易被算成第三阶段——那正是把严厉措辞写成强制措辞的原因。
     */
    const stageOf = (served) => {
      let stage = 0
      let left = served
      while (stage < STRIKES_PER_STAGE.length && left >= STRIKES_PER_STAGE[stage]) {
        left -= STRIKES_PER_STAGE[stage]
        stage += 1
      }
      return stage
    }

    /** 按当前已送达次数与是否落过盘取警告词。 */
    const reasonFor = (state, minutes) => {
      const stage = Math.min(stageOf(state.served), WARNINGS.length - 1)
      return WARNINGS[stage][state.edited ? 1 : 0].replace('{m}', String(minutes))
    }

    /**
     * 已武装的会话 → { minutes, gap, edited, consumed, served, lastStage, pending }。
     * 未列入 = 默认模式，完全不拦截。
     *
     * consumed 与 served 必须分开，这是本规则最容易写错的地方：
     *   · consumed —— 已消费到第几个检查点，只由时钟推进，决定**何时允许拦**。
     *   · served   —— 已实际送达几次拦截，只在批次结算时推进，决定**拦得多重**。
     * 合用一个计数器会有两种错法：按 served 逐次加一，模型一口气想过了很多检查点时
     * passed 远大于 served，闸门一直开着，三个阶段会背靠背连发；按 passed 直接赋值，
     * 阶段二想「连拦两次」就凑不齐——第二次得等到下一个检查点，那就不叫连拦了。
     *
     * lastStage 记的是**上一次拦截所用的阶段**。阶段二的第二次连拦靠它判断：
     * 只有上一次拦截已经是严厉级，才补第二次。否则软拦截刚结算完（served=1）就会
     * 被误判成「阶段二还差一次」，在 T(2) 之前提前开出严厉级。
     *
     * 所有计数器都**只在 step/end 推进**，绝不在 pre-execute 里改：模型常在一个批次
     * 里并发调用多个工具，若在拦截时就推进，同批其余调用会因「已消费」而全部放行——
     * 那正是要堵的漏洞。
     */
    const armed = new WeakMap()
    /** 会话 → 计时基准时刻（回合开始，或最近一次落盘）。 */
    const idleBase = new WeakMap()

    /**
     * 单段间隔：起拦时间是用户对任务耗时的预估，间隔取它的一半。
     *
     * 为什么是预估的一半而不是别的：S 这种量级的人工预估本身就有两倍上下的误差
     * （计划谬误的量级）。间隔比 S/2 更密，就落进预估自身的噪声带——警告会在用户
     * 认可的工作节奏内反复打断，退化成重复打扰；比 S/2 更疏，盲区就超过用户自认可
     * 接受时长的一半，限时失去意义。取一半是这两侧之间唯一不带任意常数的分界。
     *
     * 下限 3 分钟：读一次警告、判断、落实成一次落盘，短于 3 分钟做不到。下限同时
     * 兜住 S 很小的情况，而输入下限也是 3，所以它实际上只在 S=3、4、5 时生效
     * （ceil(S/2) 分别为 2、2、3）。
     *
     * @param {number} minutes - 用户设定的起拦分钟数 S。
     */
    const gapOf = (minutes) => Math.max(MIN_GAP, Math.ceil(minutes / 2))

    /**
     * 反解已越过的检查点个数：满足 T(k) <= elapsed 的最大 k，其中
     *     T(k) = S + (k-1)·gap，gap = gapOf(S)
     * 即首段为 S，此后每段恒为 gap。
     *
     * 反解写成 k = floor((elapsed - S) / gap) + 1 也等价，但那样「正算」与「反解」
     * 就是两套式子，一旦哪天改了曲线就得同时改两处，漏一处就出现「明明过了点却没拦」
     * 那种错位。这里只留一份递推，正算反解共用同一串 T(k)。
     *
     * 增量求和是 O(k)，而 k 在本场景里是个位数到两位数（S=3 时每分钟一个检查点，
     * 跑满一小时也才 60 个），不必为性能牺牲可读性。
     *
     * 时钟被 NTP 回拨（elapsed 为负）无需特判：首个区间恒为 S 分钟，next > elapsed
     * 立刻成立，循环直接返回 0。这是 36001 个负采样点扫出来的结论，不是推断——
     * 所以这里没有 Math.max(0, …) 那种看着稳妥的冗余钳制。
     *
     * @param {number} elapsedMs - 距基准已过的毫秒数。
     * @param {number} base - 用户设定的起拦分钟数 S。
     * @param {number} gap - 单段间隔（分钟）。
     */
    const checkpointsPassed = (elapsedMs, base, gap) => {
      let total = base * MINUTE_MS
      let k = 0
      // 上界：total = S + k·gap ≥ k·min(S, gap)，故 k 到 ceil(elapsed/min(S,gap)) + 1
      // 时 total 必已超过 elapsed，循环一定在更早处 break。取 +2 留一格余量。
      // 这里不能用 S 当步长：S 很大时 gap = S/2 远小于 S，按 S 估的上界会把循环
      // 提前掐断，返回一个偏小的 k——那正是「明明过了点却没拦」。
      const limit = Math.ceil(elapsedMs / (Math.min(base, gap) * MINUTE_MS)) + 2
      while (k < limit) {
        if (total > elapsedMs) break
        k += 1
        total += gap * MINUTE_MS
      }
      return k
    }

    const sendJson = (res, status, payload) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(payload))
    }

    /**
     * 武装端点：客户端按钮在提交前调用，把分钟数交给本会话。
     * 复用 composition 的 connection 服务做信任栅栏（Host/Origin 与登录令牌），
     * 与会话无关的调用者拿不到任何东西。
     */
    const readBody = (req) => new Promise((resolve, reject) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 4096) reject(new Error('body too large'))
      })
      req.on('end', () => resolve(raw))
      req.on('error', reject)
    })

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: ARM_PATH,
      handler: async (req, res) => {
        // 信任栅栏：与 open-in-app 等宿主路由同一套校验。
        const connection = Reflect.get(ctx, 'connection')
        const rejection = connection === undefined ? undefined : connection.requestRejection(req)
        if (rejection !== undefined) {
          res.statusCode = rejection
          res.end()
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('allow', 'POST')
          res.end()
          return
        }
        let payload
        try {
          payload = JSON.parse((await readBody(req)) || '{}')
        } catch (error) {
          sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' })
          return
        }
        const minutes = payload === null || typeof payload !== 'object' ? undefined : payload.minutes
        if (!Number.isSafeInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
          sendJson(res, 400, { ok: false, message: '起拦时间需在 ' + MIN_MINUTES + ' 到 ' + MAX_MINUTES + ' 分钟之间' })
          return
        }
        const sessionId = payload.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          sendJson(res, 400, { ok: false, message: '缺少 sessionId' })
          return
        }
        // 用 agents 注册表按 id 找活跃会话：session/created 只在创建时触发，
        // 对「已在运行」的会话永远不补发，靠它登记会漏掉绝大多数情况。
        const agents = ctx.get('agents')
        const agent = agents === undefined ? undefined : agents.get(sessionId)
        const session = agent === undefined ? undefined : agent.session
        if (session === undefined) {
          sendJson(res, 404, { ok: false, message: '会话未就绪：' + sessionId })
          return
        }
        // 间隔随起拦时间一次性算定并随武装一起存下：拦截路径上不该反复推导同一常量。
        const gap = gapOf(minutes)
        armed.set(session, { minutes: minutes, gap: gap, edited: false, consumed: 0, served: 0, lastStage: -1, pending: false })
        // 武装即起算。不这么做的话，在「回合已跑了一会儿」时点按钮，基准仍是该回合的
        // 起点，模型的下一次调用会被立刻拦下——用户刚设定的起拦时间形同虚设。
        // 随后的 turn/start 会把基准重新对齐到新回合的起点，只会让窗口更长，不会更短。
        idleBase.set(session, Date.now())
        sendJson(res, 200, { ok: true, minutes: minutes, gap: gap })
      },
    }), 'idle-guard: POST ' + ARM_PATH)

    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') {
        // 每个回合开启时把基准对齐到会话计时，并让三阶段从头开始：
        // 新回合是新任务，上一回合的升级不该继承过来。
        idleBase.set(session, event.time)
        const state = armed.get(session)
        if (state !== undefined) {
          state.edited = false
          state.consumed = 0
          state.served = 0
          state.lastStage = -1
          state.pending = false
        }
        return
      }
      // 回合结束即解除武装：武装只对发起它的那一轮负责，不泄漏到后续回合。
      if (event.type === 'turn/end') {
        armed.delete(session)
        return
      }
      if (event.type !== 'step/end') return
      // 结算整个批次：本步内所有非落盘调用都已被拒，此刻才推进计数器，
      // 否则同批其余调用会因「已消费」而全部放行。
      const state = armed.get(session)
      if (state === undefined) return
      if (!state.pending) return
      state.pending = false
      // 本批次确实送出过一次拦截：送达计数加一，同时把时钟已越过的检查点一并消费掉。
      state.lastStage = stageOf(state.served)
      state.served += 1
      const since = idleBase.get(session)
      if (since !== undefined) {
        state.consumed = checkpointsPassed(Date.now() - since, state.minutes, state.gap)
      }
    }, { global: true })

    ctx.on('tools/pre-execute', (exec, next) => {
      const agent = exec.agent
      const session = agent === undefined ? undefined : agent.session
      if (session === undefined) return next()

      const state = armed.get(session)
      if (state === undefined) return next()

      if (EDIT_TOOLS.has(exec.name)) {
        // 落盘达成一次产出：记住「已经落过盘」，把计时从此刻重新起算，并解除第三阶段的
        // 闩锁、退回第一阶段——一次落盘就是本规则要的结果，压力理应全部释放。
        // 武装本身保留到回合结束：本规则是逐阶段拦截，不是「落盘一次即解封」，
        // 否则模型写一行就再也不会被拦。
        state.edited = true
        state.consumed = 0
        state.served = 0
        // lastStage 必须一并复位。它记的是「上一次拦截用的是哪个阶段」，落盘后阶梯
        // 已经回到第一阶段，留着旧值会让「阶段二连拦两次」的判据误命中，落盘刚过
        // 就立刻再吃一次严厉拦截——落盘等于没落。
        state.lastStage = -1
        state.pending = false
        idleBase.set(session, Date.now())
        return next()
      }

      const since = idleBase.get(session)
      if (since === undefined) return next()
      const minutes = Math.floor((Date.now() - since) / MINUTE_MS)
      const stage = stageOf(state.served)

      // 第三阶段是闩锁：不再看时钟，每一次非落盘调用都拒，直到出现一次落盘。
      if (stage >= WARNINGS.length - 1) {
        state.pending = true
        return Promise.resolve({ kind: 'deny', reason: reasonFor(state, minutes) })
      }

      // 前两阶段由时间曲线放行：时钟越过了尚未消费的检查点才拦。
      // consumed 只在 step/end 推进，所以同批的其余调用会看到同一个 consumed，
      // 一起被拒——批次漏洞就是这么堵住的。
      const passed = checkpointsPassed(Date.now() - since, state.minutes, state.gap)
      if (passed > state.consumed) {
        state.pending = true
        return Promise.resolve({ kind: 'deny', reason: reasonFor(state, minutes) })
      }

      // 第二阶段要「连拦两次」，而第二次**不占新的检查点**——否则得等到下一个检查点，
      // 那就不叫连拦了。条件是「上一次拦截已经用的是严厉级，且本阶段还没送满」，
      // 而不是「served 到了某个数」：软拦截结算完 served=1，若按计数判断就会在
      // T(2) 之前提前开出严厉级。
      if (state.lastStage === 1 && state.served < TERMINAL_SERVED) {
        state.pending = true
        return Promise.resolve({ kind: 'deny', reason: reasonFor(state, minutes) })
      }

      return next()
    })
  },
}
