// soup-view 客户端半边。
//
// 把 soup 工具调用渲染成一行不可展开的标题。这是汤底「用户不可见」的唯一实现点：
// 通用工具行会把调用参数与结果正文都摊在展开区里，而 soup 的参数（face/base）和
// 结果正文里就是汤底，因此这里必须整个替换掉那条渲染路径，而不是给它加个折叠开关。
//
// 刻意不提供任何展开入口：不注册 useDisclosure、不读 block.content、不把参数写进
// DOM。隐藏的强度取决于「有没有一条路径能把文本读出来」，所以这里连 title 都只取
// action（open / recall / close），那三个词不含任何剧情。
//
// 模块身份：id 必须等于 package.json 的 name（client-modules 会校验
// window.__ModuleLoader__.load 注册的 id 与它在 boot manifest 里请求的 id 一致）。
window.__ModuleLoader__.load({
  id: 'dsh-plugin-soup-view',
  factory: (require) => {
    const React = require('react')

    const NS = 'soup-view'
    const zh = {
      'row.title': '海龟汤',
      'row.preparing': '正在封存',
      'row.open': '已封存汤底',
      'row.recall': '已取回汤底',
      'row.close': '已结束本局',
      'row.running': '处理中',
      'row.failed': '汤底操作失败',
      'row.stopped': '汤底操作已中止',
      'row.hidden': '汤底内容不对用户显示'
    }
    const en = {
      'row.title': 'Turtle soup',
      'row.preparing': 'Sealing',
      'row.open': 'Truth sealed',
      'row.recall': 'Truth recalled',
      'row.close': 'Round closed',
      'row.running': 'Working',
      'row.failed': 'Truth operation failed',
      'row.stopped': 'Truth operation stopped',
      'row.hidden': 'The truth is never shown to the user'
    }

    const CLASS = {
      row: 'dshSoupView_row',
      leading: 'dshSoupView_leading',
      title: 'dshSoupView_title',
      sep: 'dshSoupView_sep',
      summary: 'dshSoupView_summary',
      failed: 'dshSoupView_failed',
      hidden: 'dshSoupView_hidden'
    }
    const css = [
      '.dshSoupView_row{display:flex;align-items:center;min-width:0;height:calc(24px + var(--dsh-content-font-delta,0px));',
      'color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-family);',
      'font-size:var(--dsh-content-font-size-secondary,13px)}',
      '.dshSoupView_leading{display:inline-flex;align-items:center;justify-content:center;flex:none;',
      'width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));margin-right:6px}',
      '.dshSoupView_title{flex:none;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.dshSoupView_sep{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption)}',
      '.dshSoupView_summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:auto}',
      '.dshSoupView_failed{color:var(--dsw-alias-state-error-primary)}',
      // 供读屏软件读到的说明：视觉上不占位，但把「汤底被隐藏」这件事讲清楚。
      '.dshSoupView_hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;',
      'clip-path:inset(50%);white-space:nowrap;border:0}'
    ].join('')

    /**
     * 从已记录的调用参数里只取 action。参数里的 face / base 一个字都不读出来，
     * 因此即便解析失败也没有任何内容会漏到 DOM 上。
     * @param argsRaw - 原始参数 JSON 文本，可能不完整。
     * @returns 动作名，或 undefined。
     */
    function actionOf(argsRaw) {
      if (typeof argsRaw !== 'string' || argsRaw.length === 0) return undefined
      try {
        const parsed = JSON.parse(argsRaw)
        const action = parsed !== null && typeof parsed === 'object' ? parsed.action : undefined
        return typeof action === 'string' ? action : undefined
      } catch {
        return undefined
      }
    }

    /**
     * soup 调用行：一行标题，不可展开。
     * @param props - 插槽标准道具（phase / block / t）。
     * @returns 该行元素。
     */
    function SoupRow(props) {
      const { phase, block, t } = props
      const settled = phase === 'result'
      const argsRaw = settled ? block.call?.argsRaw : phase === 'start' ? block.argsRaw : undefined
      const action = actionOf(argsRaw)

      const state = settled
        ? block.error?.code === 'interrupted'
          ? 'stopped'
          : block.isError
            ? 'failed'
            : 'ok'
        : 'running'

      const summary = state === 'failed'
        ? t('row.failed')
        : state === 'stopped'
          ? t('row.stopped')
          : state === 'running'
            ? t('row.running')
            : action === 'open'
              ? t('row.open')
              : action === 'recall'
                ? t('row.recall')
                : action === 'close'
                  ? t('row.close')
                  : t('row.preparing')

      return React.createElement('div', { className: CLASS.row, 'data-tool': 'soup', 'data-state': state },
        React.createElement('span', { className: CLASS.leading, 'aria-hidden': true }, '🍲'),
        React.createElement('span', { className: CLASS.title }, t('row.title')),
        React.createElement('span', { className: CLASS.sep, 'aria-hidden': true }),
        React.createElement('span', { className: state === 'failed' ? `${CLASS.summary} ${CLASS.failed}` : CLASS.summary }, summary),
        React.createElement('span', { className: CLASS.hidden }, t('row.hidden')))
    }

    const inject = ['slots', 'locale']

    /**
     * 客户端插件体：注册文案、样式与 soup 专用行。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'soup-view: dictionaries')
      const tagId = 'dsh-plugin-soup-view/SoupRow.css'
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-plugin-soup-view'
        tag.dataset.pluginCss = tagId
        tag.textContent = css
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'soup-view: styles')
      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'soup',
        locale: NS
      }, SoupRow))
    }

    return { name: 'soup-view-client', inject, apply }
  }
})
