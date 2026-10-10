'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// typecheck.js —— ts-build 预设的 typecheck 工具（零依赖本地插件）
//
// 设计原则（唯一职责）：
//   在【不向模型暴露任何命令行工具】的前提下，给模型一个「检查语法」的按钮。
//   模型需要确认自己写的代码能否通过类型检查时，调用 typecheck；本工具在会话
//   工作区根目录执行 tsc，把执行结果原样返回。
//
// 因此本工具：
//   - 不接受任何参数：模型无法借此指定命令、参数或工作目录，没有可注入的入口；
//   - 命令由本文件写死（TSC_ARGS），模型既看不到也改不了；
//   - 结果就是 tsc 的执行结果本身，不做归纳、不加结论、不回显命令与路径，
//     与人在项目里直接敲一次 tsc 所见一致。
//
// 为什么裸注册、不 import defineTool：
//   本文件被 ~/.dsh/.js 复制到 profile 的 preset-assets/ts-build/ 下（编辑源在
//   用户预设目录），两处都不在任何 node_modules 链上，Node 的 require 向上查找
//   永远到不了 harness 的 node_modules，`import '@deepseek-ai/dsh-tools'` 必然失败。而
//   ctx.tools.register() 直接接受原始 JSON Schema 定义（dsh-mcp-client 就是
//   这样注册的），因此本文件只用 node 内置模块。
//
// 为什么【不】经由 ctx.shell（重要，别改回去）：
//   ctx.shell 是宿主平面的沙箱执行接缝。走它就必须先让沙箱给工作区根目录授予写
//   权限（Windows ACL 后端的 grantWrite / SetNamedSecurityInfoW），于是这个纯只读
//   的 tsc --noEmit 被绑上「必须拿到写权限」的前置条件：
//     - 授权失败时工具直接不可用（实测 D:\the-play：SetNamedSecurityInfoW Win32 5
//       ACCESS_DENIED，命令根本没跑）；
//     - 工具 schema 是零参数（见下），模型无法传 sandbox_permissions/justification
//       提权重试，只能卡死。
//   一个不写任何文件的只读检查，不该需要写权限，也不该有提权入口。
//
//   因此这里直接用 child_process 执行。安全性由「不可注入」保证，而不是由沙箱保证：
//     - 命令与参数是本文件的常量（TSC_ARGS），模型无法触及、无法拼接；
//     - 工具零参数，没有可注入的入口；
//     - --noEmit 保证不产出任何文件；
//     - cwd 固定为会话工作区根，不取自模型输入。
//   这是本工具存在的唯一理由（「在不暴露 shell 的前提下给模型一个检查按钮」）的
//   直接推论：既然模型碰不到命令，沙箱在这里只贡献失败模式。
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

/** 模型侧可见的工具名。 */
const TOOL_NAME = 'typecheck'
/** 单次检查的超时预算。 */
const TIMEOUT_MS = 300000
/** 向上查找 node_modules/typescript 的最大层数，覆盖 monorepo 依赖提升。 */
const SEARCH_DEPTH = 8
/** 写死的编译器参数：只检查、不产出文件，且关掉彩色输出。 */
const TSC_ARGS = '--noEmit --pretty false'
/** 单流捕获上限（字节）；超出即截断并附提示，避免诊断洪水打爆上下文。 */
const MAX_OUTPUT_BYTES = 262144

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

/**
 * 执行编译器并把结果收成 { stdout, stderr, exitCode, timedOut, spawnError, truncated }。
 *
 * 不走 ctx.shell（原因见文件头注释）：这是纯只读检查，不应依赖沙箱授权。
 * @param {string} root - 会话工作区根目录（作为 cwd，不取自模型输入）。
 * @param {AbortSignal} signal - 工具调用的取消信号。
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number | null, timedOut: boolean, spawnError: string | null, truncated: boolean}>}
 */
function runCompiler(root, signal) {
    const spec = spawnSpecFor(resolveCompiler(root))
    return new Promise((resolve) => {
        let child
        try {
            child = spawn(spec.file, spec.args, {
                cwd: root,
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
        }, TIMEOUT_MS)
        let timedOut = false

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

/** 追加截断提示。 */
function streamText(text, truncated) {
    if (!truncated) return text
    return `${text}\n[输出被截断，仅保留前 ${MAX_OUTPUT_BYTES} 字节]`
}

/**
 * tsc 的执行结果，原样返回：stdout、stderr、退出码标记。
 *
 * 与 pwsh 工具的呈现口径一致——非零退出才追加 `[exit code: N]`，
 * 干净的退出不加任何标记。不做归纳、不加结论。
 * @param {object} result - runCompiler 的返回值。
 * @returns {string} 模型可见的文本。
 */
function renderResult(result) {
    // 起不来子进程（编译器缺失等）本身就是结果，原样报出，不当异常抛。
    if (result.spawnError !== null) return `无法启动 TypeScript 编译器：${result.spawnError}`
    const out = streamText(result.stdout, result.truncated)
    const err = result.stderr.length === 0 ? '' : streamText(result.stderr, result.truncated)
    let body = out
    if (err.length > 0) {
        if (body.length > 0 && !body.endsWith('\n')) body += '\n'
        body += `[stderr]\n${err}`
    }
    if (body.length === 0) body = '(no output)'

    const markers = []
    if (result.timedOut) markers.push(`[timed out after ${TIMEOUT_MS}ms]`)
    else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
    if (markers.length === 0) return body
    if (!body.endsWith('\n')) body += '\n'
    return body + markers.join('\n')
}

module.exports = {
    name: 'tool-typecheck',
    // 只依赖 tools 注册表：本工具自己起子进程，不需要 shell 接缝（原因见文件头）。
    inject: ['tools'],

    apply(ctx) {
        const tools = ctx.get('tools')
        if (tools === undefined) {
            console.error('[tool-typecheck] 缺少 tools 服务，typecheck 工具未注册')
            return
        }

        tools.register({
            name: TOOL_NAME,
            description:
                '对当前项目运行TypeScript类型检查，相当于在项目根目录执行 tsc --noEmit。直接调用即可看到编译器报告的语法与类型错误。',
            // 零参数：模型没有任何可注入的入口，这是本工具的设计前提。
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { output: { type: 'string' } },
                    required: ['output']
                },
                render: (_args, value) => [{ type: 'text', text: value.output }]
            },
            async execute(_args, exec) {
                const agent = exec.agent
                if (agent === undefined) throw new Error('typecheck 需要 agent 会话')
                const root = agent.session.header.cwd
                if (typeof root !== 'string' || root.length === 0) throw new Error('typecheck 需要会话工作区')

                const result = await runCompiler(root, exec.signal)

                // 取消不是检查结果，按工具中断上报。
                if (exec.signal.aborted) {
                    const error = new Error('tool call aborted')
                    error.name = 'AbortError'
                    error.code = 'ABORTED'
                    throw error
                }

                return { output: renderResult(result) }
            },
            // UI 呈现：检查就是一条命令，按终端卡片呈现。
            presentCall: () => ({
                card: 'terminal',
                title: `tsc ${TSC_ARGS}`,
                description: '运行 TypeScript 类型检查'
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
