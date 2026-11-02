'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// tools.js —— better-dsh 自定义工具集的唯一实现（由各预设按需声明使用）
//
// 本文件是 js / delete / browser / web 四个工具的
// 唯一实现，放在仓库根。**哪个预设能用哪几个工具，由那个预设自己在
// agent.cordis.yml 里声明**：
//
//     - id: custom-tools
//       name: 'better-dsh:tools'
//       config:
//         tools: [js, delete, browser, web]
//
// git 的提交 / 推送不在这里：它是**由用户手动触发的斜杠命令**（`/git c|p|c&p`），
// 实现见 plugins/git-command.js 的生成模板（~/.dsh/.js 里的 GIT_COMMAND_CODE）。
// 用户仓库的写操作发起时机属于用户，交到模型手里就等于模型可以自行提交与推送。
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
//   后者会把 js / delete / browser 这类执行能力强加给所有预设，包括设计上完全
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
//     - js 的 check / test 只给出一个动作名，schema 里也没有 sandbox_permissions 与
//       justification，模型无法提权重试，只能卡死。
//   一个只读检查、一次测试、一次提交，不该以写权限为前提。browser 更是如此：Chrome
//   要在沙箱之外创建 mojo 管道（沙箱内实测 platform_channel Check failed）。
//
//   因此统一用 child_process 直接执行，安全性由「不可注入」保证，而不是由沙箱保证：
//     - 命令、参数与提交信息是本文件的常量，模型触及不到、拼接不了；
//     - cwd 固定为会话工作区根（或其中写死的子目录），不取自模型输入；
//     - 带自由参数的 js（node 的 paths）/ delete / browser 各有一道边界：路径必须
//       落在会话工作区之内（绝对路径与 `..` 穿越一律拒绝，见 resolveInside）；js 的
//       check / test / build 只有一个动作名。
//
// 结构：共用基础设施 → 四个工具（各自一个 define 函数，内部符号互不污染）→ 按声明注册。
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const zlib = require('node:zlib')
const { execFileSync, spawn } = require('node:child_process')

// ─────────────────────────────────────────────────────────────────────────────
// 共用基础设施
// ─────────────────────────────────────────────────────────────────────────────

/** 单流、以及整段最终文本的捕获上限；超出即截断并附提示，避免输出打爆上下文。 */
const MAX_OUTPUT_BYTES = 262144

/** js / delete / browser / web 的输出契约完全一致：一段纯文本。 */
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
 * presentResult 的终端卡片半边（四个工具完全一致）。
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

/** 取消不是执行结果，按工具中断上报（所有执行外部命令的工具同一口径）。 */
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
 * 起一条外部命令；Windows 上的 .cmd 垫片（npm、node_modules/.bin 里的 tsc）无法直接
 * spawn，必须借 cmd.exe。
 *
 * 刻意 spawn cmd.exe 本身（shell: false），而不是用 spawn 的 shell: true —— 后者会把
 * 参数直接拼进命令行且不做转义（Node 对此有 DEP0190 警告），而 cmd.exe 由 Node 按
 * 参数数组逐项加引号，安全面更清楚。
 * @param {string} file - 可执行文件名（PATH 解析）。
 * @param {string[]} args - 参数表（常量，模型无法触及）。
 * @param {object} options - cwd、超时预算与取消信号。
 * @returns {Promise<object>} runPiped 的结果。
 */
function runShellCommand(file, args, options) {
    if (process.platform !== 'win32') return runPiped(file, args, options)
    // /d 跳过 AutoRun，/s 保留引号语义，/c 执行后退出。
    return runPiped(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', file, ...args], options)
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
 * 这是 js / delete / browser 三个工具的信任边界：模型输入不可信，「以项目根目录
 * 为基准」由这里强制，而不是靠模型自觉。绝对路径与 `..` 穿越都会解析到工作区之外，
 * 一律拒绝。
 * @param {string} root - 会话工作区根目录。
 * @param {string} item - 模型给出的一项路径。
 * @param {object} [options] - allowRoot：是否允许解析到工作区根目录本身。
 *   js 的 node 动作与 delete 不允许：删掉或跑遍整个项目几乎不会是本意。browser 放宽
 *   ——它的截图路径只是 CLI 的落盘位置，`path: "."` 由 CLI 自己报错即可。
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

/** 参数里是否真的给了一个非空字符串（会话回放时可能是任何东西）。 */
const hasText = (value) => typeof value === 'string' && value.trim().length > 0

// ─────────────────────────────────────────────────────────────────────────────
// 出站 HTTP：走代理，或直连
// ─────────────────────────────────────────────────────────────────────────────
//
// 为什么不用全局 fetch：Node 的 fetch 不读系统代理，浏览器能打开的站点在 fetch
// 里可能直接连不上——同一条工具与浏览器于是走了两条路。所以这里自己做传输层：
// **有代理就用，没代理就直连**。
//
// 代理来源按优先级：
//   1. 环境变量 HTTPS_PROXY / https_proxy / ALL_PROXY（显式配置最优先）；
//   2. Windows 的 Internet Settings（浏览器用的那份，ProxyEnable + ProxyServer）。
// 只支持 http:// 形式的代理（CONNECT 隧道）；socks 代理需要额外的握手协议，
// 这里不假装支持——遇到 socks 就跳过，按直连处理，而不是静默失败。

/** 缓存代理探测结果：注册表查询要起子进程，不值得每次请求都做。 */
let proxyCache

/**
 * 解析一个代理字符串（`host:port` 或 `http://host:port`）。
 * @param {string} raw - 代理配置文本。
 * @returns {{host: string, port: number} | null} 解析结果；非 http 代理返回 null。
 */
function parseProxy(raw) {
    const text = raw.trim()
    if (text.length === 0) return null
    // socks 需要额外握手，不支持：明确跳过而不是当成 http 代理用。
    if (/^socks/i.test(text)) return null
    const withoutScheme = text.replace(/^http:\/\//i, '')
    // 去掉可能出现的路径与认证部分（`user:pass@host:port`）。
    const authority = withoutScheme.split('/')[0].split('@').pop()
    const match = /^([^\s:]+):(\d+)$/.exec(authority)
    if (match === null) return null
    const port = Number.parseInt(match[2], 10)
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
    return { host: match[1], port }
}

/**
 * 读 Windows 系统代理（浏览器用的那份）。
 *
 * `netsh winhttp show proxy` 是 WinHTTP 的配置，与浏览器用的 Internet Settings
 * 是两套；浏览器（Chrome/Edge）读的是后者，所以这里读注册表而不是 netsh。
 * @returns {{host: string, port: number} | null} 代理；未启用或读不到返回 null。
 */
function windowsSystemProxy() {
    if (process.platform !== 'win32') return null
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    try {
        const out = execFileSync('reg', ['query', key], { encoding: 'utf8', timeout: 5000, windowsHide: true })
        // ProxyEnable 为 0 时 ProxyServer 可能仍留在注册表里，必须看开关。
        if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(out)) return null
        const server = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(out)?.[1]
        if (server === undefined) return null
        // 多协议写法（`http=host:port;https=host:port`）：取 https 那一项。
        const parts = server.split(';')
        const httpsPart = parts.find((p) => /^https=/i.test(p.trim()))
        const chosen = httpsPart !== undefined ? httpsPart.trim().replace(/^https=/i, '') : server
        return parseProxy(chosen)
    } catch {
        // reg 不可用 / 键不存在：当作没有代理。
        return null
    }
}

/**
 * 取得当前生效的代理（带缓存）。
 * @returns {{host: string, port: number} | null} 代理；没有则 null（表示直连）。
 */
function detectProxy() {
    if (proxyCache !== undefined) return proxyCache
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
        const value = process.env[name]
        if (typeof value === 'string' && value.trim().length > 0) {
            const parsed = parseProxy(value)
            if (parsed !== null) {
                proxyCache = parsed
                return proxyCache
            }
        }
    }
    proxyCache = windowsSystemProxy()
    return proxyCache
}

/** 响应体解压：站点普遍 gzip/deflate/br，不处理会拿到一堆乱码。 */
function decompress(buffer, encoding) {
    const name = typeof encoding === 'string' ? encoding.toLowerCase() : ''
    if (name === 'gzip' || name === 'x-gzip') return zlib.gunzipSync(buffer)
    if (name === 'deflate') {
        // 有些服务器把 deflate 发成 raw deflate，先试标准再退 raw。
        try { return zlib.inflateSync(buffer) } catch { return zlib.inflateRawSync(buffer) }
    }
    if (name === 'br') return zlib.brotliDecompressSync(buffer)
    return buffer
}

/**
 * 经 HTTP 代理建立到目标的隧道（CONNECT），返回一个已 TLS 握手的 socket。
 * @param {{host: string, port: number}} proxy - 代理地址。
 * @param {string} targetHost - 目标主机。
 * @param {number} targetPort - 目标端口。
 * @param {number} timeoutMs - 建连与握手的预算。
 * @returns {Promise<import('node:tls').TLSSocket>}
 */
function openProxyTunnel(proxy, targetHost, targetPort, timeoutMs) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: proxy.host, port: proxy.port })
        let settled = false
        const fail = (error) => {
            if (settled) return
            settled = true
            socket.destroy()
            reject(error)
        }
        socket.setTimeout(timeoutMs)
        socket.on('timeout', () => fail(new Error(`代理连接超时（${proxy.host}:${proxy.port}）`)))
        socket.on('error', (error) => fail(new Error(`代理不可用（${proxy.host}:${proxy.port}）：${error.code ?? error.message}`)))
        socket.on('connect', () => {
            socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`)
        })
        socket.once('data', (chunk) => {
            const statusLine = chunk.toString('utf8').split('\r\n')[0] ?? ''
            if (!/\s2\d\d\s/.test(statusLine)) {
                fail(new Error(`代理拒绝隧道：${statusLine.trim() || '无响应'}`))
                return
            }
            const secure = tls.connect({ socket, servername: targetHost }, () => {
                if (settled) return
                settled = true
                socket.setTimeout(0)
                resolve(secure)
            })
            secure.on('error', (error) => fail(new Error(`TLS 握手失败：${error.code ?? error.message}`)))
        })
    })
}

/**
 * 发一个 GET，跟随重定向，返回 { status, statusText, headers, body, url }。
 *
 * 传输路径：**有代理就走代理，代理用不了就直连**。
 *
 * 代理配置存在不等于代理可用：代理软件退出后，环境变量或 Windows 注册表里的
 * ProxyServer 往往还留着。照着它连一个已经关掉的端口只会拿到 ECONNREFUSED，
 * 此时必须退回直连，而不是把「代理没开」报成抓取失败。
 *
 * 不判断站点属于国内还是国外：那要求工具去猜哪些域名算国内，永远判不全。
 *
 * @param {string} url - 目标地址。
 * @param {object} options - headers、timeoutMs、取消信号与 maxRedirects。
 * @returns {Promise<object>} 见上；body 为 Buffer（已解压）。
 */
async function httpGet(url, { headers, timeoutMs, signal, maxRedirects = 5 }) {
    throwIfAborted(signal)
    const proxy = detectProxy()

    const request = async (useProxy) => {
        let current = url
        for (let hop = 0; hop <= maxRedirects; hop += 1) {
            throwIfAborted(signal)
            const parsed = new URL(current)
            const targetPort = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 443
            const requestHeaders = { ...headers, host: parsed.host }

            const socket = useProxy
                ? await openProxyTunnel(proxy, parsed.hostname, targetPort, timeoutMs)
                : undefined

            const result = await new Promise((resolve, reject) => {
                let settled = false
                let answered = false
                const fail = (error) => { if (settled) return; settled = true; reject(error) }

                const req = https.request({
                    host: parsed.hostname,
                    port: targetPort,
                    path: `${parsed.pathname}${parsed.search}`,
                    method: 'GET',
                    headers: requestHeaders,
                    ...(socket === undefined ? {} : { createConnection: () => socket }),
                    // 这个超时管的是「连接与等首字节」；一旦服务器开始应答，就由
                    // body 自己的节奏决定，避免大页面下载被误判成连不上。
                    timeout: timeoutMs,
                }, (response) => {
                    answered = true
                    // 已应答：撤掉连接阶段的超时，改由 timeoutMs 兜底下载耗时。
                    req.setTimeout(timeoutMs)
                    const chunks = []
                    response.on('data', (chunk) => chunks.push(chunk))
                    response.on('error', fail)
                    response.on('end', () => {
                        if (settled) return
                        settled = true
                        let body
                        try {
                            body = decompress(Buffer.concat(chunks), response.headers['content-encoding'])
                        } catch (error) {
                            fail(new Error(`响应体解压失败：${error.message}`))
                            return
                        }
                        resolve({
                            status: response.statusCode ?? 0,
                            statusText: response.statusMessage ?? '',
                            headers: response.headers,
                            body,
                            url: current,
                        })
                    })
                })
                req.on('timeout', () => {
                    req.destroy()
                    fail(new Error(answered
                        ? `读取响应超时（${timeoutMs}ms）`
                        : `连接超时（${timeoutMs}ms）`))
                })
                req.on('error', (error) => fail(new Error(`${error.code ?? error.name}: ${error.message}`)))
                const onAbort = () => { req.destroy(); fail(Object.assign(new Error('aborted'), { name: 'AbortError' })) }
                signal.addEventListener('abort', onAbort, { once: true })
                req.on('close', () => signal.removeEventListener('abort', onAbort))
                req.end()
            })

            // 重定向：Location 可能是相对路径。
            if (result.status >= 300 && result.status < 400 && typeof result.headers.location === 'string') {
                current = new URL(result.headers.location, current).href
                continue
            }
            return result
        }
        throw new Error(`重定向次数过多（>${maxRedirects}）`)
    }

    if (proxy === null) return request(false)

    try {
        return await request(true)
    } catch (error) {
        if (signal.aborted || error.name === 'AbortError') throw error
        // 代理用不了（没开、端口拒绝、隧道被拒）：退回直连。
        return request(false)
    }
}

/**
 * 把底层错误翻成一句能说明病因的话。
 *
 * `fetch failed` 这种笼统报错毫无用处——真正的原因在 error.code / error.cause
 * 里（UND_ERR_CONNECT_TIMEOUT、ECONNRESET、ENOTFOUND…）。这里把整条链摊平。
 * @param {unknown} error - 捕获到的错误。
 * @returns {string} 可读的病因。
 */
function describeHttpError(error) {
    const parts = []
    let cursor = error
    for (let depth = 0; cursor !== null && cursor !== undefined && depth < 4; depth += 1) {
        const text = String(cursor.message ?? cursor)
        const code = cursor.code === undefined ? '' : ` (${cursor.code})`
        if (!parts.includes(text + code)) parts.push(text + code)
        cursor = cursor.cause
    }
    return parts.join(' ← ') || '未知错误'
}

/** presentCall 在会话回放时会收到未经校验的参数，取值一律防御性处理。 */

/** presentCall 在会话回放时会收到未经校验的参数，取值一律防御性处理。 */
function pathsTitle(args) {
    const paths = args !== null && typeof args === 'object' ? args.paths : undefined
    return typeof paths === 'string' && paths.length > 0 ? paths : '…'
}

// ─────────────────────────────────────────────────────────────────────────────
// js —— 不给予命令行前提下的「检查 / 跑脚本 / 跑测试 / 构建」按钮
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 在会话工作区里执行 JavaScript 相关的四类任务，按 `action` 分派：
 *
 *   check —— 工作区根目录跑 `tsc --noEmit --pretty false`
 *   node  —— 按 paths 逐个执行项目内的 .js 脚本
 *   test  —— 工作区 test 子目录跑 `npm run test`
 *   build —— 工作区根目录跑 `npm run build`
 *
 * 四个动作都不接受额外参数：跑什么由该目录 package.json 的脚本决定，能构建出什么
 * 也由那份脚本里的显式配置决定（例如 `vite build --config <路径>`）。工具这一侧
 * 只回答「在哪跑」，不回答「构建谁」。
 *
 * 为什么四件事共用一个工具而不是四个：它们共用同一套东西——会话工作区解析、子进程
 * 捕获与截断、渲染口径，以及 Windows 上 .cmd 垫片必须借 cmd.exe 的那道处理。分成四个
 * 工具时这些要么各存一份，要么互相 import；合起来之后命令与参数仍然是本文件的常量，
 * 模型能给的只有「做哪件事」与「对哪个路径」，可注入面没有变大。
 * @param {object} tools - dsh-tools 注册表。
 */
function defineJs(tools) {
    /** 类型检查的超时预算。 */
    const CHECK_TIMEOUT_MS = 300000
    /** 跑测试 / 构建的超时预算：它们比类型检查慢得多。 */
    const TASK_TIMEOUT_MS = 600000
    /** 单个脚本的超时预算：脚本可能是构建、生成或迁移，给足 5 分钟。 */
    const SCRIPT_TIMEOUT_MS = 300000

    /** 写死的编译器参数：只检查、不产出文件，且关掉彩色输出。 */
    const TSC_ARGS = ['--noEmit', '--pretty', 'false']
    /** 向上查找 node_modules/typescript 的最大层数，覆盖 monorepo 依赖提升。 */
    const SEARCH_DEPTH = 8
    /** 测试命令所在的子目录（相对会话工作区根）。 */
    const TEST_DIR_NAME = 'test'
    /** 写死的 npm 参数：跑该目录 package.json 的 test / build 脚本。 */
    const NPM_TEST_ARGS = ['run', 'test']
    const NPM_BUILD_ARGS = ['run', 'build']

    /** 判断路径是否为存在的普通文件（失败一律视为不存在）。 */
    const isFile = (candidate) => {
        try {
            return fs.statSync(candidate).isFile()
        } catch {
            return false
        }
    }

    /** 判断路径是否为存在的目录（失败一律视为不存在）。 */
    const isDirectory = (candidate) => {
        try {
            return fs.statSync(candidate).isDirectory()
        } catch {
            return false
        }
    }

    /**
     * 从工作区根目录向上查找 TypeScript 编译器。
     *
     * 优先取 node_modules/typescript/bin/tsc：它是以 node 直接执行的 JS 入口，
     * 用 process.execPath 起子进程即可，不经任何 shell，路径无需转义。
     * 其次退回 node_modules/.bin 下的垫片，最后交给 PATH 上的 tsc。
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
     * 在指定目录执行一条写死的 npm 脚本。
     *
     * 先确认目录在：否则 spawn 会把「cwd 不存在」报成 `spawn cmd.exe ENOENT`，
     * 让模型以为缺的是 cmd.exe 而不是那个目录。
     * @param {string} cwd - 执行目录（工作区内的绝对路径）。
     * @param {string[]} npmArgs - 写死的 npm 参数。
     * @param {AbortSignal} signal - 工具调用的取消信号。
     * @returns {Promise<object>} runPiped 的结果；目录不存在时按失败返回。
     */
    function runNpm(cwd, npmArgs, signal) {
        if (!isDirectory(cwd)) {
            return Promise.resolve({
                stdout: '', stderr: '', exitCode: null, timedOut: false,
                spawnError: `目录不存在：${cwd}`, truncated: false,
            })
        }
        return runShellCommand('npm', npmArgs, { cwd, timeoutMs: TASK_TIMEOUT_MS, signal })
    }

    /**
     * check：在会话工作区根目录跑一次类型检查，结果原样返回。
     * @param {string} root - 会话工作区根目录。
     * @param {AbortSignal} signal - 工具调用的取消信号。
     * @returns {Promise<string>} 模型可见的文本。
     */
    async function actionCheck(root, signal) {
        const compiler = resolveCompiler(root)
        const options = { cwd: root, timeoutMs: CHECK_TIMEOUT_MS, signal }
        // 主路径完全不经过 shell：process.execPath 跑 tsc 的 JS 入口，参数是常量数组，
        // 路径里的空格、`$`、反引号都不会被任何解释器处理。
        const result = compiler.kind === 'node'
            ? await runPiped(process.execPath, [compiler.file, ...TSC_ARGS], options)
            : await runShellCommand(compiler.kind === 'bin' ? compiler.file : 'tsc', TSC_ARGS, options)
        return renderCommandResult(result, { timeoutMs: CHECK_TIMEOUT_MS, spawnFail: '无法启动 TypeScript 编译器' })
    }

    /**
     * test：在工作区的 test 子目录跑 `npm run test`。
     * @param {string} root - 会话工作区根目录。
     * @param {AbortSignal} signal - 工具调用的取消信号。
     * @returns {Promise<string>} 模型可见的文本。
     */
    async function actionTest(root, signal) {
        const result = await runNpm(path.join(root, TEST_DIR_NAME), NPM_TEST_ARGS, signal)
        return renderCommandResult(result, { timeoutMs: TASK_TIMEOUT_MS, spawnFail: '无法执行 npm run test' })
    }

    /**
     * build：在工作区根目录跑一次 `npm run build`。
     *
     * 不接受任何路径或参数：要构建的东西必须写进根 package.json 的 build 脚本里。
     * 这样「构建什么」只有一处定义（package.json），工具无法另开一条绕过它的路径。
     * @param {string} root - 会话工作区根目录。
     * @param {AbortSignal} signal - 工具调用的取消信号。
     * @returns {Promise<string>} 模型可见的文本。
     */
    async function actionBuild(root, signal) {
        const result = await runNpm(root, NPM_BUILD_ARGS, signal)
        return renderCommandResult(result, { timeoutMs: TASK_TIMEOUT_MS, spawnFail: '无法执行 npm run build' })
    }

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
        const result = await runPiped(process.execPath, [script], { cwd: root, timeoutMs: SCRIPT_TIMEOUT_MS, signal })
        return { script, ...result, aborted: false }
    }

    /**
     * 依次处理每个路径项，逐个执行收集到的脚本。
     *
     * 遇到第一个问题（路径不存在 / 无 .js 脚本 / 起不来子进程 / 非零退出 / 超时）就
     * 停下，不再执行后面的脚本——后面的脚本多半依赖前面的结果，继续跑只会把同一条
     * 错误重复一遍。
     * @param {string} root - 会话工作区根目录。
     * @param {string[]} items - 模型给出的路径项。
     * @param {AbortSignal} signal - 工具调用的取消信号。
     * @returns {Promise<{runs: object[], failure: string | null}>} runs 为已执行的脚本结果，
     *   failure 为让序列停下的那个问题（正常跑完为 null）。
     */
    async function runScripts(root, items, signal) {
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
    function renderScriptRun(root, run) {
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
        if (run.timedOut) lines.push(`[timed out after ${SCRIPT_TIMEOUT_MS}ms]`)
        else if (run.exitCode !== 0) lines.push(`[exit code: ${run.exitCode}]`)
        return lines.join('\n')
    }

    /**
     * 各脚本的执行结果，原样返回：stdout、stderr、退出码标记。
     *
     * 整段文本封顶：脚本数量由模型决定，不封顶会把上下文打爆。
     * @param {string} root - 会话工作区根目录。
     * @param {object[]} runs - runScripts 返回的执行结果。
     * @param {string | null} failure - 让序列停下的问题。
     * @returns {string} 模型可见的文本。
     */
    function renderScriptResults(root, runs, failure) {
        const blocks = runs.map((run) => renderScriptRun(root, run))
        if (failure !== null) blocks.push(`[失败] ${failure}`)

        const text = blocks.join('\n')
        if (text.length <= MAX_OUTPUT_BYTES) return text
        return `${text.slice(0, MAX_OUTPUT_BYTES)}\n[输出被截断，仅保留前 ${MAX_OUTPUT_BYTES} 字符]`
    }

    /**
     * node：以项目根目录为基准解析 paths，把该路径下的所有 .js 脚本按顺序逐个执行。
     *
     * paths 可以是 .js 文件，也可以是目录；目录递归取其下所有 .js 文件（跳过
     * node_modules 与以 . 开头的目录，否则 `node .` 会把整棵依赖树跑一遍）。递归不进入
     * 链接：readdir 的 Dirent 对符号链接与 junction 都不报 isDirectory，因此它们既不被
     * 跟随也不会成环；但【点名】一个链接仍然有效（statSync 会跟随）。
     * @param {string} root - 会话工作区根目录。
     * @param {object} args - 已通过 schema 校验的参数。
     * @param {AbortSignal} signal - 工具调用的取消信号。
     * @returns {Promise<string>} 模型可见的文本。
     */
    async function actionNode(root, args, signal) {
        const items = splitPaths(args.paths)
        if (items.length === 0) {
            throw new Error('js 的 action=node 需要 paths 参数：以项目根目录为基准的相对路径，多个用英文逗号分隔')
        }
        const { runs, failure } = await runScripts(root, items, signal)
        return renderScriptResults(root, runs, failure)
    }

    /** 四个动作的实现；键就是 schema 里 enum 的取值，也用于执行前的白名单校验。 */
    const ACTIONS = {
        check: (root, _args, signal) => actionCheck(root, signal),
        node: (root, args, signal) => actionNode(root, args, signal),
        test: (root, _args, signal) => actionTest(root, signal),
        build: (root, _args, signal) => actionBuild(root, signal)
    }

    tools.register({
        name: 'js',
        description:
            'Run JavaScript tasks in the project, selected by `action`:'
            + ' check = type-check with `tsc --noEmit --pretty false` at the project root;'
            + ' node = run .js scripts given by `paths` (comma-separated, relative to the project root; a directory'
            + ' contributes every .js file beneath it, skipping node_modules and dot-directories), stopping at the first failure;'
            + ' test = run `npm run test` in the `test` subdirectory (takes no path);'
            + ' build = run `npm run build` at the project root (takes no path).'
            + ' Build targets are defined only by the build script in the root package.json.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['check', 'node', 'test', 'build'],
                    description: 'check: type-check the project. node: run the scripts in `paths`. test: run the test suite.'
                        + ' build: run the root package.json build script.'
                },
                paths: {
                    type: 'string',
                    description: 'node: comma-separated paths relative to the project root, e.g. scripts/build.js,src'
                }
            },
            required: ['action'],
            additionalProperties: false
        },
        output: textOutput(),
        async execute(args, exec) {
            const root = sessionRoot(exec, 'js')
            const action = args.action
            // 会话回放或手工调用可能带来 schema 之外的值：当场报错，而不是默默跑一条命令。
            if (typeof action !== 'string' || !Object.hasOwn(ACTIONS, action)) {
                throw new Error(`js 的 action 只能是 ${Object.keys(ACTIONS).join(' / ')}，收到 ${JSON.stringify(action)}`)
            }
            // paths 只对 node 有意义：给错动作就是理解错了，当场报错，而不是默默换个对象跑一遍。
            if (action !== 'node' && hasText(args.paths)) throw new Error('js 的 paths 只对 action=node 有意义')
            // build 不接受路径：构建目标只写在 package.json 的 build 脚本里。参数里带 project
            // 必须报错：静默忽略会让调用方以为构建了子项目，实际构建的是本体。
            if (hasText(args.project)) throw new Error('js 不接受 project：构建目标只能写在根 package.json 的 build 脚本里')

            const output = await ACTIONS[action](root, args, exec.signal)
            throwIfAborted(exec.signal)
            return { output }
        },
        // UI 呈现：每个动作等价于一条命令（node 动作是多条），按终端卡片呈现；回放时参数未经校验。
        presentCall: (args) => {
            const action = args !== null && typeof args === 'object' ? args.action : undefined
            if (action === 'check') return { card: 'terminal', title: `tsc ${TSC_ARGS.join(' ')}`, description: '运行 TypeScript 类型检查' }
            if (action === 'test') return { card: 'terminal', title: 'npm run test', description: '在 test 目录下运行测试' }
            if (action === 'build') return { card: 'terminal', title: 'npm run build', description: '构建项目' }
            if (action === 'node') return { card: 'terminal', title: `node ${pathsTitle(args)}`, description: '依次运行项目内的 JavaScript 脚本' }
            return { card: 'terminal', title: 'js …', description: '检查、跑脚本、跑测试或构建项目' }
        },
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
     * 继续删只会把不该删的东西删掉（与 js 的 node 动作同因）。
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
     * 与 js 同一口径——干净的退出不加任何标记，非零退出追加
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
// web —— Bing 搜索 + 网页抓取
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 用**免密钥**的 Bing 检索，结果按 Bing 原有顺序返回。
 *
 * 为什么自带搜索、不接官方 `ctx.web`：官方那条路只有 DeepSeek 一家 provider，
 * 且必须有 DEEPSEEK_API_KEY 或 DeepSeek 账号登录（见 dsh-web-search-deepseek
 * 的 available()）。本工具是**无凭据**的：只打公开搜索页，因此不依赖任何配置，
 * 也不占用官方的 provider 选择（两者的结果形态也不同——这里给的是标题+URL+摘要）。
 *
 * 只用 Bing 一个引擎：多引擎合并没有意义。`www.bing.com` 会 302 到
 * `cn.bing.com`，两个端点实际是同一个后端，合并出来的只是同一份结果的重复。
 *
 * 为什么全部走 node 内置 http 模块（见「出站 HTTP」一节）、不经 ctx.shell：与
 * js / delete / browser 同一套理由（见文件头）。URL 模板是本文件的常量，模型能
 * 给的只有查询词。
 * @param {object} tools - dsh-tools 注册表。
 */
function defineWeb(tools) {
    /** 搜索的单次请求预算：结果页偶尔会拖，超过就当作搜索失败。 */
    const SEARCH_TIMEOUT_MS = 15000
    /** 每个查询默认返回的条数上限（Bing 结果页的 `count` 默认量级）。 */
    const DEFAULT_LIMIT = 10

    /**
     * 把一个可选数值参数夹到 [min, max] 里。
     *
     * 缺省、非数值或非有限值一律退回 fallback 而不是报错：会话回放与手工调用可能
     * 带来任何东西，而 limit 只是一个「给多给少」的旋钮，夹紧比失败更有用。
     * 小数取整：条数只能是整数。
     * @param {unknown} raw - 模型传入的值。
     * @param {number} min - 允许的最小值。
     * @param {number} max - 允许的最大值。
     * @param {number} fallback - 缺省值。
     * @returns {number} 夹紧后的整数。
     */
    function clampNumber(raw, min, max, fallback) {
        const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
        return Math.min(max, Math.max(min, Math.trunc(value)))
    }

    /** 单条摘要的截断长度：摘要只用来判断相关性，不需要全文。 */
    const SNIPPET_CHARS = 240
    /** 整段最终文本的封顶：条数上限很高时仍可能打爆上下文。 */
    const MAX_RESULT_CHARS = 262144

    /**
     * 桌面 UA。这些搜索页对非浏览器 UA 会返回降级页或直接拦截，因此必须伪装。
     * 与 browser 工具无关：这里只发一个 GET，不需要真实 Chrome。
     */
    const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        + ' (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

    /**
     * 命名实体解码。
     *
     * 只做「够用」的那几个：搜索页里出现的就是这些，引一个完整的 HTML 解码器
     * 要额外依赖，而本文件刻意只用 node 内置模块（见文件头）。
     * @param {string} text - 含实体的文本。
     * @returns {string} 解码后的文本。
     */
    const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ' }
    function decodeEntities(text) {
        return text
            .replace(/&#x([0-9a-fA-F]+);/g, (whole, hex) => {
                const code = Number.parseInt(hex, 16)
                return Number.isFinite(code) ? String.fromCodePoint(code) : whole
            })
            .replace(/&#([0-9]+);/g, (whole, dec) => {
                const code = Number.parseInt(dec, 10)
                return Number.isFinite(code) ? String.fromCodePoint(code) : whole
            })
            .replace(/&([a-zA-Z]+);/g, (whole, name) => NAMED[name] ?? whole)
    }

    /**
     * 去标签 + 解码 + 压空白。
     *
     * 搜索页的标题与摘要里带 `<em>` 高亮、`&ensp;`、`&#0183;` 之类的东西，
     * 这些都不该原样交给模型。
     *
     * 「阅读更多」是 Bing 摘要旁的「展开」按钮文案：它**不在**摘要的 `<p>` 里，
     * 而是紧随其后的独立节点，因此不能靠「去掉结尾后缀」处理——它根本不该被
     * 抓进来。这里的过滤是最后一道保险。
     * @param {string} html - 一段 HTML 片段。
     * @returns {string} 纯文本。
     */
    function stripTags(html) {
        return decodeEntities(html.replace(/<[^>]*>/g, ' '))
            .replace(/\s+/g, ' ')
            .replace(/阅读更多/gu, '')
            .replace(/\s*…\s*$/u, '')
            .trim()
    }

    /**
     * 截断摘要。
     * @param {string} text - 纯文本摘要。
     * @returns {string} 至多 SNIPPET_CHARS 个字符的摘要。
     */
    const clipSnippet = (text) => (text.length <= SNIPPET_CHARS ? text : `${text.slice(0, SNIPPET_CHARS)}…`)

    /**
     * 发一个 GET 并取回文本。
     *
     * 走 httpGet（有代理走代理，没有就直连），不经 ctx.shell。重定向跟随：搜索页
     * 常有一次跳转。非 2xx 当作搜索失败而不是空结果——静默当空结果会让模型
     * 以为「这个词没有结果」。
     * @param {string} url - 目标地址（本文件的常量拼装，模型触及不到）。
     * @param {string} userAgent - 伪装用的 UA。
     * @param {AbortSignal} signal - 工具调用的取消信号。
     * @returns {Promise<string>} 响应正文。
     */
    async function httpText(url, userAgent, signal) {
        throwIfAborted(signal)
        try {
            const response = await httpGet(url, {
                timeoutMs: SEARCH_TIMEOUT_MS,
                signal,
                headers: {
                    'user-agent': userAgent,
                    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'accept-encoding': 'gzip, deflate, br',
                },
            })
            if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`)
            return response.body.toString('utf8')
        } catch (error) {
            if (signal.aborted) throwIfAborted(signal)
            if (error.name === 'AbortError') throwIfAborted(signal)
            throw new Error(describeHttpError(error))
        }
    }

    /**
     * 判定一次解析结果是否可信。
     *
     * 搜索站点的拦截页（「访问异常出错」「请输入验证码」）**仍然返回 HTTP 200**，
     * 只是正文里没有任何结果。若把这种情况当空数组返回，模型会以为「这个词没有
     * 结果」——而真实原因是被限流。因此解析出 0 条时必须抛错，让失败原因随
     * 结果一起报上去。
     * @param {object[]} hits - 解析出的命中。
     * @param {string} source - 站点名，只进报错文案。
     * @returns {object[]} 原样返回的命中（非空）。
     */
    function requireHits(hits, source) {
        if (hits.length === 0) throw new Error(`${source} 没有解析出结果（可能被限流或页面改版）`)
        return hits
    }

    // ── fetch：抓一个网址，把页面内容取回 ──────────────────────────────────────
    //
    // 与上面「搜索」是同一工具的两个动作：web 负责**模糊定位**（哪几个 URL 值得看），
    // fetch 负责**精确取回**（那个 URL 里到底写了什么）。分成两个工具会让
    // 「先搜后取」变成跨工具的对话，而它们共用同一套 HTTP 与编码处理。

    /** fetch 的超时预算：正文页比搜索页大得多，给足 30 秒。 */
    const FETCH_TIMEOUT_MS = 30000
    /** 抓回正文的字符上限：单页动辄几十万字符，不封顶会直接打爆上下文。 */
    const MAX_FETCH_CHARS = 131072
    /** 响应体字节上限：先按字节拦住，避免把超大文件整个读进内存。 */
    const MAX_FETCH_BYTES = 8 * 1024 * 1024
    /** 可解析为文本的内容类型前缀；其余（图片、压缩包、二进制）一律拒绝。 */
    const TEXTUAL_TYPES = ['text/', 'application/json', 'application/xml', 'application/javascript',
        'application/x-javascript', 'application/rss+xml', 'application/atom+xml', 'application/xhtml+xml']

    /**
     * 从 Content-Type 或 HTML 头部的 meta 推断字符集。
     *
     * 中文站点里 GBK/GB2312 仍然常见，直接按 UTF-8 解会得到整页乱码。因此先看
     * 响应头，再退回扫前 4KB 的 `<meta charset>`；都没有就按 UTF-8。
     * @param {string} contentType - 响应的 content-type。
     * @param {Uint8Array} headBytes - 正文开头若干字节（用于找 meta）。
     * @returns {string} 字符集名（交给 TextDecoder）。
     */
    function detectCharset(contentType, headBytes) {
        const fromHeader = /charset=["']?([^\s;'"]+)/i.exec(contentType)?.[1]
        if (fromHeader !== undefined) return fromHeader
        // 头部可能是任意编码，先用 UTF-8 尽力解出 ASCII 的 meta 声明即可。
        const head = new TextDecoder('utf-8').decode(headBytes)
        const fromMeta = /<meta[^>]+charset=["']?([^\s;"'>]+)/i.exec(head)?.[1]
        return fromMeta ?? 'utf-8'
    }

    /**
     * 把 HTML 转成可读纯文本。
     *
     * 刻意不引 HTML 解析器（本文件只用 node 内置模块，见文件头），因此用一串
     * 正则分阶段处理。顺序很重要：先删整段 `<script>`/`<style>`（否则里面的
     * JS 会被当成正文），再把块级标签换成换行（否则整页会挤成一行），最后才
     * 去掉剩余标签。
     *
     * 代码块（`<pre>`/`<code>`）必须**保住原有缩进与换行**：技术文档的价值大半
     * 在示例代码里，按普通段落那样压空白会把 `function f() {` 和 `return x;`
     * 挤成一行，读起来完全走样。因此先把它整块摘出来、用占位符挡住，处理完
     * 其余文本后再原样放回。
     * @param {string} html - 原始 HTML。
     * @returns {string} 纯文本，段落之间保留空行。
     */
    function htmlToText(html) {
        // 1) 先删掉注释与整段脚本/样式。
        //
        // **顺序至关重要**：这一步必须在摘代码块之前做。站点的 JS 源码里常出现
        // 形如 `noteContent.replace(/<pre>/, …)` 的**字符串字面量**，它们含有
        // `<pre>` 文本；若先摘代码块，正则会把脚本里的这些假标签当成真的代码块，
        // 与页面里真正的 `<pre>` 错位配对，把正文大段吞掉或撕碎（实测菜鸟教程
        // 就是这样：一个脚本里的 `<pre>` 把后面整段正文配成了「代码块」）。
        let text = html
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/<(script|style|noscript|svg|iframe|template|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')

        // 2) 摘出代码块，用占位符占位（占位符不含标签，不会被打扰）。
        //
        // 代码块的形态不止 `<pre>`：不少站点（例如菜鸟教程）用
        // `div.example_code` + `<br />` + `&nbsp;` 做缩进来呈现示例，语法高亮则是
        // 一堆 `<span style="color:…">`。这些同样必须按原样保留，否则示例代码会
        // 被压成一行。先匹配 `pre`/`textarea`（它们可能内含 `<code>`），再匹配
        // `div.example_code`。
        const blocks = []
        text = text.replace(
            /<(pre|textarea)[^>]*>[\s\S]*?<\/\1>|<div[^>]*class="[^"]*example_code[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
            (whole) => {
                // 块内常被语法高亮拆成行级标签（`<span>`、`<br>`）。把 `<br>` 与
                // 块级边界还原成换行、其余标签去掉，再把每个非空行左侧的缩进
                // **原样保留**——这正是普通段落处理会毁掉的部分。
                //
                // `&nbsp;` 必须在「压空白」之前先变成普通空格，否则它会和
                // 连续空格一起被折叠掉，缩进就没了。
                const inner = whole
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/?(?:div|p|li|tr)[^>]*>/gi, '\n')
                    .replace(/<[^>]*>/g, '')
                    .replace(/&nbsp;/gi, ' ')
                blocks.push(
                    decodeEntities(inner)
                        .replace(/\r\n/g, '\n')
                        // 只裁掉整体首尾空行，不动行内缩进。
                        .replace(/^[ \t]*\n+|\n+[ \t]*$/g, ''),
                )
                return `\u0000CODE${blocks.length - 1}\u0000`
            },
        )

        // 3) 块级边界 → 换行，保住段落结构；其余标签直接去掉（保留内部文本）。
        text = text
            .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6]|table|tr|td|th|section|article|header|footer|nav|aside|main|blockquote|pre|figure|form)[^>]*>/gi, '\n')
            .replace(/<[^>]*>/g, ' ')

        text = decodeEntities(text)
            .split('\n')
            .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim()

        // 4) 把代码块放回原处，保持它自己的换行与缩进。
        return text.replace(/\u0000CODE(\d+)\u0000/g, (_whole, index) => blocks[Number(index)] ?? '')
    }

    /**
     * 从 `<div …>` 的起始位置取出配对的整块（按嵌套层数计数）。
     *
     * 不能用非贪婪的 `([\s\S]*?)</div>`：正文容器内部一定嵌套着别的 div
     * （列表、示例块、卡片），那样会在第一个 `</div>` 处提前截断，把正文切成
     * 半截（实测菜鸟教程的 article-body 就是这样：代码示例全被切掉，只剩标题
     * 和开头两段）。这里改为从起点扫，遇到 `<div` 加一层、遇到 `</div>` 减一层，
     * 归零处就是真正的闭合位置。
     * @param {string} html - 原始 HTML。
     * @param {number} openIndex - 起始 `<div` 的下标。
     * @returns {string | null} 配对后的内部内容，找不到闭合时返回 null。
     */
    function sliceBalancedDiv(html, openIndex) {
        const tagPattern = /<div\b[^>]*>|<\/div>/gi
        tagPattern.lastIndex = openIndex
        let depth = 0
        let match
        while ((match = tagPattern.exec(html)) !== null) {
            depth += match[0].length > 1 && match[0][1] === '/' ? -1 : 1
            if (depth === 0) {
                // match.index 指向闭合标签，内部内容就是开标签之后到它之前。
                const start = html.indexOf('>', openIndex) + 1
                return html.slice(start, match.index)
            }
        }
        return null
    }

    /**
     * 尝试只取正文，而不是整页（含导航、侧栏、页脚）。
     *
     * 实测一个文档站整页转文本后 7.4k 字符，其中前 1.2k 全是侧边栏目录；只取
     * 正文容器能砍掉大半噪音。策略是「按已知容器切块，选转文本后最长的那块」，
     * 不引入任何权重算法——够用且不会误判。找不到任何容器时返回 null，由调用方
     * 回退到整页。
     * @param {string} html - 原始 HTML。
     * @returns {{text: string, container: string} | null} 正文与它来自哪个容器。
     */
    function extractMainText(html) {
        const candidates = []
        for (const tag of ['article', 'main']) {
            for (const match of html.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))) {
                candidates.push({ container: tag, html: match[1] })
            }
        }
        // 常见正文容器的类名（覆盖博客、文档站与论坛）。用 sliceBalancedDiv 取
        // 配对整块，避免被内部嵌套的 div 提前截断。
        for (const name of ['article-body', 'post-content', 'entry-content', 'markdown-body',
            'article_content', 'rich_media_content', 'main-content']) {
            const opener = new RegExp(`<div[^>]*class="[^"]*${name}[^"]*"[^>]*>`, 'gi')
            for (const match of html.matchAll(opener)) {
                const inner = sliceBalancedDiv(html, match.index)
                if (inner !== null) candidates.push({ container: `div.${name}`, html: inner })
            }
        }
        if (candidates.length === 0) return null

        let best = null
        for (const candidate of candidates) {
            const text = htmlToText(candidate.html)
            if (best === null || text.length > best.text.length) {
                best = { text, container: candidate.container }
            }
        }
        // 正文容器比整页还小得离谱时（多半是误匹配到一个小 div），不如用整页。
        if (best === null || best.text.length < 200) return null
        return best
    }

    /**
     * 抓一个网址并把内容取回。
     *
     * 与搜索用的 httpText 分开：那条只关心「有没有解析出结果」，这条要拿到
     * 字节、判定编码、区分内容类型，并处理 404/403 这类「有响应但不该当正文」的
     * 情况。非 2xx **不抛错**而是如实报出状态码——抓取失败本身是结果的一部分
     * （模型需要知道是 404 还是 403 才能决定下一步）。
     * @param {string} url - 模型给出的完整网址（已由 assertFetchableUrl 校验）。
     * @param {AbortSignal} signal - 工具调用的取消信号。
     * @returns {Promise<object>} 抓取结果。
     */
    async function fetchPage(url, signal) {
        throwIfAborted(signal)

        let response
        try {
            response = await httpGet(url, {
                timeoutMs: FETCH_TIMEOUT_MS,
                signal,
                headers: {
                    'user-agent': UA_DESKTOP,
                    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'accept-encoding': 'gzip, deflate, br',
                },
            })
        } catch (error) {
            if (signal.aborted) throwIfAborted(signal)
            if (error.name === 'AbortError') throwIfAborted(signal)
            // 报出真实病因：连不上 / 代理拒绝 / DNS 失败，各不相同。
            throw new Error(`抓取失败：${describeHttpError(error)}`)
        }

        const contentType = response.headers['content-type'] ?? ''
        const status = response.status
        const finalUrl = response.url

        // 非 2xx：如实报出，不当作正文。
        if (status < 200 || status >= 300) {
            return { status, finalUrl, contentType, ok: false, reason: `HTTP ${status} ${response.statusText}`.trim() }
        }

        // 内容类型不在文本范围内（图片、PDF、压缩包）：不读正文，说明原因即可。
        const lowered = contentType.toLowerCase()
        if (lowered.length > 0 && !TEXTUAL_TYPES.some((prefix) => lowered.startsWith(prefix))) {
            return { status, finalUrl, contentType, ok: false, reason: `不是文本内容（content-type: ${contentType || '未知'}），未读取正文` }
        }

        const bytes = new Uint8Array(response.body)
        throwIfAborted(signal)

        if (bytes.byteLength > MAX_FETCH_BYTES) {
            return {
                status, finalUrl, contentType, ok: false,
                reason: `响应体过大（${bytes.byteLength} 字节，上限 ${MAX_FETCH_BYTES}），未解析`,
            }
        }

        const charset = detectCharset(contentType, bytes.slice(0, 4096))
        let raw
        try {
            raw = new TextDecoder(charset.toLowerCase()).decode(bytes)
        } catch {
            // 未知字符集名：退回 UTF-8，而不是让整次抓取失败。
            raw = new TextDecoder('utf-8').decode(bytes)
        }

        const isHtml = lowered.includes('html') || /^<!doctype\s+html|<html[\s>]/i.test(raw.slice(0, 1024))
        return { status, finalUrl, contentType, ok: true, charset, raw, isHtml }
    }

    /**
     * 校验并规范化 fetch 的 url 参数。
     *
     * 只接受完整的 http(s) 网址：模型从搜索结果里拿到的是绝对 URL，若它给出
     * 相对路径或别的协议，那是理解错了，当场报错比发一个必然失败的请求好。
     * @param {unknown} raw - 模型传入的 url。
     * @returns {string} 规范化后的绝对网址。
     */
    function assertFetchableUrl(raw) {
        if (typeof raw !== 'string' || raw.trim().length === 0) {
            throw new Error('web 的 action=fetch 需要 url 参数：一个完整的网址（含 http:// 或 https://）')
        }
        const trimmed = raw.trim()
        let parsed
        try {
            parsed = new URL(trimmed)
        } catch {
            throw new Error(`web 的 url 不是合法网址：${JSON.stringify(trimmed)}`)
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`web 的 url 只支持 http/https，收到 ${JSON.stringify(parsed.protocol)}`)
        }
        return parsed.href
    }

    /**
     * 把一次抓取渲染成模型可见的文本。
     *
     * 头部给出状态码与最终地址（重定向后可能变化，模型需要知道），然后是正文。
     * `mode: 'raw'` 时返回原始响应（HTML 源码或 JSON 原文），不转纯文本——用于
     * 「我要看这个页面的结构」或「这是个 API」的情形。
     * @param {object} result - fetchPage 的返回值。
     * @param {string} mode - 'text' 或 'raw'。
     * @returns {string} 一段纯文本。
     */
    function renderFetch(result, mode) {
        const lines = [`$ fetch ${result.finalUrl}`]
        if (!result.ok) {
            lines.push(`[失败] ${result.reason}`)
            return lines.join('\n')
        }

        if (result.finalUrl !== result.requestedUrl) lines.push(`[重定向至] ${result.finalUrl}`)
        lines.push(`[状态] ${result.status} · ${result.contentType || '未知类型'}${result.isHtml ? '' : ' · 非 HTML'} · 编码 ${result.charset}`)

        let body
        let container = null
        if (mode === 'raw') {
            body = result.raw
        } else if (result.isHtml) {
            const main = extractMainText(result.raw)
            if (main !== null) {
                body = main.text
                container = main.container
            } else {
                body = htmlToText(result.raw)
            }
        } else {
            // JSON / 纯文本：本身就是可读内容，原样给出。
            body = result.raw.trim()
        }

        if (container !== null) lines.push(`[正文来源] ${container}`)
        const truncated = body.length > MAX_FETCH_CHARS
        lines.push('')
        lines.push(truncated ? `${body.slice(0, MAX_FETCH_CHARS)}\n[正文被截断，仅保留前 ${MAX_FETCH_CHARS} 字符]` : body)
        return lines.join('\n')
    }

    /**
     * 搜索 Bing，按结果页原有顺序返回命中。
     *
     * 走 HTML 结果页而不是 `format=rss`：RSS 出口在没有 Cookie 时会被降级，
     * 对同一查询反复返回完全不相干的结果；HTML 页在同样条件下更稳定。
     * `mkt=zh-CN` 显式指定中文市场，避免按 IP 猜错市场。
     * @param {string} query - 查询词。
     * @param {number} limit - 最多返回的条数。
     * @param {AbortSignal} signal - 工具调用的取消信号。
     * @returns {Promise<{hits: object[], truncated: boolean}>} 命中列表与是否被截断。
     */
    async function searchBing(query, limit, signal) {
        const body = await httpText(
            `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${limit}&mkt=zh-CN`,
            UA_DESKTOP, signal,
        )
        const hits = []
        let truncated = false
        // 每条自然结果是一个 <li class="b_algo"> 块；块内标题是 <h2><a href=…>，
        // 摘要是 b_lineclamp* 的 <p>（Bing 按行数给出不同后缀的类名）。
        for (const block of body.split(/<li class="b_algo"/).slice(1)) {
            if (hits.length >= limit) {
                truncated = true
                break
            }
            const seg = block.slice(0, 4000)
            const anchor = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/s.exec(seg)
            if (anchor === null) continue
            const url = decodeEntities(anchor[1])
            const title = stripTags(anchor[2])
            const snippet = stripTags(
                /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/s.exec(seg)?.[1] ?? '',
            )
            if (title.length === 0 || !/^https?:/i.test(url)) continue
            hits.push({ title, url, snippet: clipSnippet(snippet) })
        }
        return { hits: requireHits(hits, 'Bing'), truncated }
    }

    /**
     * 把一次搜索渲染成模型可见的文本。
     * @param {string} query - 查询词。
     * @param {object} outcome - searchBing 的返回值。
     * @param {number} limit - 条数上限。
     * @returns {string} 一段纯文本。
     */
    function renderQuery(query, outcome, limit) {
        const lines = [`## ${query}`]
        for (const [index, hit] of outcome.hits.entries()) {
            lines.push(`${index + 1}. ${hit.title}`)
            lines.push(`   ${hit.url}`)
            if (hit.snippet.length > 0) lines.push(`   ${hit.snippet}`)
        }
        if (outcome.truncated) lines.push(`（已达条数上限 ${limit}，可能有更多结果）`)
        return lines.join('\n')
    }

    /**
     * 校验查询词。
     *
     * `query` 是一个查询词，原样交给 Bing：它本身可以含逗号、空格、引号、减号等
     * 搜索语法，这些都不该被本工具解释。这里只做「有没有给」与首尾空白。
     * @param {unknown} raw - 模型传入的 query。
     * @returns {string} 去掉首尾空白的查询词。
     */
    function assertQuery(raw) {
        if (typeof raw !== 'string' || raw.trim().length === 0) {
            throw new Error('web 需要 query 参数：一个查询词')
        }
        return raw.trim()
    }

    tools.register({
        name: 'web',
        description:
            'Web research in two steps: find candidate URLs, then read the ones worth reading.'
            + ' `action` selects which step you are on.'
            + '\n\n'
            + 'action=search (default) — find out WHICH urls are relevant.'
            + ' `query` is a single query, passed to Bing as written; results keep Bing\'s original order'
            + ' and include title + URL + snippet.'
            + '\n\n'
            + 'Send one query per call. If you have several distinct topics, make several web calls.'
            + '\n\n'
            + 'action=fetch — read WHAT a specific url actually says.'
            + ' `url` is one complete http(s) URL, normally copied from a search result; redirects are followed'
            + ' and the final URL is reported. HTML is reduced to readable text with the main article body'
            + ' extracted when the page has one; JSON and plain text come back as-is.'
            + ' `mode=raw` returns the untouched body instead, for API responses or to inspect markup.'
            + '\n\n'
            + 'The intended flow is search first (fuzzy), then fetch the promising urls (precise).'
            + ` Snippets are truncated to about ${SNIPPET_CHARS} characters and exist only to rank relevance —`
            + ' never present a snippet as the content of the page; fetch it when the wording matters.'
            + '\n\n'
            + 'Optional `limit` caps the number of results (1-30, default 10).'
            + '\n\n'
            + 'No API key is required: Bing is queried directly and fetch is a plain HTTP GET.'
            + ' The two actions are mutually exclusive — search takes query/limit,'
            + ' fetch takes url/mode; passing the wrong group is an error, not a silent no-op.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['search', 'fetch'],
                    description: 'search: find candidate urls (default when omitted). fetch: read one url.'
                },
                query: {
                    type: 'string',
                    description: 'search: one query, e.g. "typescript 泛型约束". Sent to Bing as written,'
                        + ' so search syntax such as quotes or a minus sign works. Use one query per call.'
                },
                url: {
                    type: 'string',
                    description: 'fetch: one complete URL including http:// or https://, normally copied from a search'
                        + ' result. Redirects are followed and the final URL is reported.'
                },
                mode: {
                    type: 'string',
                    enum: ['text', 'raw'],
                    description: 'fetch: text (default) converts HTML to readable text and extracts the main article;'
                        + ' raw returns the untouched response body (use it for JSON APIs or to inspect markup).'
                },
                limit: {
                    type: 'number',
                    description: `search: maximum number of results to return (1-30). Default ${DEFAULT_LIMIT}.`
                }
            },
            required: [],
            additionalProperties: false
        },
        output: textOutput(),
        async execute(args, exec) {
            // 本工具不发子进程、不碰文件系统，因此不需要会话工作区：输入只有查询词
            // 或一个网址，边界由 assertSingleQuery / assertFetchableUrl 与白名单校验负责。
            //
            // action 缺省为 search：fetch 是后来加的动作，旧调用方（以及模型的习惯）
            // 都只传 query，让它们继续工作比强迫补一个 action 更合适。
            const action = typeof args.action === 'string' ? args.action : 'search'
            if (action !== 'search' && action !== 'fetch') {
                throw new Error(`web 的 action 只能是 search / fetch，收到 ${JSON.stringify(args.action)}`)
            }

            if (action === 'fetch') {
                // 动作互斥：给了 query 却要 fetch，说明理解错了，当场报错而不是默默忽略。
                if (hasText(args.query)) throw new Error('web 的 action=fetch 不接受 query；要搜索请用 action=search')
                if (typeof args.limit === 'number') {
                    throw new Error('web 的 limit 只对 action=search 有意义')
                }
                const mode = typeof args.mode === 'string' ? args.mode : 'text'
                if (mode !== 'text' && mode !== 'raw') {
                    throw new Error(`web 的 mode 只能是 text / raw，收到 ${JSON.stringify(args.mode)}`)
                }
                const url = assertFetchableUrl(args.url)
                const result = await fetchPage(url, exec.signal)
                result.requestedUrl = url
                throwIfAborted(exec.signal)
                return { output: renderFetch(result, mode) }
            }

            // 以下为 search。
            if (hasText(args.url)) throw new Error('web 的 url 只对 action=fetch 有意义')
            if (hasText(args.mode)) throw new Error('web 的 mode 只对 action=fetch 有意义')
            const query = assertQuery(args.query)
            const limit = clampNumber(args.limit, 1, 30, DEFAULT_LIMIT)

            throwIfAborted(exec.signal)
            const outcome = await searchBing(query, limit, exec.signal)
            const text = renderQuery(query, outcome, limit)
            if (text.length <= MAX_RESULT_CHARS) return { output: text }
            return { output: `${text.slice(0, MAX_RESULT_CHARS)}\n[输出被截断，仅保留前 ${MAX_RESULT_CHARS} 字符]` }
        },
        // UI 呈现：搜索按 search 卡片，抓取按 terminal 卡片（它等价于一条 GET）。
        presentCall: (args) => {
            if (args === null || typeof args !== 'object') return { card: 'generic', title: 'web …', kind: 'search' }
            if (args.action === 'fetch') {
                const url = typeof args.url === 'string' && args.url.length > 0 ? args.url : '…'
                return { card: 'terminal', title: `fetch ${url}`, description: '抓取网页内容' }
            }
            const query = typeof args.query === 'string' && args.query.length > 0 ? args.query : '…'
            return { card: 'generic', title: `web ${query}`, kind: 'search' }
        },
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
    js: defineJs,
    delete: defineDelete,
    browser: defineBrowser,
    web: defineWeb
}

/** 本文件提供的全部工具名，按声明顺序（也是注册顺序）。 */
const TOOL_NAMES = Object.keys(DEFINITIONS)

module.exports = {
    // 与 profile patch / 预设声明里的条目 id 同名（与其余自建插件的条目 id 同一约定），日志里好对号。
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
