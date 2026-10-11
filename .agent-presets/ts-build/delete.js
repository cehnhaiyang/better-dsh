'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// delete.js —— test / ts-build 预设的 delete 工具（零依赖本地插件）
//
// 设计原则（唯一职责）：
//   在【不向模型暴露任何命令行工具】的前提下，给模型一个「删文件」的按钮。
//   模型调用 delete，本工具以项目根目录为基准解析参数里的路径并删除它们，
//   把删掉了哪些路径原样报回。
//
// 参数：
//   paths —— 以项目根目录为基准的相对路径，多个用英文逗号分隔；
//   路径可以是文件（删该文件），也可以是目录（删整棵目录树）。
//
// 两道边界，都立在模型输入这一侧：
//   - 路径必须落在会话工作区之内（绝对路径与 `..` 穿越一律拒绝），
//     让「以项目根目录为基准」成为硬约束而不是口头约定；
//   - 不能是项目根目录本身：那等于把整个项目删掉，几乎不会是本意。
//   除此之外不设路径黑名单（例如不特判 .git）：模型点名要删什么就删什么，
//   额外的「贴心」拦截只会让工具的行为变得不可预测。
//
// 为什么用 fs.rmSync 而不是自己写递归删除：
//   目录树删除由 Node 内置实现负责，符号链接、只读位、Windows 上的重解析点
//   都已处理；自己写只会引入半删状态。
//
// 为什么裸注册、不 import defineTool：
//   本文件被 ~/.dsh/.js 复制到 profile 的 preset-assets/<id>/ 下（编辑源在
//   用户预设目录），两处都不在任何 node_modules 链上，Node 的 require 向上查找
//   永远到不了 harness 的 node_modules，`import '@deepseek-ai/dsh-tools'` 必然失败。而
//   ctx.tools.register() 直接接受原始 JSON Schema 定义（dsh-mcp-client 就是
//   这样注册的），因此本文件只用 node 内置模块。
//
// 为什么【不】经由 ctx.shell（与 typecheck.js / test.js 同因，别改回去）：
//   ctx.shell 是宿主平面的沙箱执行接缝，而本工具要用的是 fs 服务，不是命令。
//   走子进程删文件既绕远路又不可控：删除结果无法作为结构化数据返回，
//   失败时也分不清是命令没跑起来还是文件没删掉。
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs')
const path = require('node:path')

/** 模型侧可见的工具名。 */
const TOOL_NAME = 'delete'

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
 * 删除一个路径：文件删文件，目录删整棵树。
 *
 * 不存在按失败返回而不是当作「已经删掉了」：路径写错和确实删过，对模型是
 * 两件不同的事，静默算成功会让它以为清理完成了。
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
 * 继续删只会把不该删的东西删掉（与 node.js / git-commit.js 同因）。
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

/** presentCall 在会话回放时会收到未经校验的参数，取值一律防御性处理。 */
function titleOf(args) {
  const paths = args !== null && typeof args === 'object' ? args.paths : undefined
  return typeof paths === 'string' && paths.length > 0 ? paths : '…'
}

module.exports = {
  name: 'tool-delete',
  // 只依赖 tools 注册表：本工具直接用 fs，不需要 shell 接缝（原因见文件头）。
  inject: ['tools'],

  apply(ctx) {
    const tools = ctx.get('tools')
    if (tools === undefined) {
      console.error('[tool-delete] 缺少 tools 服务，delete 工具未注册')
      return
    }

    tools.register({
      name: TOOL_NAME,
      description:
        '删除当前项目里的文件或目录。参数是以项目根目录为基准的相对路径，多个用英文逗号分隔；'
        + '路径是文件就删该文件，是目录就删整棵目录树。按顺序逐个删除，遇到第一个失败即停止。'
        + '删除不可撤销，直接调用即可看到实际删掉了哪些路径。',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'string',
            description: '以项目根目录为基准的相对路径，多个用英文逗号分隔，例如 tmp/a.js,dist'
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
        if (agent === undefined) throw new Error('delete 需要 agent 会话')
        const root = agent.session.header.cwd
        if (typeof root !== 'string' || root.length === 0) throw new Error('delete 需要会话工作区')

        const items = splitPaths(args.paths)
        if (items.length === 0) {
          throw new Error('delete 需要 paths 参数：以项目根目录为基准的相对路径，多个用英文逗号分隔')
        }

        const { removed, failure } = removeAll(root, items)
        return { output: renderResult(removed, failure) }
      },
      // UI 呈现：删除是一次文件操作，按终端卡片呈现（本预设没有 diff 卡片可承载删除）。
      presentCall: (args) => ({
        card: 'terminal',
        title: `delete ${titleOf(args)}`,
        description: '删除项目内的文件或目录'
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
