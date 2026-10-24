// prompt-forge 客户端半边。
//
// 一个按钮 + 一个小面板，挂在会话输入框右侧（conversation.input.right）：
//
//   按钮      草稿非空 → 一键改写；改写完成 → 点一下撤销回原文
//   面板      改强度（重述 / 增量 / 结构化）、选模板、看结果、填入输入框
//
// 契约要点（每条都对应一个会静默失败的坑）：
//
// · 草稿读 props.useInput((s) => s).draft，写 props.inputActions.setDraft(text)。
//   会话级槽位只提供注入的选择器 hook（没有 props.session / props.input）；
//   但 hook 不能条件调用 —— 所以「有没有这个 hook」必须由 props 上是否存在函数
//   决定，且在所有分支里 hook 调用序保持一致。
//
// · 改写结果一律经 setDraft 写回输入框，不直接发消息：用户要能先看一眼、改两个字。
//
// · 组件卸载不解绑在途请求（用户切会话后仍应拿到结果），只清理本组件的 UI 状态。
//
// · 面板用 position:fixed 是必需的，不是样式偏好：useAnchoredPosition 返回视口坐标，
//   只有 fixed 才把它当视口定位。缺少它面板会被推到页面下方几千像素处。
//
// 模块身份：id 必须等于 package.json 的 name（client-modules 会校验
// window.__ModuleLoader__.load 注册的 id 与它在 boot manifest 里请求的 id 一致）。
window.__ModuleLoader__.load({
  id: 'dsh-plugin-prompt-forge',
  factory: (require) => {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** 宿主端点。相对路径，由浏览器按当前页面地址解析。 */
    const ROUTE = {
      run: 'api/forge/run',
      build: 'api/forge/build',
      meta: 'api/forge/meta',
      latest: 'api/forge/latest',
    }

    const NS = 'prompt-forge'
    const VIEWPORT_MARGIN = 12
    const MENU_GAP = 5
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }

    const zh = {
      'trigger': '改写',
      'trigger.busy': '改写中',
      'trigger.undo': '撤销',
      'trigger.aria': '提示词改写',
      'panel.title': '提示词锻造',
      'panel.mode': '强度',
      'panel.template': '模板',
      'panel.template.none': '（不用模板）',
      'panel.hint': '改写结果会填入输入框，可先编辑再发送。',
      'panel.empty': '输入框里没有内容。先写一句话，再点「改写」。',
      'action.run': '改写',
      'action.running': '改写中…',
      'action.fill': '填入输入框',
      'action.undo': '撤销',
      'action.close': '关闭',
      'mode.rewrite': '重述',
      'mode.augment': '增量',
      'mode.structure': '结构化',
      'mode.rewrite.desc': '只把话说明白，不加原文没有的信息',
      'mode.augment.desc': '保守补充缺失的大逻辑（默认）',
      'mode.structure.desc': '产出七段结构化提示词',
      'error.failed': '改写失败：{message}',
      'error.empty': '输入框里没有内容',
    }
    const en = {
      'trigger': 'Forge',
      'trigger.busy': 'Forging',
      'trigger.undo': 'Undo',
      'trigger.aria': 'Prompt forge',
      'panel.title': 'Prompt forge',
      'panel.mode': 'Strength',
      'panel.template': 'Template',
      'panel.template.none': '(no template)',
      'panel.hint': 'The result goes into the composer so you can edit before sending.',
      'panel.empty': 'The composer is empty. Write a line first, then press Forge.',
      'action.run': 'Forge',
      'action.running': 'Forging…',
      'action.fill': 'Insert',
      'action.undo': 'Undo',
      'action.close': 'Close',
      'mode.rewrite': 'Restate',
      'mode.augment': 'Augment',
      'mode.structure': 'Structure',
      'mode.rewrite.desc': 'Say the same thing more clearly; add nothing new',
      'mode.augment.desc': 'Conservatively add missing high-level logic (default)',
      'mode.structure.desc': 'Produce a seven-section structured prompt',
      'error.failed': 'Forge failed: {message}',
      'error.empty': 'The composer is empty',
    }

    const CLASS = {
      root: 'dshForge_root',
      trigger: 'dshForge_trigger',
      triggerActive: 'dshForge_triggerActive',
      panel: 'dshForge_panel',
      title: 'dshForge_title',
      row: 'dshForge_row',
      label: 'dshForge_label',
      select: 'dshForge_select',
      hint: 'dshForge_hint',
      result: 'dshForge_result',
      actions: 'dshForge_actions',
      primary: 'dshForge_primary',
      ghost: 'dshForge_ghost',
      error: 'dshForge_error',
    }

    // 只声明本插件真正用到的样式；用主题令牌取色，跟随宿主明暗主题。
    const css = [
      '.dshForge_root{display:inline-flex;align-items:center;flex:none;position:relative}',
      '.dshForge_trigger{display:inline-flex;align-items:center;gap:4px;box-sizing:border-box;height:28px;',
      'padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);',
      'background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;',
      'font-family:var(--dsw-font-family);font-size:12px;line-height:18px;white-space:nowrap}',
      '.dshForge_trigger:hover:not(:disabled),.dshForge_trigger:focus-visible{',
      'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshForge_trigger:disabled{cursor:default;opacity:.6}',
      '.dshForge_triggerActive{color:var(--dsw-alias-label-primary-bluish);border-color:var(--dsw-alias-button-info-fill)}',
      '.dshForge_panel{position:fixed;z-index:100;box-sizing:border-box;width:340px;padding:12px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
      'font-family:var(--dsw-font-family);font-size:12px;line-height:18px;',
      'box-shadow:0 6px 24px rgba(0,0,0,.18)}',
      '.dshForge_title{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);margin-bottom:8px}',
      '.dshForge_row{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
      '.dshForge_label{color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}',
      '.dshForge_select{box-sizing:border-box;flex:1;height:28px;padding:0 6px;',
      'border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);',
      'background:0 0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:12px}',
      '.dshForge_hint{color:var(--dsw-alias-label-tertiary);margin-bottom:10px}',
      '.dshForge_result{box-sizing:border-box;max-height:220px;overflow:auto;margin-bottom:10px;padding:8px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);',
      'background:var(--dsw-alias-bg-l1);color:var(--dsw-alias-label-primary);',
      'font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word}',
      '.dshForge_actions{display:flex;justify-content:flex-end;gap:8px}',
      '.dshForge_primary,.dshForge_ghost{box-sizing:border-box;height:28px;padding:0 10px;',
      'border-radius:var(--dsw-radius-sm);cursor:pointer;font-family:var(--dsw-font-family);font-size:12px}',
      '.dshForge_primary{border:.5px solid var(--dsw-alias-button-info-fill);',
      'background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-inverted)}',
      '.dshForge_primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover);border-color:var(--dsw-alias-button-info-hover)}',
      '.dshForge_primary:disabled{cursor:default;opacity:.6}',
      '.dshForge_ghost{border:.5px solid var(--dsw-alias-border-l4);background:0 0;color:var(--dsw-alias-label-secondary)}',
      '.dshForge_ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshForge_error{color:var(--dsw-alias-state-error-primary);margin-top:8px}',
    ].join('')

    /** 把 {placeholder} 替换成实际值（极简模板，够用）。 */
    function fmt(text, vars) {
      if (vars === undefined) return text
      return String(text).replace(/\{(\w+)\}/g, (all, key) => (vars[key] === undefined ? all : String(vars[key])))
    }

    /**
     * 输入框右侧的改写控件。
     *
     * 交互：草稿非空 → 点按钮直接改写（用当前强度）；改写完成 → 按钮变成「撤销」；
     * 想换强度或选模板 → 点按钮右侧展开面板（这里用一个按钮两态：有结果时点开面板，
     * 无结果时直接跑）。为了不让一个按钮承担太多，最终做成：**按钮恒开面板**，
     * 面板里「改写」是主操作 —— 这样不会误触发一次要花钱的模型调用。
     */
    function ForgeControl({ sessionId, inputActions, useInput, t }) {
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState('')
      const [backup, setBackup] = React.useState('')
      const [error, setError] = React.useState('')
      const [mode, setMode] = React.useState('augment')
      const [template, setTemplate] = React.useState('')
      const [meta, setMeta] = React.useState(null)
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)
      // 请求序号：只认最后一次点击的结果，过期的响应直接丢。
      const seqRef = React.useRef(0)
      // 卸载后不再 setState（用户切走会话时组件会卸载）。
      const aliveRef = React.useRef(true)
      React.useEffect(() => () => { aliveRef.current = false }, [])

      const position = primitives.useAnchoredPosition({
        open,
        anchorRef: rootRef,
        panelRef,
        gap: MENU_GAP,
        margin: VIEWPORT_MARGIN,
      })
      primitives.useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

      // 只调一次 useInput，一次拿齐 phase 与 draft。
      //
      // 分开写两个 useInput(...) 会让 hook 调用序依赖 useInput 是否存在 —— 而它
      // 恰恰是「会话存在与否」的函数，会随会话切换变化。取整个快照再在渲染期取值，
      // 序就恒定了。
      const snapshot = useInput === undefined ? undefined : useInput((state) => state)
      const phase = snapshot === undefined ? undefined : snapshot.phase
      const draft = snapshot === undefined || typeof snapshot.draft !== 'string' ? '' : snapshot.draft
      const submitting = phase !== undefined && phase !== 'plain'

      // 面板首次打开时拉一次元信息（强度清单 / 模板清单）。
      React.useEffect(() => {
        if (!open || meta !== null) return
        let cancelled = false
        fetch(ROUTE.meta, { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : undefined))
          .then((payload) => {
            if (cancelled || !aliveRef.current || !payload || payload.ok !== true) return
            setMeta(payload)
            if (typeof payload.defaultMode === 'string') setMode(payload.defaultMode)
          })
          .catch(() => { /* 元信息失败不影响主操作，强度下拉用内置文案 */ })
        return () => { cancelled = true }
      }, [open, meta])

      const close = () => {
        setOpen(false)
        setError('')
      }

      const applyDraft = (text) => {
        if (inputActions !== undefined && typeof inputActions.setDraft === 'function') inputActions.setDraft(text)
      }

      const undo = () => {
        applyDraft(backup)
        setResult('')
        setError('')
      }

      const run = async () => {
        if (busy) return
        const text = String(draft || '').trim()
        if (text === '') {
          setError(t('error.empty'))
          return
        }
        seqRef.current += 1
        const seq = seqRef.current
        setBusy(true)
        setError('')
        setBackup(draft)
        try {
          const response = await fetch(ROUTE.run, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, mode, template }),
          })
          const payload = await response.json().catch(() => undefined)
          // 过期响应（用户又点了一次）直接丢弃。
          if (seq !== seqRef.current || !aliveRef.current) return
          if (payload === undefined || payload.ok !== true) {
            const message = payload !== undefined && typeof payload.text === 'string' && payload.text !== ''
              ? payload.text
              : 'HTTP ' + String(response.status)
            setError(fmt(t('error.failed'), { message }))
            return
          }
          setResult(payload.text)
          // 结果直接写进输入框：用户能立刻看到、也能先改两个字再发。
          applyDraft(payload.text)
        } catch (cause) {
          if (seq !== seqRef.current || !aliveRef.current) return
          setError(fmt(t('error.failed'), { message: cause instanceof Error ? cause.message : String(cause) }))
        } finally {
          if (aliveRef.current && seq === seqRef.current) setBusy(false)
        }
      }

      const hasResult = result !== ''
      const triggerLabel = busy ? t('trigger.busy') : hasResult ? t('trigger.undo') : t('trigger')
      const templates = meta !== null && Array.isArray(meta.templates) ? meta.templates : []
      const modeItems = [
        { id: 'rewrite', label: t('mode.rewrite') },
        { id: 'augment', label: t('mode.augment') },
        { id: 'structure', label: t('mode.structure') },
      ]

      const onTrigger = () => {
        // 有结果时按钮就是撤销：一次点击回到原文，不弹面板。
        if (hasResult && !busy) {
          undo()
          return
        }
        setOpen(!open)
      }

      return React.createElement('div', { className: CLASS.root, ref: rootRef },
        React.createElement('button', {
          type: 'button',
          className: hasResult ? CLASS.trigger + ' ' + CLASS.triggerActive : CLASS.trigger,
          'aria-label': t('trigger.aria'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          disabled: busy === false && submitting === true,
          onClick: onTrigger,
        }, triggerLabel),

        open === false ? null : ReactDOM.createPortal(
          React.createElement(primitives.MenuSurface, {
            ref: panelRef,
            className: CLASS.panel,
            style: position !== undefined && position !== null ? position : MEASURE_STYLE,
            role: 'dialog',
            'aria-label': t('panel.title'),
          },
          React.createElement('div', { className: CLASS.title }, t('panel.title')),

          React.createElement('div', { className: CLASS.row },
            React.createElement('label', { className: CLASS.label, htmlFor: 'dsh-forge-mode' }, t('panel.mode')),
            React.createElement('select', {
              id: 'dsh-forge-mode',
              className: CLASS.select,
              value: mode,
              disabled: busy,
              onChange: (event) => setMode(event.target.value),
            }, modeItems.map((item) => React.createElement('option', { key: item.id, value: item.id }, item.label)))
          ),

          React.createElement('div', { className: CLASS.row },
            React.createElement('label', { className: CLASS.label, htmlFor: 'dsh-forge-template' }, t('panel.template')),
            React.createElement('select', {
              id: 'dsh-forge-template',
              className: CLASS.select,
              value: template,
              disabled: busy,
              onChange: (event) => setTemplate(event.target.value),
            }, [
              React.createElement('option', { key: '', value: '' }, t('panel.template.none')),
              ...templates.map((item) => React.createElement('option', { key: item.id, value: item.id }, item.label)),
            ])
          ),

          React.createElement('div', { className: CLASS.hint }, t('panel.hint')),

          hasResult
            ? React.createElement('pre', { className: CLASS.result }, result)
            : null,

          React.createElement('div', { className: CLASS.actions },
            React.createElement('button', {
              type: 'button',
              className: CLASS.ghost,
              disabled: busy,
              onClick: close,
            }, t('action.close')),
            hasResult
              ? React.createElement('button', {
                  type: 'button',
                  className: CLASS.ghost,
                  disabled: busy,
                  onClick: undo,
                }, t('action.undo'))
              : null,
            React.createElement('button', {
              type: 'button',
              className: CLASS.primary,
              disabled: busy || submitting || sessionId === undefined,
              onClick: () => void run(),
            }, busy ? t('action.running') : t('action.run'))
          ),

          error === '' ? null : React.createElement('div', { className: CLASS.error, role: 'alert' }, error)
        ), document.body)
      )
    }

    const inject = ['slots', 'locale']

    /**
     * 客户端插件体：注册文案、样式与输入框右侧的改写控件。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      // locale 注册可能因页面残留旧实例而撞车，吞掉冲突但不吞样式与槽位。
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { zh, en })
        } catch {
          return undefined
        }
      }, 'prompt-forge: dictionaries')

      const tagId = 'dsh-plugin-prompt-forge/ForgeControl.css'
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-plugin-prompt-forge'
        tag.dataset.pluginCss = tagId
        tag.textContent = css
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }, 'prompt-forge: styles')

      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'prompt-forge',
        order: 20,
        locale: NS,
      }, ForgeControl))
    }

    return { name: 'prompt-forge-client', inject, apply }
  },
})
