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
//
// 注入段包在文件外面的那些文字（标题、引导语）一律用英文：它们进的是系统提示词，
// 与 Harness 自带段落同语言；内容必须讲清三件事——这是被注入的提示词文件、每次请求都重新
// 从磁盘读所以永远是最新的、标题就是它相对项目根目录的路径，因此不必再去读一遍该文件，
// 否则只会把同样的正文重复搬进对话历史。
//
// 正文一字不改、一字不删：不截断，不省略中间段。注入的是一份文件，模型拿到的就该是这份
// 文件本身，缺一半的文件比不注入更容易把模型带错。token 开销由用户在敲命令前自己权衡，
// 插件只在执行时把体量报出来，供人判断——判断权在人，不在插件。

const nodePath = require('node:path')

/** 注入段在系统提示词里的名字。 */
const SECTION_NAME = 'inject:files'
/** 注入段的标题行。 */
const SECTION_TITLE = '# Injected files'
/**
 * 注入段的引导语。
 *
 * 进系统提示词的一切文字都用英文，与 Harness 自带段落保持同一语言，也让模型一眼分清
 * “这是文件内容”而不是用户刚说的话。这段话要挡住的是最典型的一种上下文浪费：模型看到
 * 一份文件正文，出于习惯再调一次读取工具，把同样的内容又搬进对话历史一遍——而这里的内容
 * 每次请求都会重新从磁盘读，本来就是最新的，重读没有任何收益。
 */
const SECTION_LEAD = [
  'The files below were injected into this prompt by the user (via the `/inject` command), not read by you.',
  'This section is rebuilt on **every** request by re-reading each file from disk: what you see here is always the current content, and any edit you make shows up here on the next request without further action.',
  'Each file is introduced by its path relative to the project root.',
  '',
  'Do not read these files again with your own tools. Their content is already in your context, so re-reading them would only duplicate text you already have — and you do not need to read a file before editing it either; edit it directly.',
  'Fall back to reading only if the user explicitly tells you the file changed on disk in a way this section does not reflect.',
].join('\n')
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

    /** 千分位，只为让回执里的字符数好读。 */
    const thousands = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

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
        // 每个文件一段，标题是它相对项目根目录的路径——模型据此知道自己在看哪个文件，
        // 不需要再读一次来确认。正文原样注入，不截断。
        parts.push('## `' + rel + '`\n\n' + sanitize(text))
      }
      if (parts.length === 0) return next()

      const assembled = await next()
      if (assembled.sections.some((section) => section.name === SECTION_NAME)) return assembled
      return {
        ...assembled,
        sections: [...assembled.sections, {
          name: SECTION_NAME,
          text: SECTION_TITLE + '\n\n' + SECTION_LEAD + '\n\n' + parts.join('\n\n'),
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
          if (accepted.some((item) => item.rel === rel)) continue
          const text = await readFile(cwd, rel)
          if (text === undefined) {
            problems.push(raw + '：读不到这个文件')
            continue
          }
          accepted.push({ rel, chars: text.length })
        }
        if (problems.length > 0) {
          return { kind: 'error', text: problems.join('\n') + '\n' + USAGE }
        }

        // 回执里报体量：正文原样注入、不做截断，token 开销由用户判断，这里只把数字摆出来。
        const total = accepted.reduce((sum, item) => sum + item.chars, 0)
        const listed = accepted.map((item) => item.rel + '（' + thousands(item.chars) + ' 字符）').join('、')
        return {
          kind: 'success',
          text: '已注入 ' + listed + '：合计 ' + thousands(total) + ' 字符，'
            + '每次模型调用都会带上这份内容，不进对话历史；文件改动下一次调用自动生效。用 /inject off 关闭。',
        }
      },
    })
  },
}
