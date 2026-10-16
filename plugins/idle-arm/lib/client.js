// idle-arm 客户端半边。
//
// 职责只有一个：在提交键左侧放一个「武装」按钮，把起拦分钟数交给本会话。
// 落盘拦截的规则、计时曲线与拦截端点全在 ~/.dsh/plugins/idle-guard.js 里
// （宿主半边 POST /idle-arm/arm）；这里只负责发起那一次 POST。
//
// 为什么武装要单独走一个旁路 POST，而不是提交一条宿主斜杠命令：session.command()
// 会把输入框草稿一并推成命令流程——空草稿也能推一条，有草稿时用户输入反而发不出去。
// 武装必须是静默的置位动作，与提交动作彻底分开。
//
// 模块身份：id 必须等于 package.json 的 name（client-modules 会校验
// window.__ModuleLoader__.load 注册的 id 与它在 boot manifest 里请求的 id 一致）。
window.__ModuleLoader__.load({
  id: 'dsh-plugin-idle-arm',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    // 宿主端点。与 open-in-app 等宿主路由同一约定：去掉前导斜杠写成相对路径，
    // 由浏览器按当前页面地址解析，因此不依赖页面挂在哪个路径下。
    const ARM_ROUTE = 'idle-arm/arm'
    // 与 idle-guard.js 的 MIN_MINUTES / MAX_MINUTES 保持一致：短于 3 分钟做不完
    // 「读警告 → 判断 → 落盘」一轮，长于 600 分钟则失去限时意义。
    const MIN_MINUTES = 3
    const MAX_MINUTES = 600
    const DEFAULT_MINUTES = 10

    const NS = 'idle-arm'
    const zh = {
      'action.arm': '武装落盘拦截',
      'action.arming': '正在武装…',
      'action.armed': '已武装 {minutes} 分钟',
      'action.aria': '武装落盘拦截：{minutes} 分钟后开始拦截非落盘调用',
      'field.minutes': '起拦分钟数',
      'field.minutes.aria': '起拦分钟数（3 到 600）',
      'hint': '武装后，本回合内长时间不落盘的工具调用会被拦截并警告。',
      'error.failed': '武装失败：{message}',
      'error.range': '起拦分钟数需在 3 到 600 之间',
      'error.unavailable': '当前会话不可用'
    }
    const en = {
      'action.arm': 'Arm write guard',
      'action.arming': 'Arming…',
      'action.armed': 'Armed for {minutes} min',
      'action.aria': 'Arm the write guard: intercept non-writing calls after {minutes} minutes',
      'field.minutes': 'Trigger minutes',
      'field.minutes.aria': 'Trigger minutes (3 to 600)',
      'hint': 'Once armed, tool calls that avoid writing for too long are intercepted with a warning during this turn.',
      'error.failed': 'Arming failed: {message}',
      'error.range': 'Trigger minutes must be between 3 and 600',
      'error.unavailable': 'The session is unavailable'
    }

    const CLASS = {
      root: 'dshIdleArm_root',
      button: 'dshIdleArm_button',
      armed: 'dshIdleArm_armed',
      minutes: 'dshIdleArm_minutes',
      error: 'dshIdleArm_error'
    }
    // 只声明本插件真正用到的样式；用主题令牌取色，因此跟随宿主明暗主题。
    const css = [
      '.dshIdleArm_root{display:inline-flex;align-items:center;gap:4px;flex:none}',
      '.dshIdleArm_button{display:inline-flex;align-items:center;gap:4px;box-sizing:border-box;height:28px;',
      'padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);',
      'background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;',
      'font-family:var(--dsw-font-family);font-size:12px;line-height:18px;white-space:nowrap}',
      '.dshIdleArm_button:hover:not(:disabled),.dshIdleArm_button:focus-visible{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-primary)}',
      '.dshIdleArm_button:disabled{cursor:default;opacity:.6}',
      '.dshIdleArm_armed{color:var(--dsw-alias-label-primary-bluish);border-color:var(--dsw-alias-button-info-fill)}',
      '.dshIdleArm_minutes{box-sizing:border-box;width:48px;height:28px;padding:0 4px;',
      'border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);',
      'background:0 0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:12px;text-align:center}',
      '.dshIdleArm_error{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;max-width:220px}'
    ].join('')

    /**
     * 提交键左侧的武装控件。
     *
     * 武装只对「发起它的那一回合」负责：宿主在 turn/end 时解除武装。因此这里不
     * 自己维护过期逻辑，而是跟着会话的运行状态收尾——会话回到空闲即视为武装结束，
     * 与宿主侧的生命周期保持同一个判据。
     * @param props - 插槽标准道具（sessionId / useSessionStatus）与本地化函数 t。
     * @returns 控件元素。
     */
    function ArmControl({ sessionId, useSessionStatus, t }) {
      const [minutes, setMinutes] = React.useState(DEFAULT_MINUTES)
      const [pending, setPending] = React.useState(false)
      const [armedMinutes, setArmedMinutes] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const running = useSessionStatus === undefined
        ? false
        : useSessionStatus((map) => map.get(sessionId)?.running === true)
      // 已经观察到本会话跑起来过。武装的真实语义是「到回合结束为止」（宿主在 turn/end
      // 才解除武装），而用户通常在空闲时就点按钮、之后才提交，所以「此刻空闲」绝不等于
      // 「武装已失效」——只看 running===false 会在点下去的瞬间就抹掉标记。
      // 正确的收尾判据是「跑起来过、又回到空闲」，即一次回合真正结束。
      const sawRunning = React.useRef(false)

      React.useEffect(() => {
        if (running === true) {
          sawRunning.current = true
          return
        }
        if (sawRunning.current === true) {
          sawRunning.current = false
          setArmedMinutes(undefined)
        }
      }, [running])

      // 武装是按会话置位的：换到别的会话后，上一个会话的标记不该跟过来。
      React.useEffect(() => {
        sawRunning.current = false
        setArmedMinutes(undefined)
        setError(undefined)
      }, [sessionId])

      if (sessionId === undefined) return null

      const arm = async () => {
        if (pending === true) return
        const value = Number(minutes)
        if (!Number.isSafeInteger(value) || value < MIN_MINUTES || value > MAX_MINUTES) {
          setError(t('error.range'))
          return
        }
        setPending(true)
        setError(undefined)
        try {
          const response = await fetch(ARM_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, minutes: value })
          })
          const payload = await response.json().catch(() => undefined)
          if (!response.ok || payload === undefined || payload.ok !== true) {
            const message = payload !== undefined && typeof payload.message === 'string'
              ? payload.message
              : `HTTP ${String(response.status)}`
            setError(t('error.failed', { message }))
            return
          }
          setArmedMinutes(value)
        } catch (cause) {
          setError(t('error.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
        } finally {
          setPending(false)
        }
      }

      const armed = armedMinutes !== undefined
      const label = pending === true
        ? t('action.arming')
        : armed
          ? t('action.armed', { minutes: armedMinutes })
          : t('action.arm')

      return React.createElement('div', { className: CLASS.root },
        React.createElement('input', {
          className: CLASS.minutes,
          type: 'number',
          min: MIN_MINUTES,
          max: MAX_MINUTES,
          step: 1,
          value: minutes,
          disabled: pending,
          title: t('field.minutes'),
          'aria-label': t('field.minutes.aria'),
          onChange: (event) => setMinutes(event.target.value)
        }),
        React.createElement('button', {
          type: 'button',
          className: armed ? `${CLASS.button} ${CLASS.armed}` : CLASS.button,
          disabled: pending,
          title: t('hint'),
          'aria-label': t('action.aria', { minutes: Number(minutes) || DEFAULT_MINUTES }),
          onClick: arm
        }, React.createElement(primitives.IconClockOutlineRegular, { size: 16 }), label),
        error === undefined
          ? null
          : React.createElement('span', { className: CLASS.error, role: 'alert' }, error)
      )
    }

    // 与 idle-guard.js 的 inject 对应：这里只需要插槽表与本地化服务。
    const inject = ['slots', 'locale']

    /**
     * 客户端插件体：注册文案与提交键左侧的武装控件。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'idle-arm: dictionaries')
      const tagId = 'dsh-plugin-idle-arm/ArmControl.css'
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-plugin-idle-arm'
        tag.dataset.pluginCss = tagId
        tag.textContent = css
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'idle-arm: styles')
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'idle-arm',
        order: 100,
        locale: NS
      }, ArmControl))
    }

    return { name: 'idle-arm-client', inject, apply }
  }
})
