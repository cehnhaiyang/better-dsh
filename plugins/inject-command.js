'use strict'

// inject-command.js —— 文件注入命令（/inject，宿主级）
//
// 用法：
//   /inject <路径> [<路径>…]   把指定文件的内容注入系统提示词
//   /inject off                关闭注入
//
// 路径相对于会话工作区（项目根目录），多个路径用空白分隔。
//
// 为什么是斜杠命令而不是模型工具：注入哪些文件属于用户的判断，注入的内容会随每次
// 模型调用常驻系统提示词、并计入上下文压力。交给模型就等于模型可以自行决定往提示词
// 里塞什么；做成命令后只有用户在输入框敲 /inject 才会发生，模型既看不到也调不到。
//
// 为什么注入系统提示词的 sections 而不是发一条消息：sections 不属于 messages，
// 天然不进对话历史，也就不会被压缩器折叠掉。文件内容改了，下一次模型调用自动读到
// 新内容，不需要重新执行命令。
//
// 状态存在会话日志里，不在内存里：/inject 的每次成功执行本身就是一条 command/run
// 事件，参数原样记在 args 上。因此这里不维护任何额外状态——装配时回放日志、取最后一次
// 成功的参数即可。会话恢复、分叉、重开都自然继承，插件重启也不会丢。

const nodePath = require('node:path')

/** 注入段在系统提示词里的名字。 */
const SECTION_NAME = 'inject:files'
/** 注入段的标题行。 */
const SECTION_TITLE = '# 注入文件'
/** 单个文件的字符上限：超出部分截断并注明，避免一个超大文件把上下文打满。 */
const MAX_FILE_CHARS = 262144
/** 用法提示，错误时原样回给用户。 */
const USAGE = '用法：/inject <相对项目根目录的文件路径>（多个用空格分隔）· /inject off（关闭注入）'

module.exports = {
  name: 'command-inject',
  inject: ['commands', 'systemPrompt', 'fs'],

  apply(ctx) {
    const commands = ctx.get('commands')
    const systemPrompt = ctx.get('systemPrompt')
    const fs = ctx.get('fs')
    if (!commands || !systemPrompt || !fs) {
      console.error('[command-inject] 缺少 commands/systemPrompt/fs 服务，插件未激活')
      return
    }

    /**
     * 解析命令参数。
     *
     * off 是唯一的保留字，其余一律按空白切成路径列表。路径里可以有空格以外的任何字符，
     * 包括逗号、引号、括号——本命令不解释它们，只做切分。
     * @param {string} raw - 命令的原始参数。
     * @returns {string[] | undefined} 路径列表（off 为空数组）；参数为空时返回 undefined。
     */
    const parseArgs = (raw) => {
      const text = typeof raw === 'string' ? raw.trim() : ''
      if (text.length === 0) return undefined
      if (text.toLowerCase() === 'off') return []
      return text.split(/\s+/).filter((item) => item.length > 0)
    }

    /**
     * 会话 → 回放进度。装配钩子每次模型调用都跑一次，长会话日志上千条，每次从头
     * 扫一遍纯属浪费；日志只追加，因此记住扫到哪、增量往下扫即可。
     */
    const replay = new WeakMap()

    /**
     * 回放会话日志，取出当前生效的注入清单。
     *
     * 只认成功结束的那次执行：参数先记在 command/run 上，command/done 报 success 才采纳。
     * 因此执行失败（路径不存在等）不会改变注入状态，与用户看到的报错一致。
     * @param {object} session - 会话对象。
     * @returns {string[]} 注入清单；没有注入时为空数组。
     */
    const stateOf = (session) => {
      const cached = replay.get(session) ?? { scanned: 0, paths: [], pending: new Map() }
      const events = session.snapshotEvents(cached.scanned)
      for (const event of events) {
        const data = event.data
        if (event.type === 'command/run') {
          if (data.name === 'inject' && typeof data.commandId === 'string') {
            cached.pending.set(data.commandId, typeof data.args === 'string' ? data.args : '')
          }
        } else if (event.type === 'command/done') {
          if (!cached.pending.has(data.commandId)) continue
          const args = cached.pending.get(data.commandId)
          cached.pending.delete(data.commandId)
          if (data.kind !== 'success') continue
          const parsed = parseArgs(args)
          if (parsed !== undefined) cached.paths = parsed
        }
      }
      cached.scanned += events.length
      replay.set(session, cached)
      return cached.paths
    }

    /**
     * 把一项用户给出的路径解析成工作区内的相对路径。
     *
     * 这是本命令的信任边界：注入的内容会直接进系统提示词，路径必须落在项目根目录之内。
     * 绝对路径与上跳穿越一律拒绝，而不是交给 fs 服务去猜。
     * @param {string} cwd - 会话工作区根目录。
     * @param {string} raw - 用户给出的路径。
     * @returns {string | undefined} 规整后的相对路径；越界时返回 undefined。
     */
    const insideWorkspace = (cwd, raw) => {
      if (nodePath.isAbsolute(raw)) return undefined
      const base = nodePath.resolve(cwd)
      const target = nodePath.resolve(base, raw)
      const rel = nodePath.relative(base, target)
      if (rel === '' || rel === '..' || rel.startsWith('..' + nodePath.sep) || nodePath.isAbsolute(rel)) return undefined
      return rel.split(nodePath.sep).join('/')
    }

    /** 中和花括号对：系统提示词渲染时双花括号会被严格插值，未知变量会中断请求。 */
    const sanitize = (text) => text.replaceAll('{{', '{\u200b{').replaceAll('}}', '}\u200b}')

    /** 按字符上限截断，并在正文末尾注明被截断。 */
    const clip = (text) => (text.length <= MAX_FILE_CHARS
      ? text
      : text.slice(0, MAX_FILE_CHARS) + '\n\n（文件过长，仅注入前 ' + String(MAX_FILE_CHARS) + ' 字符）')

    /**
     * 读取一个注入文件。
     * @param {string} cwd - 会话工作区根目录。
     * @param {string} rel - 工作区内的相对路径。
     * @returns {Promise<string | undefined>} 文件正文；读不到时返回 undefined。
     */
    const readFile = async (cwd, rel) => {
      try {
        const target = await fs.resolve(rel, { cwd })
        const info = await fs.stat(target)
        if (info === undefined || info.type !== 'file') return undefined
        return await fs.readText(target)
      } catch (error) {
        return undefined
      }
    }

    // 每次模型调用装配系统提示词时，按当前注入清单实时读取文件。
    // global: true：本插件挂在宿主层，需要看到所有会话的装配事件。
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const agent = context.agent
      if (agent === undefined) return next()
      const cwd = agent.session.header.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) return next()
      const paths = stateOf(agent.session)
      if (paths.length === 0) return next()

      const parts = []
      for (const rel of paths) {
        const text = await readFile(cwd, rel)
        if (text === undefined) {
          console.error('[command-inject] 读取失败，本次跳过：' + rel)
          continue
        }
        parts.push('## ' + rel + '\n\n' + sanitize(clip(text)))
      }
      if (parts.length === 0) return next()

      const assembled = await next()
      if (assembled.sections.some((section) => section.name === SECTION_NAME)) return assembled
      return {
        ...assembled,
        sections: [...assembled.sections, {
          name: SECTION_NAME,
          text: SECTION_TITLE + '\n\n' + parts.join('\n\n'),
        }],
      }
    }, { global: true })

    commands.register({
      name: 'inject',
      description: '把项目内文件的内容注入系统提示词（参数为相对项目根目录的路径，off 关闭）',
      input: { hint: '<路径> [<路径>…] | off' },
      handler: async ({ agent, rawInput }) => {
        const cwd = agent.session.header.cwd
        if (typeof cwd !== 'string' || cwd.length === 0) {
          return { kind: 'error', text: '当前会话没有工作目录，无法解析文件路径。' }
        }
        const paths = parseArgs(rawInput)
        if (paths === undefined) return { kind: 'error', text: '缺少参数。' + USAGE }

        if (paths.length === 0) {
          const current = stateOf(agent.session)
          return {
            kind: 'success',
            text: current.length === 0
              ? '当前没有注入任何文件，无需关闭。'
              : '已关闭文件注入：' + current.join('、') + ' 不再进入系统提示词。',
          }
        }

        const accepted = []
        const problems = []
        for (const raw of paths) {
          const rel = insideWorkspace(cwd, raw)
          if (rel === undefined) {
            problems.push(raw + '：不在项目根目录之内')
            continue
          }
          if (accepted.includes(rel)) continue
          const text = await readFile(cwd, rel)
          if (text === undefined) {
            problems.push(raw + '：读不到这个文件')
            continue
          }
          accepted.push(rel)
        }
        if (problems.length > 0) {
          return { kind: 'error', text: problems.join('\n') + '\n' + USAGE }
        }

        return {
          kind: 'success',
          text: '已注入 ' + accepted.join('、') + '：内容随每次模型调用进入系统提示词，不进对话历史；'
            + '文件改动下一次调用自动生效。用 /inject off 关闭。',
        }
      },
    })
  },
}
