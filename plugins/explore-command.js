'use strict'

// explore-command.js —— 工作区项目全面探索插件 (/explore)
//
// 与 /reflect 的分工：
//   /reflect  面向「会话历史」——萃取经验，沉淀为 Skill；
//   /explore  面向「代码仓库」——通读实现，沉淀为 PROJECT.md。
// 两者都是「注册命令 + steer 一个带完整指令的模型回合」，不引入任何新的工具面。
const fs = require('node:fs')
const path = require('node:path')

/**
 * 解析项目根目录：向上取最近的含 .git 的祖先目录。
 *
 * 不能用 cwd 直接当项目根：DSH 的 skill 发现、git 相关行为都以仓库根为准，
 * 而会话 cwd 可能是仓库的子目录。找不到 .git 时回退到 cwd 本身。
 * @param cwd - 会话工作目录。
 * @returns 项目根绝对路径；cwd 无效时返回空串。
 */
function resolveProjectRoot(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return ''
  const base = path.resolve(cwd)
  let current = base
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return base
    current = parent
  }
}

module.exports = {
  name: 'command-explore',
  inject: ['commands'],

  apply(ctx) {
    const commands = ctx.get('commands')
    if (!commands) return

    commands.register({
      name: 'explore',
      description: '全面探索当前工作区项目的架构与实现，产出一份完善的 PROJECT.md',
      input: { hint: '[可选：聚焦方向，如「数据流」「插件系统」]' },
      handler: async ({ agent, rawInput }) => {
        if (!agent || !agent.session) {
          return { kind: 'error', text: '无法获取当前会话的 Agent 实例。' }
        }

        const cwd = agent.session.header?.cwd
        const projectRoot = resolveProjectRoot(cwd)
        if (projectRoot === '') {
          return { kind: 'error', text: '当前会话未设置工作目录，无法定位项目根目录。' }
        }

        const targetFile = path.join(projectRoot, 'PROJECT.md')
        let existing = false
        try {
          existing = fs.statSync(targetFile).isFile()
        } catch (err) {
          existing = false
        }

        const focus = rawInput ? rawInput.trim() : ''

        const promptLines = [
          `# Project Exploration — Produce PROJECT.md`,
          ``,
          `Explore this project's architecture and implementation thoroughly, then write a complete \`PROJECT.md\`.`,
          ``,
          `- Project root: ${projectRoot}`,
          `- Output file: ${targetFile}`,
          existing
            ? `- **This file already exists.** Read it in full first. Keep what is still accurate and keep any hand-written sections as they are; add what this exploration newly establishes. Do not replace it with a rewrite that loses existing content.`
            : `- **This file does not exist yet.** Create it.`,
          focus ? `- **User-requested focus: ${focus}** — still cover the whole project, but go deeper here than anywhere else.` : '',
          ``,
          `## Method`,
          ``,
          `1. **Map the shape first.** List the tree, skipping generated and vendored directories (\`node_modules\`, \`.git\`, \`dist\`, \`build\`, caches). Read the package manifest, build and bundler config, language and framework config, CI config, and any top-level docs.`,
          `2. **Find the boundaries.** Locate the entry points, the external surfaces (CLI arguments, HTTP routes, exported API, plugin registration points), where configuration is read, and where state is persisted.`,
          `3. **Read the implementation.** Open the files that actually carry the logic. Determine the real data flow and control flow from the code, never from filenames, comments, or directory names alone.`,
          `4. **Verify every claim.** Each statement in the document must be traceable to a file you read. Where comments or docs disagree with the code, the code is correct — and say so. Where you could not confirm something, mark it explicitly as unverified. Never fill a gap by guessing.`,
          `5. **Cover at minimum:** entry points, core modules, data model, configuration, build and run procedure, external dependencies and integration points.`,
          ``,
          `## What PROJECT.md must contain`,
          ``,
          `1. **What this is** — the problem it solves, who it is for, what stage it is at.`,
          `2. **Stack** — language, runtime and version requirements, frameworks, key third-party dependencies, each with the file that establishes it.`,
          `3. **Layout** — the responsibility of each significant directory and file, against real paths.`,
          `4. **Architecture** — module boundaries, dependency direction, and the core data flow. Use a diagram (mermaid or ASCII) when prose would be slower to read.`,
          `5. **Key mechanisms** — how the important parts actually work: protocols, algorithms, state management, concurrency, error handling.`,
          `6. **Build and run** — the exact commands for install, build, start, test, and package, plus their prerequisites.`,
          `7. **Conventions and extension points** — code style, naming, and how to add a module, plugin, or endpoint.`,
          `8. **Constraints and traps** — platform limits, known defects, easy mistakes, unfinished areas.`,
          ``,
          `Adapt these sections to the project. Drop any that do not apply rather than padding them.`,
          ``,
          `## Writing rules`,
          ``,
          `- Use the filesystem and search tools (\`read\`, \`glob\`, \`grep\`) to read the source, then \`write\` or \`edit\` to land the result. Nothing counts until it is on disk.`,
          `- On a large project, write the document section by section as you finish exploring each area, instead of reading everything before writing anything.`,
          `- Density over length. The document should be worth more than the time it takes to read.`,
          `- Prefer concrete specifics — exact commands, real paths, actual version numbers, real function names — over general description.`,
          `- No filler, no disclaimers, no directory listing restated as prose to look thorough.`,
          `- Match the language of the project's existing documentation. If there is none, write in Chinese.`,
          ``,
          `## Finish`,
          ``,
          `Report what you covered, the most important things the reader should know, and anything you could not verify.`,
        ].filter(Boolean).join('\n')

        const summary = focus ? `已触发 /explore (聚焦: ${focus})` : `已触发 /explore (项目全面探索)`

        try {
          agent.steer({
            id: `explore:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
            role: 'user',
            content: [{ type: 'text', text: promptLines }],
            source: { kind: 'plugin:command-explore', form: 'notice', summary },
          })
        } catch (error) {
          return {
            kind: 'error',
            text: `无法启动探索轮次：${error instanceof Error ? error.message : String(error)}`,
          }
        }

        return {
          kind: 'success',
          text: `已触发【项目探索】流程：\n- 项目根目录：${projectRoot}\n- 产出文件：${targetFile}${existing ? '（已存在，将增量完善而非覆盖）' : '（新建）'}\n模型正在通读源码，完成后会写入该文件并汇报结论。`,
        }
      },
    })
  },
}
