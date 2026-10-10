'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// inject-filezone.js —— 俱乐部文件区注入插件（预设级，club-literature）
//
// 目标：文件区的全部内容随每次对话存在（注入系统提示词），
// 但绝不进入对话历史：sections 不属于 messages，天然不被压缩器折叠。
// 压缩阈值的计价口径见 ~/.dsh/.js 的 4.3 号补丁：按 surface（系统提示词 +
// 会话消息）判断，而系统提示词正是文件区的宿主，所以文件区大小会照实计入压力。
// 补丁剔除的是「工具 schema 与 provider 用量漂移」那一份额外压力，并非剔除文件区；
// 旧注释所称的「压缩压力已剔除系统提示词」（patch-compaction.js，该外置脚本已并入
// ~/.dsh/.js）自 0.1.6 起不再成立。
//
// 用法：扩展文件区只需向下方 FILEZONE 数组追加相对会话工作区的路径；
// 修改文件内容后，下一次模型调用自动生效，无需更新插件或配置。
//
// 当前文件区：
//   - 设定/法典.md（《法典》全文）
//
// 挂载：agent.cordis.yml 中（tool-fs 之后）。本文件是编辑源，~/.dsh/.js 会把它
// 复制到 profiles/web/preset-assets/club-literature/ 并把声明里的引用改写成该路径：
//   - id: filezone-inject
//     name: './preset-assets/club-literature/inject-filezone.js'
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  name: 'club-literature-filezone-inject',

  // 声明硬依赖：确保 fs（读文件）与 systemPrompt（装配器）就绪后才 apply
  inject: ['fs', 'systemPrompt'],

  apply(ctx) {
    const fs = ctx.get('fs')
    const systemPrompt = ctx.get('systemPrompt')
    if (fs === undefined || systemPrompt === undefined) {
      console.error('[club-literature-filezone-inject] 缺少 fs/systemPrompt 服务，插件未激活')
      return
    }

    // ── 文件区清单（相对会话工作区，即 D:\文档\俱乐部）──────────────────
    // 后续扩展：在此追加文件名即可，例如 '设定/人物卡.md'
    const FILEZONE = ['设定/法典.md']

    const SECTION_NAME = 'club-literature:filezone'
    const SECTION_TITLE = '# 文件区（随对话常驻注入，工作区实时加载）'

    // 中和 {{…}}：系统提示词渲染时 {{变量}} 会被严格插值，未知变量会抛错并
    // 中断模型请求；文件可被随意编辑，因此用零宽空格打断花括号对，避免破坏装配。
    const sanitize = (text) => text.replaceAll('{{', '{\u200b{').replaceAll('}}', '}\u200b}')

    // 每次模型调用装配系统提示词时，实时读取文件区并注入。
    // 未加 global: true——事件从会话冒泡到本预设的常驻作用域，
    // 因此只对本预设（club-literature）的会话生效，不污染其他预设。
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const agent = context.agent
      const cwd = agent === undefined ? undefined : agent.session.header.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) return next()

      // 逐个读取文件区文件；单个失败只跳过该文件，不阻断装配
      const parts = []
      for (const rel of FILEZONE) {
        try {
          const target = await fs.resolve(rel, { cwd })
          const text = await fs.readText(target)
          parts.push(`## ${rel}\n\n${sanitize(text)}`)
        } catch (error) {
          console.error(`[club-literature-filezone-inject] 读取失败：${rel}（${error instanceof Error ? error.message : String(error)}）`)
        }
      }
      if (parts.length === 0) return next()

      const assembled = await next()
      if (assembled.sections.some((section) => section.name === SECTION_NAME)) return assembled
      return {
        ...assembled,
        sections: [...assembled.sections, {
          name: SECTION_NAME,
          text: `${SECTION_TITLE}\n\n${parts.join('\n\n')}`,
        }],
      }
    })
  },
}
