'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// browser.js —— test 预设的 browser 工具（零依赖本地插件）
//
// 设计原则（唯一职责）：
//   在【不向模型暴露任何命令行工具】的前提下，给模型一个「开浏览器」的按钮。
//   模型写前端、调样式、验证交互时，调用 browser；本工具把动作翻译成一次
//   agent-browser CLI 调用，把输出原样返回。
//
// 为什么复用 agent-browser 而不是自己接 CDP：
//   它已经把「启动 Chrome → 连 CDP → 无障碍树快照（@eN 引用）→ 动作」这条链
//   做完并常驻守护进程，模型拿到的是 200~400 token 的紧凑快照而不是整页 HTML。
//   自己接 CDP 等于重写它，且要自己处理版本探测、端口分配、进程回收。
//
// 为什么裸注册、不 import defineTool：
//   本文件被 ~/.dsh/.js 复制到 profile 的 preset-assets/test/ 下（编辑源在
//   用户预设目录），两处都不在任何 node_modules 链上，`import '@deepseek-ai/dsh-tools'`
//   必然失败。ctx.tools.register() 直接接受原始 JSON Schema 定义，因此本文件
//   只用 node 内置模块。
//
// 为什么【不】经由 ctx.shell（与 typecheck.js / test.js 同因，别改回去）：
//   ctx.shell 是宿主平面的沙箱执行接缝，走它必须先让沙箱给工作区根目录授予写
//   权限，授权失败时工具直接不可用；而浏览器启动本身还需要在沙箱之外创建
//   Chrome 的 mojo 管道（沙箱内实测：platform_channel Check failed 拒绝访问）。
//   因此这里直接用 child_process 执行，命令由本文件拼装、模型只能填参数值。
//
// 环境变量由本工具注入，不依赖用户 shell：
//   - AGENT_BROWSER_SOCKET_DIR：守护进程套接字目录固定到系统临时目录，
//     避开 ~/.agent-browser 的 ACL 问题，也不往会话工作区里拉屎；
//   - AGENT_BROWSER_NAMESPACE：按会话工作区散列出的命名空间，让不同项目
//     各自拥有独立的守护进程与 Chrome 实例（详见 namespaceFor）；
//   - AGENT_BROWSER_MAX_OUTPUT：页面文本上限，防止整页 dump 打爆上下文。
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

/** 模型侧可见的工具名。 */
const TOOL_NAME = 'browser'
/** 单次动作的超时预算：首次 open 要拉起整个 Chrome，给足 2 分钟。 */
const DEFAULT_TIMEOUT_MS = 120000
/** 超时参数的可调范围。 */
const MIN_TIMEOUT_MS = 5000
const MAX_TIMEOUT_MS = 300000
/** 单流捕获上限（字符）；快照本身已被 MAX_OUTPUT 限长，这里只兜底。 */
const MAX_OUTPUT_CHARS = 131072
/** 守护进程套接字目录：固定、可写、与会话无关。 */
const SOCKET_DIR = path.join(os.tmpdir(), 'dsh-browser-sockets')
/** 页面文本上限（agent-browser 侧截断）。 */
const PAGE_MAX_OUTPUT = '20000'
/** 截图默认落盘目录（相对会话工作区）。 */
const SHOT_DIR = '.browser'

/**
 * 由会话工作区推导浏览器命名空间。
 *
 * agent-browser 的默认会话名是 `default`，所有调用共用同一个守护进程与同一个
 * Chrome 实例：不同项目会互相看到对方的页面，A 项目 snapshot 出来的元素其实是
 * B 项目的。命名空间把守护进程套接字与浏览器实例按工作区隔开，同时保留
 * 「同一项目内多次调用复用同一浏览器」这个必要行为（登录态、已打开的页面）。
 *
 * 用工作区绝对路径的散列而不是路径本身：命名空间会出现在套接字文件名里，
 * 中文、空格与长路径都会成为隐患。大小写归一，Windows 上同一目录不会分裂成两个。
 * @param {string} root - 会话工作区根目录。
 * @returns {string} agent-browser 命名空间名。
 */
function namespaceFor(root) {
  const normalized = path.resolve(root).toLowerCase()
  const digest = crypto.createHash('sha1').update(normalized).digest('hex')
  return `dsh-${digest.slice(0, 16)}`
}

/**
 * 定位 agent-browser CLI。
 *
 * 优先用全局 npm 安装里的 JS 入口并以 process.execPath 执行：不依赖 PATH、
 * 不受 .cmd 包装层影响（Windows 上直接 spawn .cmd 需要 shell: true，而 shell
 * 会把模型参数当成命令解析，等于开了一个注入入口）。
 * @returns {{command: string, prefix: string[]} | null}
 */
function locateCli() {
  const appData = process.env.APPDATA
  if (typeof appData === 'string' && appData.length > 0) {
    const entry = path.join(appData, 'npm', 'node_modules', 'agent-browser', 'bin', 'agent-browser.js')
    if (fs.existsSync(entry)) return { command: process.execPath, prefix: [entry] }
  }
  // 非 Windows / 自定义安装：交给 PATH，但同样不经过 shell。
  return { command: 'agent-browser', prefix: [] }
}

/** 会话内相对路径的显示形式：统一用正斜杠。 */
const toDisplay = (root, absolute) => path.relative(root, absolute).split(path.sep).join('/')

/**
 * 把一项相对路径解析成工作区内的绝对路径。
 *
 * 与 delete.js 同一道边界：模型输入不可信，截图路径不许写到工作区之外。
 * @param {string} root - 会话工作区根目录。
 * @param {string} item - 模型给出的路径。
 * @returns {{ok: true, absolute: string} | {ok: false, reason: string}}
 */
function resolveInside(root, item) {
  const absolute = path.resolve(root, item)
  const relative = path.relative(root, absolute)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { ok: false, reason: `${item}：超出项目根目录` }
  }
  return { ok: true, absolute }
}

/**
 * 把模型的动作翻译成 agent-browser 的参数表。
 *
 * 每个分支只做「参数拼装 + 缺参校验」，不含业务判断：动作语义由 CLI 定义，
 * 本工具不替它猜。缺参一律抛错而不是发一条注定失败的命令——CLI 的报错信息
 * 对模型远不如一句「click 需要 target」有用。
 * @param {object} args - 已通过 schema 校验的参数。
 * @param {string} root - 会话工作区根目录。
 * @returns {{argv: string[], display: string}}
 */
function buildCommand(args, root) {
  const need = (name, value) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${args.action} 需要 ${name} 参数`)
    }
    return value.trim()
  }

  switch (args.action) {
    case 'open': {
      const url = need('url', args.url)
      const argv = ['open', url]
      if (args.headed === true) argv.push('--headed')
      return { argv, display: `open ${url}` }
    }
    case 'snapshot': {
      const argv = ['snapshot', '-i', '-c']
      if (typeof args.target === 'string' && args.target.length > 0) argv.push('-s', args.target)
      return { argv, display: 'snapshot' }
    }
    case 'click': {
      const target = need('target', args.target)
      return { argv: ['click', target], display: `click ${target}` }
    }
    case 'fill': {
      const target = need('target', args.target)
      if (typeof args.text !== 'string') throw new Error('fill 需要 text 参数')
      return { argv: ['fill', target, args.text], display: `fill ${target}` }
    }
    case 'press': {
      const key = need('key', args.key)
      return { argv: ['press', key], display: `press ${key}` }
    }
    case 'wait': {
      // target 可以是选择器或毫秒数；text 走「等文本出现」。
      if (typeof args.text === 'string' && args.text.length > 0) {
        return { argv: ['wait', '--text', args.text], display: `wait text ${args.text}` }
      }
      const target = need('target', args.target)
      return { argv: ['wait', target], display: `wait ${target}` }
    }
    case 'get': {
      const what = need('what', args.what)
      const argv = ['get', what]
      if (what !== 'title' && what !== 'url') {
        const target = need('target', args.target)
        argv.push(target)
        return { argv, display: `get ${what} ${target}` }
      }
      return { argv, display: `get ${what}` }
    }
    case 'eval': {
      const script = need('script', args.script)
      return { argv: ['eval', script], display: 'eval' }
    }
    case 'screenshot': {
      const raw = typeof args.path === 'string' && args.path.length > 0
        ? args.path
        : path.join(SHOT_DIR, `shot-${Date.now()}.png`)
      const resolved = resolveInside(root, raw)
      if (!resolved.ok) throw new Error(resolved.reason)
      fs.mkdirSync(path.dirname(resolved.absolute), { recursive: true })
      const argv = ['screenshot', resolved.absolute]
      if (args.full === true) argv.push('--full')
      return { argv, display: `screenshot ${toDisplay(root, resolved.absolute)}` }
    }
    case 'close':
      return { argv: ['close'], display: 'close' }
    default:
      throw new Error(`未知的 action：${String(args.action)}`)
  }
}

/**
 * 读一个捕获文件的内容（读不到就当空）。
 * @param {string} file - 文件路径。
 * @returns {string}
 */
function readCapture(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 执行一次 agent-browser 调用并收齐输出。
 *
 * stdio 必须落到文件描述符，不能用管道：agent-browser 首次调用会拉起常驻
 * 守护进程，守护进程继承了父进程的 stdout/stderr；管道因此永不关闭，
 * Node 的 close 事件要等到守护进程退出才触发——实测每次 open 都会白等满
 * 整个超时预算。换成文件描述符后 CLI 一退出就拿到结果。
 * @param {string} root - 会话工作区根目录（作为 cwd）。
 * @param {string[]} argv - agent-browser 参数。
 * @param {number} timeoutMs - 超时预算。
 * @param {AbortSignal} signal - 工具调用的取消信号。
 * @returns {Promise<object>}
 */
function runCli(root, argv, timeoutMs, signal) {
  const idle = { stdout: '', stderr: '', exitCode: null, timedOut: false, spawnError: null, truncated: false, aborted: false }
  if (signal.aborted) return Promise.resolve({ ...idle, aborted: true })

  const cli = locateCli()
  if (cli === null) return Promise.resolve({ ...idle, spawnError: '未找到 agent-browser（请先 npm i -g agent-browser）' })

  let dir
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-browser-'))
  } catch (error) {
    return Promise.resolve({ ...idle, spawnError: error.message })
  }
  const outFile = path.join(dir, 'stdout.log')
  const errFile = path.join(dir, 'stderr.log')

  let outFd
  let errFd
  try {
    outFd = fs.openSync(outFile, 'a')
    errFd = fs.openSync(errFile, 'a')
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true })
    return Promise.resolve({ ...idle, spawnError: error.message })
  }

  return new Promise((resolve) => {
    let settled = false
    // 先声明后赋值：spawn 同步抛错时 settle 会立刻执行，此时这两个变量必须已存在。
    let timer
    let onAbort = () => {}
    const cleanup = () => {
      try { fs.closeSync(outFd) } catch { /* 已关闭 */ }
      try { fs.closeSync(errFd) } catch { /* 已关闭 */ }
      fs.rmSync(dir, { recursive: true, force: true })
    }
    const settle = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      const stdout = readCapture(outFile)
      const truncated = stdout.length > MAX_OUTPUT_CHARS
      cleanup()
      resolve({ ...value, stdout: truncated ? stdout.slice(0, MAX_OUTPUT_CHARS) : stdout, truncated })
    }

    let child
    try {
      child = spawn(cli.command, [...cli.prefix, ...argv], {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', outFd, errFd],
        env: {
          ...process.env,
          AGENT_BROWSER_SOCKET_DIR: SOCKET_DIR,
          // 按工作区隔离：不设它，所有项目共用 default 会话与同一个 Chrome。
          AGENT_BROWSER_NAMESPACE: namespaceFor(root),
          AGENT_BROWSER_MAX_OUTPUT: PAGE_MAX_OUTPUT,
        },
      })
    } catch (error) {
      settle({ ...idle, spawnError: error.message })
      return
    }

    timer = setTimeout(() => {
      child.kill()
      settle({ ...idle, stderr: readCapture(errFile), timedOut: true })
    }, timeoutMs)

    onAbort = () => child.kill()
    signal.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error) => settle({ ...idle, stderr: readCapture(errFile), spawnError: error.message }))
    child.on('close', (code) => settle({ ...idle, stderr: readCapture(errFile), exitCode: code }))
  })
}

/**
 * 结果呈现：stdout 原样在前，stderr 与退出码标记在后。
 *
 * 与 node.js / typecheck.js 同一口径——干净的退出不加任何标记，
 * 非零退出追加 `[exit code: N]`，不做归纳、不加结论。
 * @param {object} run - runCli 的返回值。
 * @param {string} display - 等价的命令摘要。
 * @returns {string} 模型可见的文本。
 */
function renderRun(run, display) {
  const lines = [`$ browser ${display}`]
  if (run.spawnError !== null) {
    lines.push(`无法执行：${run.spawnError}`)
    return lines.join('\n')
  }
  const out = run.stdout.trim()
  if (out.length > 0) lines.push(out)
  if (run.stderr.trim().length > 0) lines.push(`[stderr]\n${run.stderr.trim()}`)
  if (lines.length === 1) lines.push('(no output)')
  if (run.truncated) lines.push(`[输出被截断，仅保留前 ${MAX_OUTPUT_CHARS} 字符]`)
  if (run.timedOut) lines.push(`[timed out after ${run.timeoutMs}ms]`)
  else if (run.exitCode !== 0) lines.push(`[exit code: ${run.exitCode}]`)
  return lines.join('\n')
}

/** presentCall 在会话回放时会收到未经校验的参数，取值一律防御性处理。 */
function titleOf(args) {
  if (args === null || typeof args !== 'object') return '…'
  const action = typeof args.action === 'string' ? args.action : '…'
  const target = [args.url, args.target, args.key, args.what].find((v) => typeof v === 'string' && v.length > 0)
  return target === undefined ? action : `${action} ${target}`
}

module.exports = {
  name: 'tool-browser',
  // 只依赖 tools 注册表：本工具自己起子进程，不需要 shell 接缝（原因见文件头）。
  inject: ['tools'],

  apply(ctx) {
    const tools = ctx.get('tools')
    if (tools === undefined) {
      console.error('[tool-browser] 缺少 tools 服务，browser 工具未注册')
      return
    }

    tools.register({
      name: TOOL_NAME,
      description:
        'Drive a real headless Chrome to open and test web pages. Actions: open (url, optional headed),'
        + ' snapshot (accessibility tree with @eN refs; re-snapshot after every page change), click (target = @eN or CSS),'
        + ' fill (target, text), press (key), wait (target = selector or ms, or text), get (what = title|url|text|html|value|attr, target),'
        + ' eval (script run in the page), screenshot (optional path inside the project, optional full), close.'
        + ' The browser stays running between calls; always close when done.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open', 'snapshot', 'click', 'fill', 'press', 'wait', 'get', 'eval', 'screenshot', 'close'],
            description: 'Which browser action to perform.'
          },
          url: { type: 'string', description: 'open: page URL (https:// is prepended when omitted).' },
          target: { type: 'string', description: 'Element reference from snapshot (@e1) or a CSS selector.' },
          text: { type: 'string', description: 'fill: text to type. wait: text to wait for.' },
          key: { type: 'string', description: 'press: key name, e.g. Enter, Tab, Control+a.' },
          what: {
            type: 'string',
            enum: ['title', 'url', 'text', 'html', 'value', 'attr'],
            description: 'get: what to read.'
          },
          script: { type: 'string', description: 'eval: JavaScript expression evaluated in the page.' },
          path: { type: 'string', description: 'screenshot: output path relative to the project root.' },
          full: { type: 'boolean', description: 'screenshot: capture the full page instead of the viewport.' },
          headed: { type: 'boolean', description: 'open: show a visible browser window instead of headless.' },
          timeout: { type: 'number', description: 'Timeout in ms (5000-300000).' }
        },
        required: ['action'],
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { output: { type: 'string' } },
          required: ['output']
        },
        render: (_args, value) => [{ type: 'text', text: value.output }]
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) throw new Error('browser 需要 agent 会话')
        const root = agent.session.header.cwd
        if (typeof root !== 'string' || root.length === 0) throw new Error('browser 需要会话工作区')

        const { argv, display } = buildCommand(args, root)
        const timeoutMs = typeof args.timeout === 'number'
          ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, args.timeout))
          : DEFAULT_TIMEOUT_MS

        const run = await runCli(root, argv, timeoutMs, exec.signal)
        run.timeoutMs = timeoutMs

        // 取消不是动作的执行结果，按工具中断上报。
        if (exec.signal.aborted) {
          const error = new Error('tool call aborted')
          error.name = 'AbortError'
          error.code = 'ABORTED'
          throw error
        }

        return { output: renderRun(run, display) }
      },
      // UI 呈现：一次浏览器动作等价于一条命令，按终端卡片呈现。
      presentCall: (args) => ({
        card: 'terminal',
        title: `browser ${titleOf(args)}`,
        description: '用真实浏览器打开或操作页面'
      }),
      presentResult: (_args, result) => {
        const value = result.value
        if (result.isError || value === undefined || typeof value !== 'object') return undefined
        return {
          card: 'terminal',
          output: typeof value.output === 'string' ? value.output : undefined
        }
      }
    })
  }
}
