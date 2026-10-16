'use strict'

module.exports = {
  name: 'create-filezone-inject',

  // 声明硬依赖：确保 fs（读文件）与 systemPrompt（装配器）就绪后才 apply
  inject: ['fs', 'systemPrompt'],

  apply(ctx) {
    const fs = ctx.get('fs')
    const systemPrompt = ctx.get('systemPrompt')
    if (fs === undefined || systemPrompt === undefined) {
      console.error('[create-filezone-inject] 缺少 fs/systemPrompt 服务，插件未激活')
      return
    }

    // ── 文件区清单（相对会话工作区）──────────────────────────────────────
    // 后续扩展：在此追加文件名即可
    const FILEZONE = ['宇宙分类协议.md']

    const SECTION_NAME = 'create:filezone'
    const SECTION_TITLE = '# 文件区'

    // 中和 {{…}}：系统提示词渲染时 {{变量}} 会被严格插值，未知变量会抛错并
    // 中断模型请求；文件可被随意编辑，因此用零宽空格打断花括号对，避免破坏装配。
    const sanitize = (text) => text.replaceAll('{{', '{\u200b{').replaceAll('}}', '}\u200b}')

    // 每次模型调用装配系统提示词时，实时读取文件区并注入。
    // 未加 global: true——事件从会话冒泡到本预设的常驻作用域，
    // 因此只对本预设（create）的会话生效，不污染其他预设。
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
          console.error(`[create-filezone-inject] 读取失败：${rel}（${error instanceof Error ? error.message : String(error)}）`)
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
