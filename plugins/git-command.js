'use strict'

// git-command.js —— 用户手动触发的提交 / 推送命令 (/git)
//
// 为什么是斜杠命令而不是模型工具：提交与推送是对用户仓库的写操作，「什么时候提交、
// 什么时候推送」属于用户的判断。作为工具时，模型可以自行决定把当前工作区提交并推到
// 远端；作为命令后，只有用户在输入框里敲 /git 才会发生，模型既看不到也调不到它。
//
// 参数只有一个词，三选一：
//   c    提交   git add -A → git commit -m <常量>
//   p    推送   git push -u origin HEAD
//   c&p  提交后再推送
// 命令、参数与提交信息都是本文件的常量，用户输入只在这几条写死的序列里挑一条，
// 既改不了命令，也拼不进任何东西。
//
// 为什么提交是两步而不是一步 `git commit -a`：`-a` 只覆盖【已跟踪】文件的改动，新建
// 的文件不在其中，而「提交所有更改」必须包含它们。因此先 `add -A` 暂存全部改动
// （新文件、修改、删除），再 commit。
//
// 为什么推送写死成 `push -u origin HEAD` 而不是裸 `push`：裸 `push` 依赖当前分支已有
// upstream，新分支上会直接失败，而本命令没有命令行可补救。`origin HEAD` 表示「把当前
// 分支推到远端同名分支」，首次推送也能一次成功；`-u` 顺手设好 upstream，之后用户在
// 终端里裸 `git push` 也照样能用。远端名固定为 origin：仓库若用了别的远端名，git 自己
// 的报错会原样返回。
//
// 失败即止：序列里任何一步失败（起不来子进程、非零退出、超时）都不再执行后面的步骤
// ——没暂存完整的提交、没提交成功的推送，再跑一次只会把同一条错误重复一遍。由此带来
// 一个副作用：工作区干净时 c&p 会停在 commit 的「nothing to commit」，此时敲 /git p
// 就能直接推送（正文末尾也会给出这句提示）。
const { spawn } = require('node:child_process')

/** 单次执行的超时预算：提交可能触发 pre-commit 钩子（格式化、测试），推送可能很慢。 */
const TIMEOUT_MS = 300000
/** 单段输出的字符上限：git 正常输出远小于此，超限只可能是异常情形。 */
const MAX_OUTPUT_CHARS = 262144
/** 写死的提交信息：用户与模型都无法指定。 */
const COMMIT_MESSAGE = '更新'
/** 写死的暂存参数：-A 覆盖新文件、修改与删除，即「所有更改」。 */
const GIT_ADD_ARGS = ['add', '-A']
/** 写死的提交参数：-m 让 git 不打开编辑器。 */
const GIT_COMMIT_ARGS = ['commit', '-m', COMMIT_MESSAGE]
/** 写死的推送参数。 */
const GIT_PUSH_ARGS = ['push', '-u', 'origin', 'HEAD']

/** 三个动作各自的命令序列；键就是参数词。 */
const STEP_SEQUENCES = {
  c: [GIT_ADD_ARGS, GIT_COMMIT_ARGS],
  p: [GIT_PUSH_ARGS],
  'c&p': [GIT_ADD_ARGS, GIT_COMMIT_ARGS, GIT_PUSH_ARGS],
}

/** 输入词 → 动作。commit / push / cp 只是照顾手速的别名，语义与三个主参数一致。 */
const INPUT_ACTIONS = new Map([
  ['c', 'c'],
  ['commit', 'c'],
  ['p', 'p'],
  ['push', 'p'],
  ['c&p', 'c&p'],
  ['cp', 'c&p'],
])

const USAGE = '用法：/git c（提交）· /git p（推送）· /git c&p（提交并推送）'

/**
 * 起一个 git 子进程，把输出收成 { stdout, stderr, exitCode, timedOut, spawnError }。
 *
 * git 在 Windows 上是可直接执行的 git.exe，无需借 cmd.exe；参数以数组交给 spawn
 * （shell: false），提交信息里的空格不会被任何解释器处理。
 * @param {string} root - 会话工作区根目录，作为 cwd。
 * @param {string[]} args - 写死的 git 参数。
 * @returns {Promise<object>} 见上。
 */
function runGit(root, args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('git', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, spawnError: error.message })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const append = (current, chunk) => {
      if (current.length >= MAX_OUTPUT_CHARS) return current
      return (current + chunk).slice(0, MAX_OUTPUT_CHARS)
    }

    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      child.kill()
    }, TIMEOUT_MS)

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk.toString('utf8')) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk.toString('utf8')) })

    const finish = (exitCode, spawnError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode, timedOut, spawnError })
    }

    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code, null))
  })
}

/**
 * 按顺序执行一串命令，遇到第一个失败就停。
 * @param {string} root - 会话工作区根目录。
 * @param {string[][]} argsList - 本次动作的命令序列。
 * @returns {Promise<Array<{args: string[], result: object}>>} 已执行的命令及其结果。
 */
async function runSequence(root, argsList) {
  const runs = []
  for (const args of argsList) {
    const result = await runGit(root, args)
    runs.push({ args, result })
    if (result.spawnError !== null || result.exitCode !== 0) break
  }
  return runs
}

/** 单条命令的正文：stdout，非空 stderr 追加在其后。 */
function bodyOf(result) {
  if (result.stderr.length === 0) return result.stdout
  if (result.stdout.length > 0 && !result.stdout.endsWith('\n')) {
    return `${result.stdout}\n[stderr]\n${result.stderr}`
  }
  return `${result.stdout}[stderr]\n${result.stderr}`
}

/**
 * 每条命令一段：先回显 `$ git <参数>`，再是 stdout（非空 stderr 追加其后），最后是
 * 这一步自己的退出码 / 超时标记，原样返回、不做归纳。
 *
 * 逐条回显、逐条给标记：一次 c&p 最多三条命令，不带命令行就分不清哪段来自 add、哪段
 * 来自 commit、哪段来自 push；标记若统一追加在末尾，又会让人误以为整条序列都失败了。
 * @param {Array<{args: string[], result: object}>} runs - runSequence 的返回值。
 * @returns {string} 命令结果正文。
 */
function renderResults(runs) {
  const sections = []
  for (const { args, result } of runs) {
    const lines = [`$ git ${args.join(' ')}`]
    // 起不来子进程（git 缺失等）本身就是结果，原样报出，不当异常抛。
    if (result.spawnError !== null) {
      lines.push(`无法执行 git：${result.spawnError}`)
    } else {
      const body = bodyOf(result).replace(/\s+$/, '')
      // 暂存成功时 git add 无输出；「没说话」也是结果的一部分。
      lines.push(body.length > 0 ? body : '(no output)')
      if (result.timedOut) lines.push(`[timed out after ${TIMEOUT_MS}ms]`)
      else if (result.exitCode !== 0) lines.push(`[exit code: ${result.exitCode}]`)
    }
    sections.push(lines.join('\n'))
  }
  return sections.join('\n\n')
}

module.exports = {
  name: 'command-git',
  inject: ['commands'],

  apply(ctx) {
    const commands = ctx.get('commands')
    if (!commands) return

    commands.register({
      name: 'git',
      description: '提交 / 推送当前会话工作区的仓库（c 提交，p 推送，c&p 提交并推送）',
      input: { hint: 'c | p | c&p' },
      handler: async ({ agent, rawInput }) => {
        // 仓库位置取自会话头，不取自参数：用户输入只挑动作，改不了 cwd。
        const root = agent && agent.session ? agent.session.header.cwd : undefined
        if (typeof root !== 'string' || root.length === 0) {
          return { kind: 'error', text: '当前会话没有工作目录，无法定位要操作的仓库。' }
        }

        const word = typeof rawInput === 'string' ? rawInput.replace(/\s+/g, '').toLowerCase() : ''
        const action = INPUT_ACTIONS.get(word)
        if (action === undefined) {
          return {
            kind: 'error',
            text: word.length === 0 ? `缺少动作参数。${USAGE}` : `无法识别的动作「${word}」。${USAGE}`,
          }
        }

        const runs = await runSequence(root, STEP_SEQUENCES[action])
        const failed = runs.some(({ result }) => result.spawnError !== null || result.exitCode !== 0 || result.timedOut)
        const parts = [renderResults(runs)]

        const commitRun = runs.find(({ args }) => args[0] === 'commit')
        const nothingToCommit = commitRun !== undefined
          && commitRun.result.exitCode !== 0
          && /nothing to commit|无文件要提交|工作区干净/.test(`${commitRun.result.stdout}${commitRun.result.stderr}`)
        if (nothingToCommit) parts.push('工作区没有可提交的改动。若只想推送已有的提交，用 /git p。')

        return { kind: failed ? 'error' : 'success', text: parts.join('\n\n') }
      },
    })
  },
}
