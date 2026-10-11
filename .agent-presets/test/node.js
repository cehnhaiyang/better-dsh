'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// node.js —— test / ts-build 预设的 node 工具（零依赖本地插件）
//
// 设计原则（唯一职责）：
//   在【不向模型暴露任何命令行工具】的前提下，给模型一个「跑脚本」的按钮。
//   模型写完或改完脚本后调用 node，本工具以项目根目录为基准解析参数里的路径，
//   把该路径下的所有 .js 脚本按顺序逐个用 node 执行，把结果原样返回。
//
// 参数（本预设的本地插件里唯一带参数的一个，因此也是唯一需要校验的一个）：
//   paths —— 以项目根目录为基准的相对路径，多个用英文逗号分隔；
//   路径可以是 .js 文件，也可以是目录，目录递归取其下所有 .js 文件。
//   递归时跳过 node_modules 与以 . 开头的目录：它们不是项目自己的脚本，
//   否则 `node .` 会把整棵依赖树跑一遍。
//   递归不进入链接：readdir 的 Dirent 对符号链接与 junction 都不报 isDirectory，
//   因此它们既不被跟随也不会成环。但【点名】一个链接仍然有效——statSync 会跟随，
//   所以 `node linkdir` 能跑链接指向的目录（实测 Windows junction 可跑）。
//
// 两道边界，都立在模型输入这一侧：
//   - 路径必须落在会话工作区之内（绝对路径与 `..` 穿越一律拒绝），
//     让「以项目根目录为基准」成为硬约束而不是口头约定；
//   - 某个路径下没有任何 .js 脚本时按失败处理并停止，不静默跳过：
//     静默跳过会让模型以为脚本已经跑过了。
//
// 执行顺序与中断：按参数顺序、每个路径内按名称排序深度优先，逐个执行；
// 遇到第一个问题（路径不存在 / 无 .js 脚本 / 起不来子进程 / 非零退出 / 超时）
// 就停下，不再执行后面的脚本——后面的脚本多半依赖前面的结果，继续跑只会把
// 同一条错误重复一遍（与 git-commit.js 里 `add` 失败就不再 `commit` 同因）。
//
// 为什么裸注册、不 import defineTool：
//   本文件被 ~/.dsh/.js 复制到 profile 的 preset-assets/<id>/ 下（编辑源在
//   用户预设目录），两处都不在任何 node_modules 链上，Node 的 require 向上查找
//   永远到不了 harness 的 node_modules，`import '@deepseek-ai/dsh-tools'` 必然失败。而
//   ctx.tools.register() 直接接受原始 JSON Schema 定义（dsh-mcp-client 就是
//   这样注册的），因此本文件只用 node 内置模块。
//
// 为什么【不】经由 ctx.shell（与 typecheck.js / test.js 同因，别改回去）：
//   ctx.shell 是宿主平面的沙箱执行接缝。走它就必须先让沙箱给工作区根目录授予写
//   权限（Windows ACL 后端的 grantWrite / SetNamedSecurityInfoW），于是这个工具被
//   绑上「必须拿到写权限」的前置条件，而授权失败时工具直接不可用（实测
//   D:\the-play：SetNamedSecurityInfoW Win32 5 ACCESS_DENIED，命令根本没跑）。
//   本工具只读脚本、只执行脚本，不该申请写权限。
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

/** 模型侧可见的工具名。 */
const TOOL_NAME = 'node'
/** 单个脚本的超时预算：脚本可能是构建、生成或迁移，给足 5 分钟。 */
const TIMEOUT_MS = 300000
/** 单个脚本单流、以及整次调用最终文本的捕获上限（字符）。 */
const MAX_OUTPUT_BYTES = 262144

/** 递归时是否跳过该目录：依赖树与隐藏目录都不是项目自己的脚本。 */
const isSkippedDir = (name) => name === 'node_modules' || name.startsWith('.')

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
 * 这是本工具的信任边界：模型输入不可信，「以项目根目录为基准」由这里强制，
 * 而不是靠模型自觉。绝对路径与 `..` 穿越都会解析到工作区之外，一律拒绝。
 * @param {string} root - 会话工作区根目录。
 * @param {string} item - 模型给出的一项路径。
 * @returns {{ok: true, absolute: string} | {ok: false, reason: string}}
 */
function resolveInside(root, item) {
  const absolute = path.resolve(root, item)
  const relative = path.relative(root, absolute)
  if (relative.length === 0) return { ok: false, reason: `${item}：不能是项目根目录本身` }
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { ok: false, reason: `${item}：超出项目根目录` }
  }
  return { ok: true, absolute }
}

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
 * 用 node 执行一个脚本并把结果收成
 * { stdout, stderr, exitCode, timedOut, spawnError, truncated, aborted }。
 *
 * 不走 ctx.shell（原因见文件头注释）。用 process.execPath 而不是 'node'：
 * 那就是当前 harness 进程自己在跑的那个解释器，不依赖 PATH。
 * @param {string} root - 会话工作区根目录（作为 cwd，不取自模型输入）。
 * @param {string} script - 脚本的绝对路径。
 * @param {AbortSignal} signal - 工具调用的取消信号。
 * @returns {Promise<object>} 见上。
 */
function runScript(root, script, signal) {
  const idle = { script, stdout: '', stderr: '', exitCode: null, timedOut: false, spawnError: null, truncated: false, aborted: false }
  // 信号若已中止，监听器不会再触发（abort 只派发一次），必须在这里挡住，
  // 否则取消之后仍会把后面的脚本一个个跑完。
  if (signal.aborted) return Promise.resolve({ ...idle, aborted: true })

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, [script], {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ...idle, spawnError: error.message })
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
    }, TIMEOUT_MS)

    const onAbort = () => child.kill()
    signal.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk.toString('utf8')) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk.toString('utf8')) })

    const finish = (exitCode, spawnError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ script, stdout, stderr, exitCode, timedOut, spawnError, truncated, aborted: false })
    }

    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code, null))
  })
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

/** 追加截断提示。 */
function streamText(text, truncated) {
  if (!truncated) return text
  return `${text}\n[输出被截断，仅保留前 ${MAX_OUTPUT_BYTES} 字符]`
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
  const out = streamText(run.stdout, run.truncated)
  if (out.length > 0) lines.push(out)
  if (run.stderr.length > 0) lines.push(`[stderr]\n${streamText(run.stderr, run.truncated)}`)
  // 无输出的脚本也可能是正常的（比如只做副作用），如实说一句，避免看起来像没跑。
  if (lines.length === 1) lines.push('(no output)')
  if (run.timedOut) lines.push(`[timed out after ${TIMEOUT_MS}ms]`)
  else if (run.exitCode !== 0) lines.push(`[exit code: ${run.exitCode}]`)
  return lines.join('\n')
}

/**
 * 各脚本的执行结果，原样返回：stdout、stderr、退出码标记。
 *
 * 与 pwsh 工具的呈现口径一致——非零退出才追加 `[exit code: N]`，
 * 干净的退出不加任何标记。不做归纳、不加结论。
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

/** presentCall 在会话回放时会收到未经校验的参数，取值一律防御性处理。 */
function titleOf(args) {
  const paths = args !== null && typeof args === 'object' ? args.paths : undefined
  return typeof paths === 'string' && paths.length > 0 ? paths : '…'
}

module.exports = {
  name: 'tool-node',
  // 只依赖 tools 注册表：本工具自己起子进程，不需要 shell 接缝（原因见文件头）。
  inject: ['tools'],

  apply(ctx) {
    const tools = ctx.get('tools')
    if (tools === undefined) {
      console.error('[tool-node] 缺少 tools 服务，node 工具未注册')
      return
    }

    tools.register({
      name: TOOL_NAME,
      description:
        '运行当前项目里的 JavaScript 脚本。参数是以项目根目录为基准的相对路径，多个用英文逗号分隔；'
        + '路径可以是 .js 文件，也可以是目录（递归取其下所有 .js 文件，跳过 node_modules 与隐藏目录）。'
        + '按顺序逐个用 node 执行，遇到第一个失败即停止。直接调用即可看到每个脚本的输出与退出码。',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'string',
            description: '以项目根目录为基准的相对路径，多个用英文逗号分隔，例如 scripts/build.js,src'
          }
        },
        required: ['paths'],
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
        if (agent === undefined) throw new Error('node 需要 agent 会话')
        const root = agent.session.header.cwd
        if (typeof root !== 'string' || root.length === 0) throw new Error('node 需要会话工作区')

        const items = splitPaths(args.paths)
        if (items.length === 0) {
          throw new Error('node 需要 paths 参数：以项目根目录为基准的相对路径，多个用英文逗号分隔')
        }

        const { runs, failure } = await runAll(root, items, exec.signal)

        // 取消不是脚本的执行结果，按工具中断上报。
        if (exec.signal.aborted) {
          const error = new Error('tool call aborted')
          error.name = 'AbortError'
          error.code = 'ABORTED'
          throw error
        }

        return { output: renderResult(root, runs, failure) }
      },
      // UI 呈现：跑脚本就是一条命令，按终端卡片呈现。
      presentCall: (args) => ({
        card: 'terminal',
        title: `node ${titleOf(args)}`,
        description: '依次运行项目内的 JavaScript 脚本'
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
