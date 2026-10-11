'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// git-commit.js —— ts-build 预设的 git_commit 工具（零依赖本地插件）
//
// 设计原则（唯一职责）：
//   在【不向模型暴露任何命令行工具】的前提下，给模型一个「提交」的按钮。
//   模型做完一批改动后调用 git_commit；本工具在会话工作区根目录把项目的所有
//   改动提交到当前分支，并把 git 的执行结果原样返回。
//
// 因此本工具：
//   - 不接受任何参数：模型无法借此指定命令、参数、路径或提交信息，没有可注入的入口；
//   - 命令与提交信息由本文件写死（GIT_ADD_ARGS / GIT_COMMIT_ARGS），模型看不到也改不了；
//   - 结果就是 git 的执行结果本身，不做归纳、不加结论、不回显命令与路径，
//     与人在项目根目录直接敲一次提交所见一致。
//
// 为什么是两步 git 而不是一步（别改成 `git commit -a`）：
//   `commit -a` 只覆盖【已跟踪】文件的改动，新建的文件不在其中，而「项目的所有
//   更改」必须包含它们。因此先 `add -A` 暂存全部改动（新文件、修改、删除），
//   再 commit。两步都写死在本文件里，模型侧仍然只有一个按钮。
//
// 为什么裸注册、不 import defineTool：
//   本文件被 ~/.dsh/.js 复制到 profile 的 preset-assets/ts-build/ 下（编辑源在
//   用户预设目录），两处都不在任何 node_modules 链上，Node 的 require 向上查找
//   永远到不了 harness 的 node_modules，`import '@deepseek-ai/dsh-tools'` 必然失败。而
//   ctx.tools.register() 直接接受原始 JSON Schema 定义（dsh-mcp-client 就是
//   这样注册的），因此本文件只用 node 内置模块。
//
// 为什么【不】经由 ctx.shell（与 typecheck.js / test.js 同因，别改回去）：
//   ctx.shell 是宿主平面的沙箱执行接缝。走它就必须先让沙箱给工作区根目录授予写
//   权限（Windows ACL 后端的 grantWrite / SetNamedSecurityInfoW），于是这个工具被
//   绑上「必须拿到写权限」的前置条件：
//     - 授权失败时工具直接不可用（实测 D:\the-play：SetNamedSecurityInfoW Win32 5
//       ACCESS_DENIED，命令根本没跑）；
//     - 工具 schema 是零参数（见下），模型无法传 sandbox_permissions/justification
//       提权重试，只能卡死。
//
//   因此这里直接用 child_process 执行。安全性由「不可注入」保证，而不是由沙箱保证：
//     - 命令与参数是本文件的常量，模型无法触及、无法拼接；
//     - 工具零参数，没有可注入的入口；
//     - cwd 固定为会话工作区根，不取自模型输入。
// ─────────────────────────────────────────────────────────────────────────────

const { spawn } = require('node:child_process')

/** 模型侧可见的工具名。 */
const TOOL_NAME = 'git_commit'
/** 单次执行的超时预算：提交可能触发 pre-commit 钩子（格式化、测试）。 */
const TIMEOUT_MS = 300000
/** 写死的提交信息：模型无法指定，避免为此开出可注入的入口。 */
const COMMIT_MESSAGE = '更新'
/** 写死的暂存参数：-A 覆盖新文件、修改与删除，即「项目的所有更改」。 */
const GIT_ADD_ARGS = ['add', '-A']
/** 写死的提交参数：-m 让 git 不打开编辑器。 */
const GIT_COMMIT_ARGS = ['commit', '-m', COMMIT_MESSAGE]
/** 单流捕获上限（字节）；超出即截断并附提示，避免输出打爆上下文。 */
const MAX_OUTPUT_BYTES = 262144

/**
 * 执行一次 git 并把结果收成
 * { stdout, stderr, exitCode, timedOut, spawnError, truncated }。
 *
 * 不走 ctx.shell（原因见文件头注释）。
 *
 * git 在 Windows 上是可直接执行的 git.exe，无需像 npm 那样借 cmd.exe；
 * 参数以数组交给 spawn（shell: false），提交信息里的空格不会被任何解释器处理。
 * @param {string} root - 会话工作区根目录（作为 cwd，不取自模型输入）。
 * @param {string[]} args - 写死的 git 参数。
 * @param {AbortSignal} signal - 工具调用的取消信号。
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number | null, timedOut: boolean, spawnError: string | null, truncated: boolean}>}
 */
function runGit(root, args, signal) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('git', args, {
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
      resolve({ stdout, stderr, exitCode, timedOut, spawnError, truncated })
    }

    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code, null))
  })
}

/**
 * 先暂存全部改动，再提交，按顺序返回两次调用的结果。
 *
 * 暂存失败（不在 git 仓库、index.lock 被占、超时）时不再 commit：此时提交必然
 * 不完整，再跑一次只会把同一条错误重复一遍。
 * @param {string} root - 会话工作区根目录。
 * @param {AbortSignal} signal - 工具调用的取消信号。
 * @returns {Promise<object[]>} runGit 结果的数组，长度 1 或 2。
 */
async function runCommit(root, signal) {
  const staged = await runGit(root, GIT_ADD_ARGS, signal)
  if (staged.spawnError !== null || staged.exitCode !== 0) return [staged]
  return [staged, await runGit(root, GIT_COMMIT_ARGS, signal)]
}

/** 追加截断提示。 */
function streamText(text, truncated) {
  if (!truncated) return text
  return `${text}\n[输出被截断，仅保留前 ${MAX_OUTPUT_BYTES} 字节]`
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
 * git 的执行结果，原样返回：stdout、stderr、退出码标记。
 *
 * 与 pwsh 工具的呈现口径一致——非零退出才追加 `[exit code: N]`，
 * 干净的退出不加任何标记。不做归纳、不加结论。
 * @param {object[]} results - runCommit 的返回值。
 * @returns {string} 模型可见的文本。
 */
function renderResult(results) {
  const blocks = []
  const markers = []
  for (const result of results) {
    // 起不来子进程（git 缺失等）本身就是结果，原样报出，不当异常抛。
    if (result.spawnError !== null) {
      blocks.push(`无法执行 git：${result.spawnError}`)
      continue
    }
    const body = bodyOf(result)
    if (body.length > 0) blocks.push(body)
    if (result.timedOut) markers.push(`[timed out after ${TIMEOUT_MS}ms]`)
    else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
  }
  // 暂存成功时 git add 无输出，正常提交也只有 commit 的输出；全空说明确实没说话。
  if (blocks.length === 0) blocks.push('(no output)')

  let text = blocks.join('\n')
  if (markers.length === 0) return text
  if (!text.endsWith('\n')) text += '\n'
  return text + markers.join('\n')
}

module.exports = {
  name: 'tool-git-commit',
  // 只依赖 tools 注册表：本工具自己起子进程，不需要 shell 接缝（原因见文件头）。
  inject: ['tools'],

  apply(ctx) {
    const tools = ctx.get('tools')
    if (tools === undefined) {
      console.error('[tool-git-commit] 缺少 tools 服务，git_commit 工具未注册')
      return
    }

    tools.register({
      name: TOOL_NAME,
      description:
        'Commit every project change: run `git add -A`, then `git commit -m <fixed message>` at the project root,'
        + ' and return git output.',
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
        if (agent === undefined) throw new Error('git_commit 需要 agent 会话')
        const root = agent.session.header.cwd
        if (typeof root !== 'string' || root.length === 0) throw new Error('git_commit 需要会话工作区')

        const results = await runCommit(root, exec.signal)

        // 取消不是提交结果，按工具中断上报。
        if (exec.signal.aborted) {
          const error = new Error('tool call aborted')
          error.name = 'AbortError'
          error.code = 'ABORTED'
          throw error
        }

        return { output: renderResult(results) }
      },
      // UI 呈现：提交就是一条命令，按终端卡片呈现。
      presentCall: () => ({
        card: 'terminal',
        title: 'git commit',
        description: '提交项目的所有更改'
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
