// idle-arm 客户端半边。
//
// 一个「落盘拦截」按钮：点开一个小面板配置起栏时间，确认后把分钟数交给宿主置位，
// 并自动提交当前输入——全程不需要用户再按一次提交键或回车。
//
// 落盘拦截的规则、计时曲线与拦截端点全在 ~/.dsh/plugins/idle-guard.js 里
// （宿主半边 POST /idle-arm/arm）；这里只负责「配置 + 置位 + 提交」这一串动作。
//
// 为什么武装要单独走一个旁路 POST，而不是提交一条宿主斜杠命令：session.command()
// 会把输入框草稿一并推成命令流程——空草稿也能推一条，有草稿时用户输入反而发不出去。
// 武装必须是静默的置位动作，与提交动作彻底分开；提交则由本控件在置位成功后显式发起。
//
// 模块身份：id 必须等于 package.json 的 name（client-modules 会校验
// window.__ModuleLoader__.load 注册的 id 与它在 boot manifest 里请求的 id 一致）。
window.__ModuleLoader__.load({
  id: 'dsh-plugin-idle-arm',
  factory: (require) => {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    // 宿主端点。与 open-in-app 等宿主路由同一约定：去掉前导斜杠写成相对路径，
    // 由浏览器按当前页面地址解析，因此不依赖页面挂在哪个路径下。
    const ARM_ROUTE = 'idle-arm/arm'
    // 与 idle-guard.js 的 MIN_MINUTES / MAX_MINUTES 保持一致：短于 3 分钟做不完
    // 「读警告 → 判断 → 落盘」一轮，长于 600 分钟则失去限时意义。
    const MIN_MINUTES = 3
    const MAX_MINUTES = 600
    const DEFAULT_MINUTES = 10
    const VIEWPORT_MARGIN = 12
    const MENU_GAP = 5
    // 未定位时的面板样式：隐藏但保持可布局，以便首次定位能测到真实尺寸。
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }

    const NS = 'idle-arm'
    const zh = {
      'trigger': '落盘拦截',
      'trigger.armed': '落盘拦截 {minutes} 分',
      'trigger.aria': '落盘拦截设置',
      'panel.title': '落盘拦截',
      'panel.minutes': '起栏时间（分钟）',
      'panel.hint': '确认后将开始计时：超时未落盘的调用会被拦截并警告，直到出现一次文件编辑。',
      'action.confirm': '确认并发送',
      'action.confirming': '正在置位…',
      'action.cancel': '取消',
      'error.range': '起栏时间需在 3 到 600 分钟之间',
      'error.failed': '置位失败：{message}'
    }
    const en = {
      'trigger': 'Write guard',
      'trigger.armed': 'Write guard {minutes} min',
      'trigger.aria': 'Write-guard settings',
      'panel.title': 'Write guard',
      'panel.minutes': 'Trigger minutes',
      'panel.hint': 'Confirming starts the clock: calls that avoid writing past the deadline are intercepted with a warning until a file edit lands.',
      'action.confirm': 'Confirm and send',
      'action.confirming': 'Arming…',
      'action.cancel': 'Cancel',
      'error.range': 'Trigger minutes must be between 3 and 600',
      'error.failed': 'Arming failed: {message}'
    }

    const CLASS = {
      root: 'dshIdleArm_root',
      trigger: 'dshIdleArm_trigger',
      triggerArmed: 'dshIdleArm_triggerArmed',
      panel: 'dshIdleArm_panel',
      title: 'dshIdleArm_title',
      field: 'dshIdleArm_field',
      minutes: 'dshIdleArm_minutes',
      hint: 'dshIdleArm_hint',
      actions: 'dshIdleArm_actions',
      primary: 'dshIdleArm_primary',
      ghost: 'dshIdleArm_ghost',
      error: 'dshIdleArm_error'
    }
    // 只声明本插件真正用到的样式；用主题令牌取色，因此跟随宿主明暗主题。
    const css = [
      '.dshIdleArm_root{display:inline-flex;align-items:center;flex:none;position:relative}',
      '.dshIdleArm_trigger{display:inline-flex;align-items:center;gap:4px;box-sizing:border-box;height:28px;',
      'padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);',
      'background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;',
      'font-family:var(--dsw-font-family);font-size:12px;line-height:18px;white-space:nowrap}',
      '.dshIdleArm_trigger:hover:not(:disabled),.dshIdleArm_trigger:focus-visible{',
      'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshIdleArm_trigger:disabled{cursor:default;opacity:.6}',
      '.dshIdleArm_triggerArmed{color:var(--dsw-alias-label-primary-bluish);border-color:var(--dsw-alias-button-info-fill)}',
      // position:fixed 是必需的，不是样式偏好：useAnchoredPosition 返回的是视口坐标
      // （left/top），只有 fixed 才把它当视口定位。缺少它时元素按 static/relative 参与
      // 文档流，top 变成「距文档顶部」——面板会被推到页面下方几千像素处，看起来就是
      // 「点了按钮没反应」。宿主自带的 MenuSurface 使用者（如 ui-jobs）同样在样式里
      // 声明 position:fixed，这里必须对齐。
      '.dshIdleArm_panel{position:fixed;z-index:100;box-sizing:border-box;width:260px;padding:12px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
      'font-family:var(--dsw-font-family);font-size:12px;line-height:18px;',
      'box-shadow:0 6px 24px rgba(0,0,0,.18)}',
      '.dshIdleArm_title{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);margin-bottom:8px}',
      '.dshIdleArm_field{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
      '.dshIdleArm_field label{color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dshIdleArm_minutes{box-sizing:border-box;flex:1;height:28px;padding:0 6px;',
      'border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);',
      'background:0 0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:12px}',
      '.dshIdleArm_hint{color:var(--dsw-alias-label-tertiary);margin-bottom:10px}',
      '.dshIdleArm_actions{display:flex;justify-content:flex-end;gap:8px}',
      '.dshIdleArm_primary,.dshIdleArm_ghost{box-sizing:border-box;height:28px;padding:0 10px;',
      'border-radius:var(--dsw-radius-sm);cursor:pointer;font-family:var(--dsw-font-family);font-size:12px}',
      '.dshIdleArm_primary{border:.5px solid var(--dsw-alias-button-info-fill);',
      'background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-inverted)}',
      '.dshIdleArm_primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover);border-color:var(--dsw-alias-button-info-hover)}',
      '.dshIdleArm_primary:disabled{cursor:default;opacity:.6}',
      '.dshIdleArm_ghost{border:.5px solid var(--dsw-alias-border-l4);background:0 0;color:var(--dsw-alias-label-secondary)}',
      '.dshIdleArm_ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshIdleArm_error{color:var(--dsw-alias-state-error-primary);margin-top:8px}'
    ].join('')

    /**
     * 提交键左侧的落盘拦截控件。
     *
     * 交互按既定设计：一个按钮 → 展开小面板配置起栏时间 → 确认后置位并自动提交。
     * 自动提交调用插槽注入的 `inputActions.submit()`，与用户按提交键走同一条提交
     * 流程（adjudication / claim / default sink 都在其中），因此不会凭空造一条旁路。
     * @param props - 插槽标准道具（sessionId / inputActions）与本地化函数 t。
     * @returns 控件元素。
     */
    function ArmControl({ sessionId, inputActions, useInput, t }) {
      const [open, setOpen] = React.useState(false)
      const [minutes, setMinutes] = React.useState(String(DEFAULT_MINUTES))
      const [pending, setPending] = React.useState(false)
      const [armedMinutes, setArmedMinutes] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)

      const position = primitives.useAnchoredPosition({
        open,
        anchorRef: rootRef,
        panelRef,
        gap: MENU_GAP,
        margin: VIEWPORT_MARGIN
      })
      primitives.useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

      // 输入框正在提交（adjudicating/claimed/submitting）时不再重复发起，避免与用户的
      // 提交撞车；队列里已有等待消息不影响本次提交，也不阻止它。
      const phase = useInput === undefined ? undefined : useInput((state) => state.phase)
      const submitting = phase !== undefined && phase !== 'plain'

      const close = () => {
        setOpen(false)
        setError(undefined)
      }

      const confirm = async () => {
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
          close()
          // 置位成功后才提交：先武装、再进入回合，宿主侧本回合即可按新曲线拦截。
          if (inputActions !== undefined && typeof inputActions.submit === 'function') inputActions.submit()
        } catch (cause) {
          setError(t('error.failed', { message: cause instanceof Error ? cause.message : String(cause) }))
        } finally {
          setPending(false)
        }
      }

      const armed = armedMinutes !== undefined
      const triggerLabel = armed
        ? t('trigger.armed', { minutes: armedMinutes })
        : t('trigger')

      return React.createElement('div', { className: CLASS.root, ref: rootRef },
        React.createElement('button', {
          type: 'button',
          className: armed ? `${CLASS.trigger} ${CLASS.triggerArmed}` : CLASS.trigger,
          'aria-label': t('trigger.aria'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          onClick: () => (open ? close() : setOpen(true))
        },
        React.createElement(primitives.IconClockOutlineRegular, { size: 16 }),
        triggerLabel),

        open === false ? null : ReactDOM.createPortal(
          React.createElement(primitives.MenuSurface, {
            ref: panelRef,
            className: CLASS.panel,
            style: position ?? MEASURE_STYLE,
            role: 'dialog',
            'aria-label': t('panel.title')
          },
          React.createElement('div', { className: CLASS.title }, t('panel.title')),
          React.createElement('div', { className: CLASS.field },
            React.createElement('label', { htmlFor: 'dsh-idle-arm-minutes' }, t('panel.minutes')),
            React.createElement('input', {
              id: 'dsh-idle-arm-minutes',
              className: CLASS.minutes,
              type: 'number',
              min: MIN_MINUTES,
              max: MAX_MINUTES,
              step: 1,
              value: minutes,
              disabled: pending,
              autoFocus: true,
              onChange: (event) => setMinutes(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void confirm()
                }
                if (event.key === 'Escape') close()
              }
            })
          ),
          React.createElement('div', { className: CLASS.hint }, t('panel.hint')),
          React.createElement('div', { className: CLASS.actions },
            React.createElement('button', {
              type: 'button',
              className: CLASS.ghost,
              disabled: pending,
              onClick: close
            }, t('action.cancel')),
            React.createElement('button', {
              type: 'button',
              className: CLASS.primary,
              disabled: pending || submitting || sessionId === undefined,
              onClick: () => void confirm()
            }, pending ? t('action.confirming') : t('action.confirm'))
          ),
          error === undefined ? null : React.createElement('div', { className: CLASS.error, role: 'alert' }, error)
        ),
        document.body)
      )
    }

    // 与 idle-guard.js 的 inject 对应：这里需要插槽表与本地化服务。
    const inject = ['slots', 'locale']

    /**
     * 客户端插件体：注册文案、样式与提交键左侧的落盘拦截控件。
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
