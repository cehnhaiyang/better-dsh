'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// tools.js —— better-dsh 自定义工具集的唯一实现（由各预设按需声明使用）
//
// 本文件是 typecheck / test / git / node / delete / browser 六个工具的
// 唯一实现，放在仓库根。**哪个预设能用哪几个工具，由那个预设自己在
// agent.cordis.yml 里声明**，不再各存一份插件拷贝：
//
//     - id: custom-tools
//       name: 'better-dsh:tools'
//       config:
//         tools: [typecheck, test, git, node, delete, browser]
//
// 其中 `better-dsh:tools` 是一个占位标记，由 `~/.dsh/.js` 在生成预设声明时改写成本
// 文件的 file:// 绝对路径（DSH_ROOT 可被 DSH_HOME 覆盖，因此不能把绝对路径写死在
// 预设里）。config.tools 列出该预设要用的工具名，本文件的 apply() 只注册这些。
//
// 为什么是「预设声明」而不是「宿主平面全局挂载」（重要，别改回去）：
//   dsh-agent-preset-registry 的 activate() 会给每个预设铸一个独立作用域
//   （createScope），预设 plugins 列表里的行就在**那个预设的作用域**里挂载。
//   而 tools.register() 把注册写进哪一层由调用方上下文决定（ScopedLayers.effect →
//   scopeOf(ctx)）：
//     - 声明在预设里的行 → 进入该预设的作用域 → 只有这个预设的会话看得到；
//     - 挂成 profile 顶层条目的行 → 进入 dsh-tools 的**全局层**，而
//       ToolRuntime.view(scope) 以全局层为起点组装可见集，于是**每个**预设的会话
//       都会继承它。
//   后者会把 node / delete / git 这类执行能力强加给所有预设，包括设计上完全
//   不给命令行的文学类预设；而且那样一来「预设声明自己用什么工具」这句话本身就失去
//   了意义。因此本文件只提供实现，注册范围一律由预设声明决定。
//
//   顺带一提，官方工具走的正是同一条路：tool-fs / tool-goal / tool-ask-user 等都是
//   逐个声明在各预设的 plugins 列表里的，宿主平面并不预先全局挂载它们。
//
// 为什么全部裸注册、不 import defineTool：
//   本文件位于 ~/.dsh/ 根目录，不在任何 node_modules 链上，Node 的 require 向上查找
//   到不了 harness 的 node_modules，`import '@deepseek-ai/dsh-tools'` 必然失败。而
//   ctx.get('tools').register() 直接接受原始 JSON Schema 定义（dsh-mcp-client 就是
//   这样注册的），因此本文件只用 node 内置模块。
//
// 为什么【不】经由 ctx.shell（重要，别改回去）：
//   ctx.shell 是宿主平面的沙箱执行接缝。走它就必须先让沙箱给工作区根目录授予写权限
//   （Windows ACL 后端的 grantWrite / SetNamedSecurityInfoW），于是这些工具被绑上
//   「必须拿到写权限」的前置条件：
//     - 授权失败时工具直接不可用（实测 D:\the-play：SetNamedSecurityInfoW Win32 5
//       ACCESS_DENIED，命令根本没跑）；
//     - typecheck / test 是零参数工具，git 的参数只是三选一的动作名；它们的 schema 里
//       都没有 sandbox_permissions 与 justification，模型无法提权重试，只能卡死。
//   一个只读检查、一次测试、一次提交，不该以写权限为前提。browser 更是如此：Chrome
//   要在沙箱之外创建 mojo 管道（沙箱内实测 platform_channel Check failed）。
//
//   因此统一用 child_process 直接执行，安全性由「不可注入」保证，而不是由沙箱保证：
//     - 命令、参数与提交信息是本文件的常量，模型触及不到、拼接不了；
//     - cwd 固定为会话工作区根（或其中写死的子目录），不取自模型输入；
//     - 带自由参数的 node / delete / browser 各有一道边界：路径必须落在会话工作区
//       之内（绝对路径与 `..` 穿越一律拒绝，见 resolveInside）；git 的参数则限定在
//       三个写死的动作名里，连路径都进不来。
//
// 结构：共用基础设施 → 六个工具（各自一个 define 函数，内部符号互不污染）→ 按声明注册。
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

// ─────────────────────────────────────────────────────────────────────────────
// 共用基础设施
// ─────────────────────────────────────────────────────────────────────────────

/** 单流、以及整段最终文本的捕获上限；超出即截断并附提示，避免输出打爆上下文。 */
const MAX_OUTPUT_BYTES = 262144

/** 六个工具的输出契约完全一致：一段纯文本。 */
const textOutput = () => ({
    schema: {
        type: 'object',
        additionalProperties: false,
        properties: { output: { type: 'string' } },
        required: ['output']
    },
    render: (_args, value) => [{ type: 'text', text: value.output }]
})

/**
 * presentResult 的终端卡片半边（六个工具完全一致）。
 *
 * 会话回放时 value 可能是任意东西，取值一律防御性处理。
 */
const terminalResult = (_args, result) => {
    const value = result.value
    if (result.isError || value === undefined || typeof value !== 'object') return undefined
    return {
        card: 'terminal',
        output: typeof value.output === 'string' ? value.output : undefined
    }
}

/**
 * execute 的前置：取会话工作区根目录。
 *
 * 工作区取自会话头（`header.cwd`），不取自模型输入，因此模型无法借它改 cwd。
 * @param {object} exec - 工具执行上下文。
 * @param {string} tool - 工具名，只进报错文案。
 * @returns {string} 会话工作区根目录的绝对路径。
 */
function sessionRoot(exec, tool) {
    const agent = exec.agent
    if (agent === undefined) throw new Error(`${tool} 需要 agent 会话`)
    const root = agent.session.header.cwd
    if (typeof root !== 'string' || root.length === 0) throw new Error(`${tool} 需要会话工作区`)
    return root
}

/** 取消不是执行结果，按工具中断上报（六个工具同一口径）。 */
function throwIfAborted(signal) {
    if (!signal.aborted) return
    const error = new Error('tool call aborted')
    error.name = 'AbortError'
    error.code = 'ABORTED'
    throw error
}

/**
 * 追加截断提示。
 * @param {string} text - 已捕获的文本。
 * @param {boolean} truncated - 是否被截断。
 * @param {string} [unit] - 上限的单位，随调用方的捕获口径（「字节」或「字符」）。
 * @returns {string} 可能带提示的文本。
 */
function streamText(text, truncated, unit = '字节') {
    if (!truncated) return text
    return `${text}\n[输出被截断，仅保留前 ${MAX_OUTPUT_BYTES} ${unit}]`
}

/**
 * 起一个子进程，把输出收成
 * { stdout, stderr, exitCode, timedOut, spawnError, truncated }。
 *
 * 不走 ctx.shell（原因见文件头注释）。stdio 走管道，子进程一退出就能拿到结果——
 * 前提是它不留下继承了同一组管道的常驻子进程；browser 的守护进程正是那种情形，
 * 因此那边用自己的 runCli（文件描述符）。
 * @param {string} file - 可执行文件。
 * @param {string[]} args - 参数表（常量，模型无法触及）。
 * @param {object} options - cwd、超时预算与取消信号。
 * @returns {Promise<object>} 见上。
 */
function runPiped(file, args, { cwd, timeoutMs, signal }) {
    return new Promise((resolve) => {
        let child
        try {
            child = spawn(file, args, {
                cwd,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            })
        } catch (error) {
            resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, spawnError: error.message, truncated: false })
            return
        }

        let stdout = ''
        let stderr = ''
        let truncated = false
        let settled = false
        let timedOut = false

        const append = (current, chunk) => {
            if (current.length >= MAX_OUTPUT_BYTES) {
                truncated = true
                return current
            }
            const next = current + chunk
            if (next.length > MAX_OUTPUT_BYTES) {
                truncated = true
                return next.slice(0, MAX_OUTPUT_BYTES)
            }
            return next
        }

        const timer = setTimeout(() => {
            if (settled) return
            timedOut = true
            child.kill()
        }, timeoutMs)

        const onAbort = () => child.kill()
        signal.addEventListener('abort', onAbort, { once: true })

        child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk.toString('utf8')) })
        child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk.toString('utf8')) })

        const finish = (exitCode, spawnError) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            signal.removeEventListener('abort', onAbort)
            resolve({ stdout, stderr, exitCode, timedOut, spawnError, truncated })
        }

        child.on('error', (error) => finish(null, error.message))
        child.on('close', (code) => finish(code, null))
    })
}

/**
 * 一条固定命令的渲染口径：stdout，非空 stderr 追加其后，最后是退出码标记。
 *
 * 与 pwsh 工具一致——非零退出才追加 `[exit code: N]`，干净的退出不加任何标记；
 * 不做归纳、不加结论、不回显路径。
 * @param {object} result - runPiped 的返回值。
 * @param {object} options - timeoutMs，以及起不来子进程时的报错前缀。
 * @returns {string} 模型可见的文本。
 */
function renderCommandResult(result, { timeoutMs, spawnFail }) {
    // 起不来子进程（编译器/目录缺失等）本身就是结果，原样报出，不当异常抛。
    if (result.spawnError !== null) return `${spawnFail}：${result.spawnError}`
    const out = streamText(result.stdout, result.truncated)
    const err = result.stderr.length === 0 ? '' : streamText(result.stderr, result.truncated)
    let body = out
    if (err.length > 0) {
        if (body.length > 0 && !body.endsWith('\n')) body += '\n'
        body += `[stderr]\n${err}`
    }
    if (body.length === 0) body = '(no output)'

    const markers = []
    if (result.timedOut) markers.push(`[timed out after ${timeoutMs}ms]`)
    else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
    if (markers.length === 0) return body
    if (!body.endsWith('\n')) body += '\n'
    return body + markers.join('\n')
}

/** 会话内相对路径的显示形式：统一用正斜杠，Windows 的反斜杠不泄漏给模型。 */
const toDisplay = (root, absolute) => path.relative(root, absolute).split(path.sep).join('/')

/**
 * 把逗号分隔的参数拆成非空路径项。
 * @param {unknown} raw - 模型传入的 paths。
 * @returns {string[]} 去掉首尾空白后的路径项。
 */
function splitPaths(raw) {
    if (typeof raw !== 'string') return []
    return raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
}

/**
 * 把一项相对路径解析成工作区内的绝对路径。
 *
 * 这是 node / delete / browser 三个工具的信任边界：模型输入不可信，「以项目根目录
 * 为基准」由这里强制，而不是靠模型自觉。绝对路径与 `..` 穿越都会解析到工作区之外，
 * 一律拒绝。
 * @param {string} root - 会话工作区根目录。
 * @param {string} item - 模型给出的一项路径。
 * @param {object} [options] - allowRoot：是否允许解析到工作区根目录本身。
 *   node / delete 不允许：删掉或跑遍整个项目几乎不会是本意。browser 放宽——截图
 *   路径只是 CLI 的落盘位置，`path: "."` 由 CLI 自己报错即可。
 * @returns {{ok: true, absolute: string} | {ok: false, reason: string}}
 */
function resolveInside(root, item, { allowRoot = false } = {}) {
    const absolute = path.resolve(root, item)
    const relative = path.relative(root, absolute)
    if (!allowRoot && relative.length === 0) return { ok: false, reason: `${item}：不能是项目根目录本身` }
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return { ok: false, reason: `${item}：超出项目根目录` }
    }
    return { ok: true, absolute }
}

/** presentCall 在会话回放时会收到未经校验的参数，取值一律防御性处理。 */
function pathsTitle(args) {
    const paths = args !== null && typeof args === 'object' ? args.paths : undefined
    return typeof paths === 'string' && paths.length > 0 ? paths : '…'
}

// ─────────────────────────────────────────────────────────────────────────────
// typecheck —— 不给予命令行前提下的「检查语法」按钮
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 在会话工作区根目录跑一次 `tsc --noEmit --pretty false`，把结果原样返回。
 *
 * 零参数：模型无法指定命令、参数或工作目录，没有可注入的入口；命令写死在本文件里。
 * `--noEmit` 保证不产出任何文件，因此这是纯只读检查。优先使用项目本地安装的
 * TypeScript（向上找 node_modules/typescript/bin/tsc），找不到才退回 .bin 垫片与 PATH。
 * @param {object} tools - dsh-tools 注册表。
 */
function defineTypecheck(tools) {
    /** 单次检查的超时预算。 */
    const TIMEOUT_MS = 300000
    /** 向上查找 node_modules/typescript 的最大层数，覆盖 monorepo 依赖提升。 */
    const SEARCH_DEPTH = 8
    /** 写死的编译器参数：只检查、不产出文件，且关掉彩色输出。 */
    const TSC_ARGS = '--noEmit --pretty false'

    /** 判断路径是否为存在的普通文件（失败一律视为不存在）。 */
    const isFile = (candidate) => {
        try {
            return fs.statSync(candidate).isFile()
        } catch {
            return false
        }
    }

    /**
     * 从工作区根目录向上查找 TypeScript 编译器。
     *
     * 优先取 node_modules/typescript/bin/tsc：它是以 node 直接执行的 JS 入口，
     * 用 process.execPath 起子进程即可，不经任何 shell，路径无需转义。
     * 其次退回 node_modules/.bin 下的垫片（.cmd 在 Windows 上需经 cmd.exe，交给
     * spawn 的 shell 选项处理），最后交给 PATH 上的 tsc。
     * @param {string} root - 会话工作区根目录。
     * @returns {{kind: 'node' | 'bin' | 'path', file?: string}} 编译器来源描述。
     */
    function resolveCompiler(root) {
        let dir = root
        for (let depth = 0; depth < SEARCH_DEPTH; depth += 1) {
            const entry = path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc')
            if (isFile(entry)) return { kind: 'node', file: entry }
            const parent = path.dirname(dir)
            if (parent === dir) break
            dir = parent
        }
        const shim = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
        if (isFile(shim)) return { kind: 'bin', file: shim }
        return { kind: 'path' }
    }

    /**
     * 把编译器来源摊成 spawn 的 (file, args)。
     *
     * 主路径（node）完全不经过 shell：用 process.execPath 跑 tsc 的 JS 入口，参数是
     * 常量数组，路径里的空格、`$`、反引号都不会被任何解释器处理。
     *
     * 兜底路径（.bin 垫片 / PATH 上的 tsc）在 Windows 上是 .cmd，无法直接执行，
     * 必须借 cmd.exe。这里刻意 spawn cmd.exe 本身（shell: false），而不是用
     * spawn 的 shell: true —— 后者会把参数直接拼进命令行且不做转义（Node 对此有
     * DEP0190 警告），而 cmd.exe 由 Node 按参数数组逐项加引号，安全面更清楚。
     * @param {{kind: string, file?: string}} compiler - resolveCompiler 的结果。
     * @returns {{file: string, args: string[]}} spawn 参数。
     */
    function spawnSpecFor(compiler) {
        const args = TSC_ARGS.split(' ')
        if (compiler.kind === 'node' && compiler.file !== undefined) {
            return { file: process.execPath, args: [compiler.file, ...args] }
        }
        const target = compiler.kind === 'bin' && compiler.file !== undefined ? compiler.file : 'tsc'
        if (process.platform === 'win32') {
            // /d 跳过 AutoRun，/s 保留引号语义，/c 执行后退出。
            return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', target, ...args] }
        }
        return { file: target, args }
    }

    /** 在会话工作区根目录执行一次编译器（不走 ctx.shell，原因见文件头）。 */
    function runCompiler(root, signal) {
        const spec = spawnSpecFor(resolveCompiler(root))
        return runPiped(spec.file, spec.args, { cwd: root, timeoutMs: TIMEOUT_MS, signal })
    }

    tools.register({
        name: 'typecheck',
        description:
            'Type-check the project: run `tsc --noEmit --pretty false` at the project root and return the'
            + " compiler's syntax and type errors.",
        // 零参数：模型没有任何可注入的入口，这是本工具的设计前提。
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: textOutput(),
        async execute(_args, exec) {
            const root = sessionRoot(exec, 'typecheck')
            const result = await runCompiler(root, exec.signal)
            throwIfAborted(exec.signal)
            return { output: renderCommandResult(result, { timeoutMs: TIMEOUT_MS, spawnFail: '无法启动 TypeScript 编译器' }) }
        },
        // UI 呈现：检查就是一条命令，按终端卡片呈现。
        presentCall: () => ({
            card: 'terminal',
            title: `tsc ${TSC_ARGS}`,
            description: '运行 TypeScript 类型检查'
        }),
        presentResult: terminalResult
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// test —— 不给予命令行前提下的「跑测试」按钮
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 在会话工作区的 test 子目录下跑一次 `npm run test`，把结果原样返回。
 *
 * 零参数：命令与工作目录都写死在本文件里，模型无法指定。超时给足 10 分钟——
 * 测试可能比类型检查慢得多。
 * @param {object} tools - dsh-tools 注册表。
 */
function defineTest(tools) {
    /** 单次执行的超时预算。 */
    const TIMEOUT_MS = 600000
    /** 写死的命令参数：在 test 目录里跑该目录 package.json 的 test 脚本。 */
    const NPM_ARGS = ['run', 'test']
    /** 测试命令所在的子目录（相对会话工作区根）。 */
    const TEST_DIR_NAME = 'test'

    /** 判断路径是否为存在的目录（失败一律视为不存在）。 */
    const isDirectory = (candidate) => {
        try {
            return fs.statSync(candidate).isDirectory()
        } catch {
            return false
        }
    }

    /**
     * 执行 `npm run test` 并收齐输出。
     *
     * Windows 上 npm 是 npm.cmd，无法直接 spawn，必须借 cmd.exe。这里刻意 spawn
     * cmd.exe 本身（shell: false），而不是用 spawn 的 shell: true —— 后者会把参数
     * 直接拼进命令行且不做转义（Node 对此有 DEP0190 警告），而 cmd.exe 由 Node 按
     * 参数数组逐项加引号，安全面更清楚。
     * @param {string} root - 会话工作区根目录。
     * @param {AbortSignal} signal - 工具调用的取消信号。
     * @returns {Promise<object>} runPiped 的结果。
     */
    function runTests(root, signal) {
        const cwd = path.join(root, TEST_DIR_NAME)
        // 先确认目录在：否则 spawn 会把「cwd 不存在」报成 `spawn cmd.exe ENOENT`，
        // 让模型以为缺的是 cmd.exe 而不是 test 目录。
        if (!isDirectory(cwd)) {
            return Promise.resolve({
                stdout: '', stderr: '', exitCode: null, timedOut: false,
                spawnError: `test 目录不存在：${cwd}`, truncated: false,
            })
        }
        return process.platform === 'win32'
            // /d 跳过 AutoRun，/s 保留引号语义，/c 执行后退出。
            ? runPiped(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...NPM_ARGS], { cwd, timeoutMs: TIMEOUT_MS, signal })
            : runPiped('npm', NPM_ARGS, { cwd, timeoutMs: TIMEOUT_MS, signal })
    }

    tools.register({
        name: 'test',
        description:
            'Run the project test suite: run `npm run test` in the `test` subdirectory and return its output.',
        // 零参数：模型没有任何可注入的入口，这是本工具的设计前提。
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: textOutput(),
        async execute(_args, exec) {
            const root = sessionRoot(exec, 'test')
            const result = await runTests(root, exec.signal)
            throwIfAborted(exec.signal)
            return { output: renderCommandResult(result, { timeoutMs: TIMEOUT_MS, spawnFail: '无法执行 npm run test' }) }
        },
        // UI 呈现：跑测试就是一条命令，按终端卡片呈现。
        presentCall: () => ({
            card: 'terminal',
            title: 'npm run test',
            description: '在 test 目录下运行测试'
        }),
        presentResult: terminalResult
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// git —— 不给予命令行前提下的「提交 / 推送」按钮
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 在会话工作区根目录执行一组写死的 git 命令：提交、推送，或两者连着做。
 *
 * 唯一的参数是 `action`，三选一（commit / push / c&p）。模型依然给不出命令行：每个
 * 动作背后的子命令、参数与提交信息都是本文件的常量，action 只是在这几条写死的命令
 * 序列里挑一条，模型既改不了命令，也拼不进任何东西。
 *
 * 为什么提交是两步 git 而不是一步（别改成 `git commit -a`）：
 *   `commit -a` 只覆盖【已跟踪】文件的改动，新建的文件不在其中，而「项目的所有更改」
 *   必须包含它们。因此先 `add -A` 暂存全部改动（新文件、修改、删除），再 commit。
 *
 * 为什么推送写死成 `push -u origin HEAD` 而不是裸 `push`：
 *   裸 `push` 依赖当前分支已有 upstream，新建分支上会直接失败——而本工具没有命令行
 *   可补救（模型跑不了 `git push --set-upstream`）。`origin HEAD` 明确表示「把当前
 *   分支推到远端同名分支」，首次推送也能一次成功；`-u` 顺手把 upstream 设好，之后
 *   用户自己在终端里裸 `git push` 也能用。远端名固定为 origin：仓库若用了别的远端
 *   名，git 自己的报错会原样返回给模型。
 *
 * 失败即止：序列里任何一步失败（起不来子进程、非零退出、超时）都不再执行后面的
 * 步骤——没暂存完整的提交、没提交成功的推送，再跑一次只会把同一条错误重复一遍。
 * 注意由此带来的一个副作用：工作区干净时 c&p 会停在 commit 的「nothing to commit」，
 * 不会继续推送；此时再调一次 action=push 即可。
 * @param {object} tools - dsh-tools 注册表。
 */
function defineGit(tools) {
    /** 单次执行的超时预算：提交可能触发 pre-commit 钩子（格式化、测试），推送可能很慢。 */
    const TIMEOUT_MS = 300000
    /** 写死的提交信息：模型无法指定，避免为此开出可注入的入口。 */
    const COMMIT_MESSAGE = '更新'
    /** 写死的暂存参数：-A 覆盖新文件、修改与删除，即「项目的所有更改」。 */
    const GIT_ADD_ARGS = ['add', '-A']
    /** 写死的提交参数：-m 让 git 不打开编辑器。 */
    const GIT_COMMIT_ARGS = ['commit', '-m', COMMIT_MESSAGE]
    /** 写死的推送参数：见上方注释，`-u origin HEAD` 让没有 upstream 的分支也能一次推成功。 */
    const GIT_PUSH_ARGS = ['push', '-u', 'origin', 'HEAD']

    /** 三个动作各自的命令序列；键就是 schema 里 enum 的取值，也用于执行前的白名单校验。 */
    const STEP_SEQUENCES = {
        commit: [GIT_ADD_ARGS, GIT_COMMIT_ARGS],
        push: [GIT_PUSH_ARGS],
        'c&p': [GIT_ADD_ARGS, GIT_COMMIT_ARGS, GIT_PUSH_ARGS]
    }

    /**
     * 执行一次 git。
     *
     * git 在 Windows 上是可直接执行的 git.exe，无需像 npm 那样借 cmd.exe；
     * 参数以数组交给 spawn（shell: false），提交信息里的空格不会被任何解释器处理。
     * @param {string} root - 会话工作区根目录（作为 cwd，不取自模型输入）。
     * @param {string[]} args - 写死的 git 参数。
     * @param {AbortSignal} signal - 工具调用的取消信号。
     * @returns {Promise<object>} runPiped 的结果。
     */
    function runGit(root, args, signal) {
        return runPiped('git', args, { cwd: root, timeoutMs: TIMEOUT_MS, signal })
    }

    /**
     * 按顺序执行一串命令，遇到第一个失败就停。
     *
     * 暂存失败（不在 git 仓库、index.lock 被占、超时）时不再 commit：此时提交必然
     * 不完整。push 同理——没有暂存完整的提交，推出去的东西是错的。
     * @param {string} root - 会话工作区根目录。
     * @param {string[][]} argsList - 本次动作的命令序列。
     * @param {AbortSignal} signal - 工具调用的取消信号。
     * @returns {Promise<Array<{args: string[], result: object}>>} 已执行的命令及其结果。
     */
    async function runSequence(root, argsList, signal) {
        const runs = []
        for (const args of argsList) {
            const result = await runGit(root, args, signal)
            runs.push({ args, result })
            if (result.spawnError !== null || result.exitCode !== 0) break
        }
        return runs
    }

    /** 单次 git 调用的正文：stdout，非空 stderr 追加在其后。 */
    function bodyOf(result) {
        const out = streamText(result.stdout, result.truncated)
        if (result.stderr.length === 0) return out
        const err = streamText(result.stderr, result.truncated)
        if (out.length > 0 && !out.endsWith('\n')) return `${out}\n[stderr]\n${err}`
        return `${out}[stderr]\n${err}`
    }

    /**
     * 每条命令一段：先回显 `$ git <参数>`，再是 stdout（非空 stderr 追加其后），
     * 最后是这一步自己的退出码 / 超时标记，原样返回、不做归纳。
     *
     * 为什么逐条回显命令、逐条给标记：同一个工具现在有三种动作、最多三条命令，输出不
     * 带命令行就分不清哪段来自 add、哪段来自 commit、哪段来自 push；标记若统一追加在
     * 末尾，会让人误以为整条序列都失败了。
     * @param {Array<{args: string[], result: object}>} runs - runSequence 的返回值。
     * @returns {string} 模型可见的文本。
     */
    function renderResults(runs) {
        const sections = []
        for (const { args, result } of runs) {
            const lines = [`$ git ${args.join(' ')}`]
            // 起不来子进程（git 缺失等）本身就是结果，原样报出，不当异常抛。
            if (result.spawnError !== null) {
                lines.push(`无法执行 git：${result.spawnError}`)
            } else {
                const body = bodyOf(result)
                // 暂存成功时 git add 无输出；「没说话」也是结果的一部分。
                lines.push(body.length > 0 ? body : '(no output)')
                if (result.timedOut) lines.push(`[timed out after ${TIMEOUT_MS}ms]`)
                else if (result.exitCode !== 0) lines.push(`[exit code: ${result.exitCode}]`)
            }
            sections.push(lines.join('\n'))
        }
        return sections.join('\n')
    }

    tools.register({
        name: 'git',
        description:
            'Run git in the project root: `action` = commit (`git add -A`, then `git commit -m <fixed message>`),'
            + ' push (`git push -u origin HEAD`, the current branch), or c&p (commit, then push).'
            + ' Stops at the first failing step and returns git output verbatim.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['commit', 'push', 'c&p'],
                    description: 'commit: stage and commit every change. push: push the current branch. c&p: commit then push.'
                }
            },
            required: ['action'],
            additionalProperties: false
        },
        output: textOutput(),
        async execute(args, exec) {
            const root = sessionRoot(exec, 'git')
            // 会话回放或手工调用可能带来 schema 之外的值：当场报错，而不是默默跑一条命令。
            const sequence = typeof args.action === 'string' && Object.hasOwn(STEP_SEQUENCES, args.action)
                ? STEP_SEQUENCES[args.action]
                : undefined
            if (sequence === undefined) {
                throw new Error(`git 的 action 只能是 commit / push / c&p，收到 ${JSON.stringify(args.action)}`)
            }
            const runs = await runSequence(root, sequence, exec.signal)
            throwIfAborted(exec.signal)
            return { output: renderResults(runs) }
        },
        // UI 呈现：一次动作就是一条（或两条）命令，按终端卡片呈现；回放时参数未经校验。
        presentCall: (args) => {
            const action = args !== null && typeof args === 'object' ? args.action : undefined
            if (action === 'commit') return { card: 'terminal', title: 'git commit', description: '提交项目的所有更改' }
            if (action === 'push') return { card: 'terminal', title: 'git push', description: '推送当前分支到远端' }
            if (action === 'c&p') return { card: 'terminal', title: 'git commit && git push', description: '提交项目的所有更改并推送' }
            return { card: 'terminal', title: 'git …', description: '提交或推送项目仓库' }
        },
        presentResult: terminalResult
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// node —— 不给予命令行前提下的「跑脚本」按钮
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 以项目根目录为基准解析 paths，把该路径下的所有 .js 脚本按顺序逐个用 node 执行。
 *
 * 参数：paths —— 相对路径，多个用英文逗号分隔；可以是 .js 文件，也可以是目录，
 * 目录递归取其下所有 .js 文件（跳过 node_modules 与以 . 开头的目录，否则 `node .`
 * 会把整棵依赖树跑一遍）。递归不进入链接：readdir 的 Dirent 对符号链接与 junction
 * 都不报 isDirectory，因此它们既不被跟随也不会成环；但【点名】一个链接仍然有效
 * （statSync 会跟随）。
 *
 * 执行顺序与中断：按参数顺序、每个路径内按名称排序深度优先，逐个执行；遇到第一个
 * 问题（路径不存在 / 无 .js 脚本 / 起不来子进程 / 非零退出 / 超时）就停下，不再执行
 * 后面的脚本——后面的脚本多半依赖前面的结果，继续跑只会把同一条错误重复一遍
 * （与 git 里 `add` 失败就不再 `commit` 同因）。
 * @param {object} tools - dsh-tools 注册表。
 */
function defineNode(tools) {
    /** 单个脚本的超时预算：脚本可能是构建、生成或迁移，给足 5 分钟。 */
    const TIMEOUT_MS = 300000

    /** 递归时是否跳过该目录：依赖树与隐藏目录都不是项目自己的脚本。 */
    const isSkippedDir = (name) => name === 'node_modules' || name.startsWith('.')

    /**
     * 深度优先收集目录下的 .js 脚本，同一层按名称排序，保证顺序稳定可预期。
     * @param {string} dir - 已在工作区内的目录绝对路径。
     * @param {string[]} out - 收集结果，按访问顺序追加。
     */
    function walk(dir, out) {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!isSkippedDir(entry.name)) walk(path.join(dir, entry.name), out)
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.js')) {
                out.push(path.join(dir, entry.name))
            }
            // 其余（符号链接、junction、设备文件等）不进递归：Dirent 对链接不报
            // isDirectory，天然既不被跟随也不会成环。点名的链接另当别论，见 collectScripts。
        }
    }

    /**
     * 收集一个路径下的所有 .js 脚本。
     *
     * 「一个路径下没有任何 .js 脚本」按失败返回而不是返回空数组：模型多半是路径
     * 写错了，静默跳过会让它以为脚本跑过了。
     * @param {string} target - 已在工作区内的绝对路径。
     * @returns {{scripts: string[], reason: string | null}}
     */
    function collectScripts(target) {
        let stat
        try {
            stat = fs.statSync(target)
        } catch {
            return { scripts: [], reason: '路径不存在' }
        }
        if (stat.isFile()) {
            return path.extname(target).toLowerCase() === '.js'
                ? { scripts: [target], reason: null }
                : { scripts: [], reason: '不是 .js 脚本' }
        }
        if (!stat.isDirectory()) return { scripts: [], reason: '既不是文件也不是目录' }

        const scripts = []
        walk(target, scripts)
        return { scripts, reason: scripts.length === 0 ? '目录下没有 .js 脚本' : null }
    }

    /**
     * 用 node 执行一个脚本。
     *
     * 用 process.execPath 而不是 'node'：那就是当前 harness 进程自己在跑的那个解释器，
     * 不依赖 PATH。返回值在共用字段之外多带 script（供渲染命令行）与 aborted（供序列
     * 中断判定）。
     * @param {string} root - 会话工作区根目录（作为 cwd，不取自模型输入）。
     * @param {string} script - 脚本的绝对路径。
     * @param {AbortSignal} signal - 工具调用的取消信号。
     * @returns {Promise<object>} 见上。
     */
    async function runScript(root, script, signal) {
        const idle = { script, stdout: '', stderr: '', exitCode: null, timedOut: false, spawnError: null, truncated: false, aborted: false }
        // 信号若已中止，监听器不会再触发（abort 只派发一次），必须在这里挡住，
        // 否则取消之后仍会把后面的脚本一个个跑完。
        if (signal.aborted) return { ...idle, aborted: true }
        const result = await runPiped(process.execPath, [script], { cwd: root, timeoutMs: TIMEOUT_MS, signal })
        return { script, ...result, aborted: false }
    }

    /**
     * 依次处理每个路径项，逐个执行收集到的脚本。
     * @param {string} root - 会话工作区根目录。
     * @param {string[]} items - 模型给出的路径项。
     * @param {AbortSignal} signal - 工具调用的取消信号。
     * @returns {Promise<{runs: object[], failure: string | null}>} runs 为已执行的脚本结果，
     *   failure 为让序列停下的那个问题（正常跑完为 null）。
     */
    async function runAll(root, items, signal) {
        const runs = []
        let failure = null
        for (const item of items) {
            const resolved = resolveInside(root, item)
            if (!resolved.ok) {
                failure = resolved.reason
                break
            }
            const collected = collectScripts(resolved.absolute)
            if (collected.reason !== null) {
                failure = `${item}：${collected.reason}`
                break
            }
            let stopped = false
            for (const script of collected.scripts) {
                const run = await runScript(root, script, signal)
                runs.push(run)
                if (run.aborted || run.spawnError !== null || run.timedOut || run.exitCode !== 0) {
                    stopped = true
                    break
                }
            }
            if (stopped) break
        }
        return { runs, failure }
    }

    /**
     * 单个脚本一段：标题行是等价的命令行，正文是它的输出。
     * @param {string} root - 会话工作区根目录。
     * @param {object} run - runScript 的返回值。
     * @returns {string} 该脚本的正文。
     */
    function renderRun(root, run) {
        const lines = [`$ node ${toDisplay(root, run.script)}`]
        if (run.spawnError !== null) {
            lines.push(`无法执行：${run.spawnError}`)
            return lines.join('\n')
        }
        const out = streamText(run.stdout, run.truncated, '字符')
        if (out.length > 0) lines.push(out)
        if (run.stderr.length > 0) lines.push(`[stderr]\n${streamText(run.stderr, run.truncated, '字符')}`)
        // 无输出的脚本也可能是正常的（比如只做副作用），如实说一句，避免看起来像没跑。
        if (lines.length === 1) lines.push('(no output)')
        if (run.timedOut) lines.push(`[timed out after ${TIMEOUT_MS}ms]`)
        else if (run.exitCode !== 0) lines.push(`[exit code: ${run.exitCode}]`)
        return lines.join('\n')
    }

    /**
     * 各脚本的执行结果，原样返回：stdout、stderr、退出码标记。
     *
     * 整段文本封顶：脚本数量由模型决定，不封顶会把上下文打爆。
     * @param {string} root - 会话工作区根目录。
     * @param {object[]} runs - runAll 返回的执行结果。
     * @param {string | null} failure - 让序列停下的问题。
     * @returns {string} 模型可见的文本。
     */
    function renderResult(root, runs, failure) {
        const blocks = runs.map((run) => renderRun(root, run))
        if (failure !== null) blocks.push(`[失败] ${failure}`)

        const text = blocks.join('\n')
        if (text.length <= MAX_OUTPUT_BYTES) return text
        return `${text.slice(0, MAX_OUTPUT_BYTES)}\n[输出被截断，仅保留前 ${MAX_OUTPUT_BYTES} 字符]`
    }

    tools.register({
        name: 'node',
        description:
            'Run JavaScript files with node. `paths` is a comma-separated list of paths relative to the project root;'
            + ' each may be a .js file or a directory, and a directory contributes every .js file beneath it'
            + ' (node_modules and dot-directories are skipped). Scripts run in order, stopping at the first failure.',
        parameters: {
            type: 'object',
            properties: {
                paths: {
                    type: 'string',
                    description: 'Comma-separated paths relative to the project root, e.g. scripts/build.js,src'
                }
            },
            required: ['paths'],
            additionalProperties: false
        },
        output: textOutput(),
        async execute(args, exec) {
            const root = sessionRoot(exec, 'node')
            const items = splitPaths(args.paths)
            if (items.length === 0) {
                throw new Error('node 需要 paths 参数：以项目根目录为基准的相对路径，多个用英文逗号分隔')
            }

            const { runs, failure } = await runAll(root, items, exec.signal)
            throwIfAborted(exec.signal)
            return { output: renderResult(root, runs, failure) }
        },
        // UI 呈现：跑脚本就是一条命令，按终端卡片呈现。
        presentCall: (args) => ({
            card: 'terminal',
            title: `node ${pathsTitle(args)}`,
            description: '依次运行项目内的 JavaScript 脚本'
        }),
        presentResult: terminalResult
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// delete —— 不给予命令行前提下的「删文件」按钮
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 以项目根目录为基准解析 paths 并逐个删除：是文件就删文件，是目录就删整棵目录树。
 *
 * 两道边界，都立在模型输入这一侧（见 resolveInside）：路径必须落在会话工作区之内，
 * 且不能是项目根目录本身。除此之外不设路径黑名单（例如不特判 .git）：模型点名要删
 * 什么就删什么，额外的「贴心」拦截只会让行为变得不可预测。
 *
 * 为什么用 fs.rmSync 而不是自己写递归删除：目录树删除由 Node 内置实现负责，符号
 * 链接、只读位、Windows 上的重解析点都已处理；自己写只会引入半删状态。
 *
 * 本工具用的是 fs，不是命令，因此压根没有 cwd 可谈——「不经 ctx.shell」在这里不是
 * 选择而是事实。
 * @param {object} tools - dsh-tools 注册表。
 */
function defineDelete(tools) {
    /**
     * 删除一个路径：文件删文件，目录删整棵树。
     *
     * 不存在按失败返回而不是当作「已经删掉了」：路径写错和确实删过，对模型是两件
     * 不同的事，静默算成功会让它以为清理完成了。
     * @param {string} root - 会话工作区根目录。
     * @param {string} item - 模型给出的一项路径。
     * @returns {{ok: true, display: string, tree: boolean} | {ok: false, reason: string}}
     */
    function removeOne(root, item) {
        const resolved = resolveInside(root, item)
        if (!resolved.ok) return { ok: false, reason: resolved.reason }

        let stat
        try {
            stat = fs.lstatSync(resolved.absolute)
        } catch {
            return { ok: false, reason: `${item}：路径不存在` }
        }

        const tree = stat.isDirectory()
        try {
            fs.rmSync(resolved.absolute, { recursive: tree, force: false })
        } catch (error) {
            return { ok: false, reason: `${item}：${error.message}` }
        }
        // 目录带尾斜杠，与文件区分：一眼能看出删掉的是整棵树。
        const display = toDisplay(root, resolved.absolute) + (tree ? '/' : '')
        return { ok: true, display, tree }
    }

    /**
     * 依次删除每个路径项，遇到第一个问题就停下。
     *
     * 停下而不是跳过继续：路径写错时后面的删除多半也建立在同一个错误理解上，
     * 继续删只会把不该删的东西删掉（与 node / git 同因）。
     * @param {string} root - 会话工作区根目录。
     * @param {string[]} items - 模型给出的路径项。
     * @returns {{removed: object[], failure: string | null}}
     */
    function removeAll(root, items) {
        const removed = []
        let failure = null
        for (const item of items) {
            const result = removeOne(root, item)
            if (!result.ok) {
                failure = result.reason
                break
            }
            removed.push(result)
        }
        return { removed, failure }
    }

    /**
     * 删除结果，原样返回：删掉了哪些路径、以及让序列停下的那个问题。
     *
     * 本工具没有 stdout 可言，报的就是「做了什么」本身。
     * @param {object[]} removed - removeAll 返回的已删除项。
     * @param {string | null} failure - 让序列停下的问题。
     * @returns {string} 模型可见的文本。
     */
    function renderResult(removed, failure) {
        const lines = removed.map((entry) => `[已删除] ${entry.display}`)
        if (failure !== null) lines.push(`[失败] ${failure}`)
        // 一项都没删、也没失败，只可能是 paths 全为空——上面已按参数错误挡掉。
        if (lines.length === 0) lines.push('(没有删除任何路径)')
        return lines.join('\n')
    }

    tools.register({
        name: 'delete',
        description:
            'Delete files or directories in the project. `paths` is a comma-separated list of paths relative to the'
            + ' project root; a file is removed, a directory is removed with its whole tree. Paths are deleted in'
            + ' order, stopping at the first failure. Deletion is irreversible.',
        parameters: {
            type: 'object',
            properties: {
                paths: {
                    type: 'string',
                    description: 'Comma-separated paths relative to the project root, e.g. tmp/a.js,dist'
                }
            },
            required: ['paths'],
            additionalProperties: false
        },
        output: textOutput(),
        async execute(args, exec) {
            const root = sessionRoot(exec, 'delete')
            const items = splitPaths(args.paths)
            if (items.length === 0) {
                throw new Error('delete 需要 paths 参数：以项目根目录为基准的相对路径，多个用英文逗号分隔')
            }

            const { removed, failure } = removeAll(root, items)
            return { output: renderResult(removed, failure) }
        },
        // UI 呈现：删除是一次文件操作，按终端卡片呈现（本工具没有 diff 卡片可承载删除）。
        presentCall: (args) => ({
            card: 'terminal',
            title: `delete ${pathsTitle(args)}`,
            description: '删除项目内的文件或目录'
        }),
        presentResult: terminalResult
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// browser —— 不给予命令行前提下的「开浏览器」按钮
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把模型的动作翻译成一次 agent-browser CLI 调用，把输出原样返回。
 *
 * 为什么复用 agent-browser 而不是自己接 CDP：它已经把「启动 Chrome → 连 CDP →
 * 无障碍树快照（@eN 引用）→ 动作」这条链做完并常驻守护进程，模型拿到的是
 * 200~400 token 的紧凑快照而不是整页 HTML；自己接 CDP 等于重写它，还要自己处理
 * 版本探测、端口分配、进程回收。
 *
 * 环境变量由本工具注入，不依赖用户 shell：
 *   - AGENT_BROWSER_SOCKET_DIR：守护进程套接字目录固定到系统临时目录，避开
 *     ~/.agent-browser 的 ACL 问题，也不往会话工作区里拉屎；
 *   - AGENT_BROWSER_NAMESPACE：按会话工作区散列出的命名空间，让不同项目各自拥有
 *     独立的守护进程与 Chrome 实例（详见 namespaceFor）；
 *   - AGENT_BROWSER_MAX_OUTPUT：页面文本上限，防止整页 dump 打爆上下文。
 * @param {object} tools - dsh-tools 注册表。
 */
function defineBrowser(tools) {
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
     * @returns {{command: string, prefix: string[]}}
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
                const resolved = resolveInside(root, raw, { allowRoot: true })
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
     * stdio 必须落到文件描述符，不能用管道：agent-browser 首次调用会拉起常驻守护
     * 进程，守护进程继承了父进程的 stdout/stderr；管道因此永不关闭，Node 的 close
     * 事件要等到守护进程退出才触发——实测每次 open 都会白等满整个超时预算。换成
     * 文件描述符后 CLI 一退出就拿到结果。
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
            let onAbort = () => { }
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
     * 与 node / typecheck 同一口径——干净的退出不加任何标记，非零退出追加
     * `[exit code: N]`，不做归纳、不加结论。
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
    function browserTitle(args) {
        if (args === null || typeof args !== 'object') return '…'
        const action = typeof args.action === 'string' ? args.action : '…'
        const target = [args.url, args.target, args.key, args.what].find((v) => typeof v === 'string' && v.length > 0)
        return target === undefined ? action : `${action} ${target}`
    }

    tools.register({
        name: 'browser',
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
        output: textOutput(),
        async execute(args, exec) {
            const root = sessionRoot(exec, 'browser')
            const { argv, display } = buildCommand(args, root)
            const timeoutMs = typeof args.timeout === 'number'
                ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, args.timeout))
                : DEFAULT_TIMEOUT_MS

            const run = await runCli(root, argv, timeoutMs, exec.signal)
            run.timeoutMs = timeoutMs
            throwIfAborted(exec.signal)
            return { output: renderRun(run, display) }
        },
        // UI 呈现：一次浏览器动作等价于一条命令，按终端卡片呈现。
        presentCall: (args) => ({
            card: 'terminal',
            title: `browser ${browserTitle(args)}`,
            description: '用真实浏览器打开或操作页面'
        }),
        presentResult: terminalResult
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// 注册
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本文件提供的全部工具：名字 → 定义函数。
 *
 * 名字表同时也是 `config.tools` 的合法取值集合：预设声明了表外的名字直接报错，
 * 而不是静默少装一个工具（静默少装的表现是模型调不到工具，很难查）。
 */
const DEFINITIONS = {
    typecheck: defineTypecheck,
    test: defineTest,
    git: defineGit,
    node: defineNode,
    delete: defineDelete,
    browser: defineBrowser
}

/** 本文件提供的全部工具名，按声明顺序（也是注册顺序）。 */
const TOOL_NAMES = Object.keys(DEFINITIONS)

module.exports = {
    // 与 profile patch / 预设声明里的条目 id 同名（其余五个自建插件同此约定），日志里好对号。
    name: 'custom-tools',
    // 只依赖 tools 注册表：所有工具都自带子进程或直接用 fs，不需要 shell 接缝（见文件头）。
    inject: ['tools'],
    // 非 Cordis 字段：只给 ~/.dsh/.js 做契约核对用，加载器不读它。
    TOOL_NAMES,

    // 刻意不声明 Cordis 的 `Config` 模式：cordis 要求它是一个 schemastery schema
    // （内部直接读 `Config['~standard'].validate`），而本文件不在任何 node_modules
    // 链上、require 不到 schemastery。config 因此原样传进来，由 apply() 自己校验
    // （见下），报错文案也更贴切。
    //
    // 缺省行为：没有 config.tools 就一个都不注册，而不是「默认全给」——漏写声明时
    // 宁可少装工具（当场报错、一眼能看出声明写错了），也不要凭空把执行能力给到一个
    // 没声明它的预设。
    apply(ctx, config) {
        const tools = ctx.get('tools')
        if (tools === undefined) {
            console.error('[custom-tools] 缺少 tools 服务（宿主组合未挂载 @deepseek-ai/dsh-tools）；本次未注册任何工具')
            return
        }
        const wanted = Array.isArray(config?.tools) ? config.tools : []
        if (wanted.length === 0) {
            console.error('[custom-tools] 声明里没有 config.tools（或为空）：本预设不会获得任何自定义工具。'
                + `请写成 config: { tools: [${TOOL_NAMES.join(', ')}] } 的相应子集。`)
            return
        }
        const unknown = wanted.filter((name) => DEFINITIONS[name] === undefined)
        if (unknown.length > 0) {
            console.error(`[custom-tools] 声明了未知工具 ${unknown.map((n) => `'${n}'`).join('、')}；`
                + `可用的是：${TOOL_NAMES.join(' / ')}（这些名字不会被注册）`)
        }
        for (const name of wanted) {
            const define = DEFINITIONS[name]
            if (define !== undefined) define(tools)
        }
    }
}
