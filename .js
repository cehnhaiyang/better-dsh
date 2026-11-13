// ─────────────────────────────────────────────────────────────────────────────
// DSH 全量独立部署与维护脚本
//
// 用法：
//   node .js            进入维护台菜单：1 管理会话 / 2 应用补丁 / q 退出
//   node .js --apply    直接执行全部补丁（便于脚本化，不进入菜单）
//   node .js --list     非交互列出工作区目录（目录名反解为可读路径）
//   node .js --list <目录名|路径片段|序号>   列出该目录下的会话（含标题）
//
// 核心功能：
//   本脚本是 DSH 功能增强与自定义插件生态的「一键挂载与维护总入口」。
//   在任何时候运行（`node .js`），会自动全量构建并注入全部改进：
//
//   0. 基线版本：本脚本按 dsh 0.2.2-rc.1 的结构维护。
//
//   1. 插件资源挂载与校验（文件已作为仓库内容持久化，脚本不生成也不覆写）：
//      全部位于 `~/.dsh/plugins/`，由人手写维护；脚本把它们的绝对路径挂进 profile
//      补丁（见第 4 节），并在挂载前校验契约，任一不满足即以非零码退出：
//      - `reflect-command.js`（/reflect：自省会话复盘工程经验与偏好，沉淀为 Skill，
//        并自动联动执行会话压缩）
//      - `creative-workflow.js`（创作工作流模式插件：动态从工作区装配准则与模式提示词）
//      - `preset-hotreload-and-meter.js`（预设声明更新后把已运行会话重绑到新修订）
//      - `explore-command.js`（/explore：全面探索工作区项目的架构与实现，产出一份完善的
//        PROJECT.md）
//      - `git-command.js`（/git：用户手动触发的提交 / 推送，参数 c / p / c&p）。提交与
//        推送是对用户仓库的写操作，时机由用户判断，因此它是斜杠命令而不是给模型的工具。
//      - `inject-command.js`（/inject：把项目内文件的内容注入系统提示词，参数为相对项目
//        根目录的路径，off 关闭。注入内容随每次模型调用装配，不进对话历史，因此不会被
//        压缩折叠）
//      - `idle-guard.js` 与 `idle-arm/`（闲置落盘警告）。idle-arm 是「宿主半边 + 客户端
//        半边」双面插件，其客户端半边需要一个 package.json 才能被 dsh-client-modules
//        定位（clientExportOf 读 exports["./client"]），因此必须是独立包目录：放在
//        plugins/ 根的那一份 package.json 会让同级所有插件都被误认为声明了同一个 bundle。
//      - `prompt-forge/`：提示词锻造双面插件。宿主半边注册 /forge 命令、forge_prompt
//        工具与 /api/forge/* 路由；客户端半边在输入框右侧挂一个「改写」按钮与面板。
//        三种强度共用一份内核：rewrite（只重述）/ augment（保守增量）/
//        structure（七段结构化）。模型调用走 ctx.llm，不引入第二套凭据。
//      - `msg-edit/`：会话内模型输出的原地编辑双面插件。宿主半边注册消息投影与
//        /api/session.message 路由，客户端半边把回复行换成可编辑区域。它是唯一
//        需要 link: 依赖的手写插件（宿主半边 import 了 @deepseek-ai/dsh-session，
//        裸说明符只有落在 linked root 里才会被解析器接管），理由见第 4.9 节。
//      - `md-session-import/`：md 转录稿 → 新会话的双面插件。宿主半边只用 node: 内建，
//        因此挂载方式与其它单行插件一致，不需要 link:，理由见第 4.10 节。
//      - `rewind/`：会话回退双面插件（把会话退到更早的消息，可选一并还原工作区文件）。
//        原先是 npm 包 dsh-rewind-plugin（靠 dsh.bundle.patch 插进 bundle 层），现改为
//        本地手写资源：宿主半边按上游模块边界拆成 lib/ 下六个 ESM 文件，客户端半边是
//        单文件加载器交接格式。宿主半边 import 了 @deepseek-ai 裸说明符，因此与
//        msg-edit 一样是 link: 依赖，理由见第 4.11 节。
//      - `~/.dsh/tools.js`：自定义工具集的唯一实现（js / delete / browser）。工具
//        **不是**全局挂载的：预设用占位名 `better-dsh:tools` + `config: { tools: [...] }`
//        声明自己要用哪几个，脚本在生成预设声明时把占位名改写成本机的 file:// 绝对
//        路径。预设因此各自掌握自己的工具集，实现只有一份。契约（能否加载、每个工具
//        是否真的注册）在改写前核对。
//
//   2. 自建预设迁移与落地：
//      扫描 `~/.dsh/.agent-presets/<id>/`，把每个目录转成一条
//      `@deepseek-ai/dsh-agent-preset` 声明行（id 取目录名，name/description/order 取
//      preset.yml，plugins 为 agent.cordis.yml 的原样内联）；预设自己的相对资源
//      （目前只有文件区注入插件）复制到 `profiles/web/preset-assets/<id>/` 并改写
//      引用，该目录每次整棵重建，来源里删掉的资源不会在 profile 里留下过期拷贝。
//      声明里的占位名 `better-dsh:tools` 改写成 `~/.dsh/tools.js` 的绝对 URL
//      （预设因此不必写死机器相关路径，见第 1 节的说明）。声明段整段重建，幂等。
//
//   3. settings.yaml 迁移：
//      dsh 只在启动时一次性导入 `~/.dsh/settings.yaml`，且只接受 volatile 字段，
//      因此它不作为生效源；本脚本用 LEGACY_SECTION_ENTRIES 的映射把「有同名条目」的 section 直接写进
//      profile patch（静态 config 不受 volatile 限制，覆盖面更全）。补丁里已有同名
//      条目的 section 一律跳过，不覆盖网页端的修改。只解析 settings.yaml 本身，
//      不读 settings.yaml.imported；该文件不存在时整段跳过并保留既有区块。
//
//   4. 配置自动注入与挂载：
//      - 自动检查并更新 `~/.dsh/profiles/web/cordis.patch.yml`，
//        确保上述插件与迁移内容被持久化包含与挂载（缺失时按需创建）。
//        注意该 profile 层之上还有家目录层 `~/.dsh/cordis.patch.yml`：
//        同 id 条目以家目录层为准，本脚本不创建、不改写它。
//
//   5. 底层增强补丁全量内嵌应用（幂等执行，一体化集成，无需外置脚本）：
//      - preset-switch：解除非空白会话锁定（保留「有未闭合回合」这一硬锁），
//        并把会话头部标签升级为可交互下拉（闸门未开时回退为原只读标签）；
//      - compaction：压缩阈值按 surface 计价，并让压缩指令忽略规则库与工作流。
//        compact 后端由 agent preset 提供，因此脚本不在 host 层启用
//        compaction-basic，并清除 host 层残留的该条目。
//      各补丁的锚点与闸门条件见 applyCorePatches() 内的逐条注释。
//
//   6. 工作区与会话完整性内嵌自愈（仅在 --apply 流程内执行）：
//      自动扫描归纳游离会话、恢复归属工作区；已入册会话沿用原归属路径，绝不因
//      cwd 暂时不可解析（离线盘/目录已删）而丢组；扫描覆盖日志的全部代，只重建不丢账。
//   7. 会话管理台（交互菜单第 1 项，无需 dsh 运行）：
//      把 ~/.dsh/sessions/<编码目录名> 反解为可读路径（优先取会话头 cwd，取不到才按
//      官方 projectKey() 反向解码——该编码对含 - 的段名有损）；逐层列出目录与会话，
//      支持删除目录或单个会话，并同步摘除 workspace.json 的归属账目与
//      session_projcache 投影缓存（缓存按会话身份绑定，日志删除后不清就是死记录）。
//   8. 会话移动（命令行 m <序号>）：
//      官方把「会话属于哪个目录」编码在 header.cwd，并校验「文件实际路径 ==
//      logPath(cwd)」，故移动必须同时改写每一代日志 header 的 cwd、搬迁会话目录、
//      同步 workspace.json 归属。执行顺序为「先写目标 → 校验 → 再删源」，失败只回滚
//      目标副本；DSH 运行中（Web 端口在监听或写锁被占用）一律拒绝移动。
//      机制细节见下文「会话移动引擎」一节。
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const nodeZlib = require('node:zlib')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { createInterface } = require('node:readline/promises')

const HOME = os.homedir()
const DSH_ROOT = process.env.DSH_HOME || path.join(HOME, '.dsh')
// 本脚本面向 Web profile（WEB_PROFILE_DIR 与它必须一致，故集中成一个常量）。
const PROFILE_NAME = 'web'
const PLUGINS_DIR = path.join(DSH_ROOT, 'plugins')
// 自定义工具集：js / delete / browser 三个工具的
// 唯一实现，放在仓库根、由人手写维护（脚本只挂载与校验，不生成也不覆盖）。
const TOOLS_FILE = path.join(DSH_ROOT, 'tools.js')
const WEB_PROFILE_DIR = path.join(DSH_ROOT, 'profiles', PROFILE_NAME)
const CORDIS_PATCH_FILE = path.join(WEB_PROFILE_DIR, 'cordis.patch.yml')

// ─────────────────────────────────────────────────────────────────────────────
// 交互入口：会话管理 / 补丁
//
// 默认（不带参数）进入命令行菜单，不立刻改环境；补丁流程用 --apply 触发。
// 各入口的完整用法见文件头部。
// ─────────────────────────────────────────────────────────────────────────────

const SESSIONS_DIR = path.join(DSH_ROOT, 'sessions')
const WORKSPACE_STATE_FILE = path.join(DSH_ROOT, 'storages', 'workspace.json')
// 会话日志的规范文件名（对应 dsh-session-format 的 CANONICAL_LOG_FILENAME，外加压缩后缀）：
// 第 0 代是 session.jsonl，其后每代在 .jsonl 前带 .vN（N ≥ 1 且无前导零，与官方正则一致）。
// 同目录多代并存时取版本最高的一代。
const SESSION_LOG_PATTERN = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/
// zstd 帧魔数按小端读出：28 B5 2F FD。
const ZSTD_FRAME_MAGIC = 0xfd2fb528

/**
 * 把 ~/.dsh/sessions 下的项目目录名反向解码成可读路径。
 *
 * 官方编码规则在 dsh-session-persistence-jsonl 的 projectKey()：整体用 `--` 包裹，
 * 路径分隔符（/ \ :）折叠为一个 `-`，其余不安全码元写成 `~XXXX`（大写十六进制、补 4 位）。
 * 官方注释明确该编码是**有损**的：段名自带的 `-` 与超过 251 字符的尾巴都无法还原。
 * 因此本函数只作展示；真实路径优先取该目录内任一会话头里的 cwd（那才是无损的）。
 * @param name - 项目目录名。
 * @returns 尽力还原的路径，或 `_no-cwd` 的说明文字。
 */
function decodeProjectKey(name) {
  if (name === '_no-cwd') return '(会话头无 cwd)'
  let body = name
  if (body.startsWith('--')) body = body.slice(2)
  if (body.endsWith('--')) body = body.slice(0, -2)
  let decoded = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === '~') {
      const hex = body.slice(i + 1, i + 5)
      if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
        decoded += String.fromCharCode(parseInt(hex, 16))
        i += 4
        continue
      }
    }
    decoded += ch === '-' ? '\\' : ch
  }
  // 盘符分隔符与路径分隔符被编码成同一个 `-`，这里按 Windows 习惯补回冒号。
  return /^[A-Za-z]\\/.test(decoded) ? `${decoded[0]}:${decoded.slice(1)}` : decoded
}

/**
 * 定位 zstd 串联帧边界（dsh-session-persistence-jsonl 的 scanZstdFrames() 等价实现）。
 *
 * 只解析帧头与块头，不解压：读到完整帧就推进一步，遇到不完整尾巴则回报 tornStart。
 * @param buffer - 会话日志的全部字节。
 * @param maxFrames - 最多扫描的完整帧数（头部读取只需 1）。
 * @returns 完整帧区间与可选的不完整尾帧起点。
 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_FRAME_MAGIC) throw new Error(`zstd 帧魔数非法 @${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    // 保留位必须为 0（官方同样在此抛错）：留着不查会把损坏的帧头当成合法帧继续推进，
    // 于是后续所有「帧边界」都建立在错误偏移上，读出来的明文是垃圾而非报错。
    if ((descriptor & 24) !== 0) throw new Error(`zstd 帧头保留位非零 @${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < headerBytes) return { frames, tornStart: start }
    offset += headerBytes
    for (; ;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      // 块类型 3 是保留值，官方同样抛错；不查会让 payloadBytes 取到一个
      // 毫无意义的长度，把扫描器带偏。
      if (blockType === 3) throw new Error(`zstd 块类型为保留值 @${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockHeader >>> 3
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length >= maxFrames) return { frames }
  }
  return { frames }
}

/** 解析一行 JSON，非对象或损坏时返回 undefined（日志尾部可能被截断）。 */
function safeJson(text) {
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 读取会话日志的全部明文。
 *
 * 日志是串联 zstd 帧容器（每次追加一个独立帧），而 node 的 zstdDecompressSync 只解第一帧，
 * 所以整篇读取必须逐帧解压再拼接。单帧损坏不致命：返回已读到的部分并标记截断。
 * @param filePath - 日志文件路径。
 * @returns 明文与截断标记。
 */
function readSessionLogText(filePath) {
  const buffer = fs.readFileSync(filePath)
  if (!filePath.endsWith('.zstd')) return { text: buffer.toString('utf8'), truncated: false }
  const { frames, tornStart } = scanZstdFrames(buffer)
  const parts = []
  for (const frame of frames) {
    try {
      parts.push(nodeZlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
    } catch {
      return { text: parts.join(''), truncated: true }
    }
  }
  return { text: parts.join(''), truncated: tornStart !== undefined }
}

/**
 * 只读会话头（第一帧），用于廉价的批量枚举。
 * @param filePath - 日志文件路径。
 * @returns 会话头对象，或 undefined。
 */
function readSessionHeader(filePath) {
  const buffer = fs.readFileSync(filePath)
  if (!filePath.endsWith('.zstd')) {
    const line = buffer.toString('utf8').split('\n').find((it) => it.length > 0)
    return line === undefined ? undefined : safeJson(line)
  }
  const { frames } = scanZstdFrames(buffer, 1)
  if (frames.length === 0) return undefined
  const text = nodeZlib.zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end)).toString('utf8')
  const line = text.split('\n').find((it) => it.length > 0)
  return line === undefined ? undefined : safeJson(line)
}

/**
 * 在会话目录中选出当前代日志（版本最高者）。
 * @param sessionPath - 会话目录。
 * @returns 日志文件路径，或 undefined（目录内没有规范日志）。
 */
function pickSessionLog(sessionPath) {
  const candidates = []
  for (const item of fs.readdirSync(sessionPath, { withFileTypes: true })) {
    if (!item.isFile()) continue
    const match = SESSION_LOG_PATTERN.exec(item.name)
    if (match === null) continue
    candidates.push({ name: item.name, version: match[1] === undefined ? 0 : Number(match[1]) })
  }
  candidates.sort((left, right) => right.version - left.version)
  return candidates.length === 0 ? undefined : path.join(sessionPath, candidates[0].name)
}

/**
 * 汇总一个会话：头信息（id/创建时间/cwd/预设）+ 标题 + 首条用户消息。
 * 标题取日志中最后一次 `session/title`，首条用户消息取第一条 source.kind === 'user' 的 user/message。
 * @param sessionPath - 会话目录。
 * @returns 汇总对象。
 */
function readSessionSummary(sessionPath) {
  const logPath = pickSessionLog(sessionPath)
  if (logPath === undefined) {
    return { id: path.basename(sessionPath), sessionPath, logPath: undefined, size: 0 }
  }
  const size = fs.statSync(logPath).size
  const header = readSessionHeader(logPath)
  const { text, truncated } = readSessionLogText(logPath)
  let title
  let firstUserText
  let lastTime = typeof header?.createdAt === 'number' ? header.createdAt : undefined
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const event = safeJson(line)
    if (event === undefined) continue
    if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
    if (firstUserText === undefined && event.type === 'user/message' && event.data?.source?.kind === 'user') {
      const blocks = Array.isArray(event.data.content) ? event.data.content : []
      const block = blocks.find((it) => it.type === 'text' && typeof it.text === 'string')
      if (block !== undefined) firstUserText = block.text
    }
    if (typeof event.time === 'number') lastTime = event.time
  }
  return {
    id: header?.id ?? path.basename(sessionPath),
    sessionPath,
    logPath,
    size,
    header,
    title,
    firstUserText,
    lastTime,
    truncated,
    exactCwd: header?.cwd,
  }
}

/**
 * 枚举工作区目录（~/.dsh/sessions 下的一级目录）。
 * 展示路径优先取目录内任一会话头里的 cwd（无损），取不到才回退到目录名解码（有损）。
 * @returns 按最近活动倒序的项目条目。
 */
function loadProjectEntries() {
  if (!fs.existsSync(SESSIONS_DIR)) return []
  const entries = []
  for (const dir of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const dirPath = path.join(SESSIONS_DIR, dir.name)
    const sessionDirs = []
    let newest = 0
    let totalBytes = 0
    let exactCwd
    for (const item of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!item.isDirectory()) continue
      const sessionPath = path.join(dirPath, item.name)
      const logPath = pickSessionLog(sessionPath)
      let stat
      try {
        stat = fs.statSync(logPath ?? sessionPath)
      } catch {
        continue
      }
      sessionDirs.push({ name: item.name, path: sessionPath, logPath, mtime: stat.mtimeMs, size: logPath === undefined ? 0 : stat.size })
      if (stat.mtimeMs > newest) newest = stat.mtimeMs
      if (logPath !== undefined) totalBytes += stat.size
      if (exactCwd === undefined && logPath !== undefined) {
        try {
          exactCwd = readSessionHeader(logPath)?.cwd
        } catch {
          exactCwd = undefined
        }
      }
    }
    entries.push({
      dirName: dir.name,
      path: dirPath,
      sessionDirs: sessionDirs.sort((left, right) => right.mtime - left.mtime),
      newest,
      totalBytes,
      exactCwd,
      displayPath: exactCwd ?? decodeProjectKey(dir.name),
      exact: typeof exactCwd === 'string' && exactCwd.length > 0,
    })
  }
  return entries.sort((left, right) => right.newest - left.newest || left.displayPath.localeCompare(right.displayPath))
}

/**
 * 从工作区注册表里摘掉已删除的会话与工作区，并保证顺序表与表项严格一一对应
 * （dsh-workspace 的 validateStoredState() 会校验这一点）。
 * @param deletedSessionIds - 已删除的会话 id 列表。
 * @returns 摘除计数。
 */
function pruneWorkspaceState(deletedSessionIds) {
  if (!fs.existsSync(WORKSPACE_STATE_FILE)) return { sessions: 0, workspaces: 0 }
  let state
  try {
    state = JSON.parse(fs.readFileSync(WORKSPACE_STATE_FILE, 'utf8'))
  } catch {
    console.warn('[workspace] 注册表无法解析，跳过账目摘除（下次 --apply 会按磁盘重建）')
    return { sessions: 0, workspaces: 0 }
  }
  const tables = state.tables?.workspaces
  if (tables === undefined) return { sessions: 0, workspaces: 0 }

  const deleted = new Set(deletedSessionIds)
  let sessions = 0
  let workspaces = 0
  for (const [id, record] of Object.entries(tables)) {
    const before = record.sessionIds.length
    record.sessionIds = record.sessionIds.filter((sid) => !deleted.has(sid))
    sessions += before - record.sessionIds.length
    // 本次操作把它清空的记录一并删除；本就为空的记录（历史残留）保留不动。
    if (record.sessionIds.length === 0 && before > 0) {
      delete tables[id]
      workspaces += 1
    }
  }
  state.global.workspaceIds = (state.global.workspaceIds ?? []).filter((id) => tables[id] !== undefined)
  state.global.archivedSessionIds = (state.global.archivedSessionIds ?? []).filter((sid) => !deleted.has(sid))
  // 钉选集合与会话身份绑定：官方在会话删除时同步摘除钉子，这里必须跟着做，
  // 否则 workspace.json 会留下永远等不到会话的钉选记录（0.2.2 的 pinnedSessionIds）。
  state.global.pinnedSessionIds = (state.global.pinnedSessionIds ?? []).filter((sid) => !deleted.has(sid))

  const tmpFile = path.join(path.dirname(WORKSPACE_STATE_FILE), `.${Date.now()}.workspace.tmp`)
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2) + '\n', 'utf8')
  fs.renameSync(tmpFile, WORKSPACE_STATE_FILE)
  return { sessions, workspaces }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '(未知)'
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function oneLine(text, limit) {
  if (typeof text !== 'string') return ''
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`
}

function printProjectTable(projects) {
  console.log('')
  console.log(`工作区目录（共 ${projects.length} 个，位于 ${SESSIONS_DIR}）`)
  console.log('  序号  会话   最近活动           路径')
  projects.forEach((project, index) => {
    const guess = project.exact ? '' : '  *'
    console.log(`  ${String(index + 1).padStart(3)}  ${String(project.sessionDirs.length).padStart(4)}   ${formatTime(project.newest)}   ${project.displayPath}${guess}`)
  })
  if (projects.some((project) => !project.exact)) {
    console.log('  * 号目录未能从会话头取到 cwd，路径由目录名反向解码（含 - 或超长时可能有偏差）')
  }
}

function printSessionTable(project, sessions) {
  console.log('')
  console.log(`会话列表：${project.displayPath}`)
  console.log(`  目录名 ${project.dirName}${project.exact ? '' : '（路径为解码推测）'}`)
  console.log('  序号  最近写入          大小      预设        标题 / 首条消息')
  sessions.forEach((session, index) => {
    const preset = session.header?.agentPreset ?? '-'
    const label = session.title ?? (oneLine(session.firstUserText, 30) || (session.logPath === undefined ? '(无规范日志)' : '(空会话，无标题)'))
    console.log(`  ${String(index + 1).padStart(3)}  ${formatTime(session.lastTime)}  ${formatBytes(session.size).padStart(8)}  ${String(preset).padEnd(10)}  ${label}`)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 会话移动引擎
//
// 官方把「会话属于哪个目录」编码在 header.cwd 里，并由它推导磁盘位置：
//   projectDir = sessions/<projectKey(cwd)>/
//   sessionDir = projectDir/<encodeSegment(id)>/
// 且 dsh-session-persistence-jsonl 的 assertStoredIdentity() 会校验「文件实际路径必须
// 等于 logPath(root, header.cwd, id)」。所以移动一个会话必须同时做三件事，缺一不可：
//   1. 改写每一代日志第 0 帧（header）里的 cwd；
//   2. 把会话目录搬到新 projectKey 下；
//   3. 同步 storages/workspace.json 的归属（归属同样以 cwd 的 realpath 为键）。
// header 是「恰好一行」的独立 zstd 帧，因此只需重压第 0 帧，其余帧逐字节保留，
// 历史事件完全不受影响。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 官方 dsh-session-persistence-jsonl 的 projectKey() 复刻：cwd → 项目目录名。
 * 分隔符（/ \ :）折叠成一个 `-`，其余不安全码元写成 `~XXXX`，整体用 `--` 包裹。
 * @param cwd - 会话工作目录的 realpath 规范形式。
 * @returns 单层安全的项目目录名。
 */
function encodeProjectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('无法编码空的工程路径')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * 官方 encodeSegment() 复刻：会话 id → 单层安全目录名。
 * @param raw - 会话 id。
 * @returns 编码后的目录名。
 */
function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('无法编码空的路径段')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * 官方 encodeSegment() 的严格逆运算：会话目录名 → 会话 id。
 *
 * 该编码是无损可逆的（安全码元原样保留，其余写成 `~XXXX`），所以拿不到会话头时
 * 仍能从目录名还原出真实 id —— 这比直接用目录名当 id 可靠：后者在 id 含非安全码元
 * 时（编码成 `~XXXX`）会写出一个永远不匹配的键。
 * @param name - 会话目录名。
 * @returns 还原后的会话 id。
 */
function decodeSegment(name) {
  let out = ''
  for (let i = 0; i < name.length; i += 1) {
    if (name[i] === '~' && /^[0-9A-Fa-f]{4}$/.test(name.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(name.slice(i + 1, i + 5), 16))
      i += 4
      continue
    }
    out += name[i]
  }
  return out
}

/** 原子写 JSON：先写同目录临时文件再 rename，避免中断留下半个文件。 */
function writeJsonAtomic(file, value) {
  const tmp = path.join(path.dirname(file), `.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 改写 header 行里的 cwd，其余字段保持原序原值。
 *
 * 先做一次「解析后重新序列化」的往返比对：只有能无损往返才允许改写。
 * 这样任何本脚本不认识的 header 字段都会被原样保留；一旦往返有差异就中止，
 * 而不是冒险写出一份语义被悄悄改动的 header。
 * @param headerLine - header 行原文（不含换行）。
 * @param newCwd - 新的工作目录。
 * @returns 改写后的 header 行。
 */
function rewriteHeaderLine(headerLine, newCwd) {
  const parsed = safeJson(headerLine)
  if (parsed === undefined) throw new Error('header 行不是合法 JSON 对象')
  if (!Object.hasOwn(parsed, 'cwd')) throw new Error('header 没有 cwd 字段，无法移动')
  if (JSON.stringify(parsed) !== headerLine) {
    throw new Error('header 无法无损往返序列化，已中止以免破坏未知字段')
  }
  return JSON.stringify({ ...parsed, cwd: newCwd })
}

/**
 * 只替换日志第 0 帧（header）中的 cwd，其余帧逐字节原样保留。
 *
 * 每一代日志都要调用：官方按「版本最高的一代」取用，而校验路径时会比对
 * header.cwd，所以哪一代留了旧 cwd，哪一代就会成为隐患。
 * @param filePath - 某一代日志文件。
 * @param newCwd - 新的工作目录。
 * @returns 改写后的完整文件字节。
 */
function rewriteLogHeaderCwd(filePath, newCwd) {
  const buffer = fs.readFileSync(filePath)
  if (!filePath.endsWith('.zstd')) {
    const text = buffer.toString('utf8')
    const breakAt = text.indexOf('\n')
    if (breakAt < 0) throw new Error('日志缺少 header 行')
    return Buffer.from(`${rewriteHeaderLine(text.slice(0, breakAt), newCwd)}\n${text.slice(breakAt + 1)}`, 'utf8')
  }
  if (typeof nodeZlib.zstdCompressSync !== 'function') {
    throw new Error('当前 Node 不支持 zstd 压缩（需 Node 22.15+），无法改写压缩日志')
  }
  const { frames, tornStart } = scanZstdFrames(buffer)
  if (frames.length === 0) throw new Error('日志没有完整帧')
  // 尾部有未写完的帧时拒绝改写：那说明文件正被写入或上次写入中断，此时重写会掩盖故障。
  if (tornStart !== undefined) throw new Error('日志尾部存在未完成的帧，已中止以免破坏')
  const plaintext = nodeZlib.zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end)).toString('utf8')
  if (plaintext.indexOf('\n') !== plaintext.length - 1) throw new Error('第 0 帧不是「恰好一行 header」')
  const frame = nodeZlib.zstdCompressSync(Buffer.from(`${rewriteHeaderLine(plaintext.slice(0, -1), newCwd)}\n`, 'utf8'))
  return Buffer.concat([frame, buffer.subarray(frames[0].end)])
}

// ── 运行中检测 ──────────────────────────────────────────────────────────────

let lockProbeApi
/**
 * 加载探测会话写锁所需的 Win32 API（惰性，仅 Windows）。
 *
 * 官方在 Windows 上用「以会话锁文件路径派生的具名内核信号量」做跨进程写锁，
 * 并不落任何锁文件。这里复刻同一套命名规则去探测它。
 * @returns 绑定集合，或 null（不可用）。
 */
function lockProbeBindings() {
  if (lockProbeApi !== undefined) return lockProbeApi
  lockProbeApi = null
  if (process.platform !== 'win32') return lockProbeApi
  try {
    const installRoot = path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh')
    const koffi = require(path.join(installRoot, 'node_modules', 'koffi'))
    const kernel32 = koffi.load('kernel32.dll')
    lockProbeApi = {
      create: kernel32.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']),
      wait: kernel32.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']),
      release: kernel32.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']),
      close: kernel32.func('__stdcall', 'CloseHandle', 'int', ['intptr']),
      // 用于区分「对象已存在但被拒（= 有人持有）」与「其它创建失败（= 未知）」。
      lastError: kernel32.func('__stdcall', 'GetLastError', 'uint', []),
    }
  } catch {
    lockProbeApi = null
  }
  return lockProbeApi
}

/**
 * 探测某个会话的写锁是否被占用。
 *
 * 判据（已对 111 个真实会话实测：109 个 free、2 个 held、0 个 unknown）：
 *   - 信号量创建成功且立即取到 → 'free'（无人持有，探测后立刻归还并关闭句柄，不留痕迹）；
 *   - 创建成功但等待超时     → 'held'（DSH 正持有写锁）；
 *   - 创建即失败（ACCESS_DENIED）→ 'held'：该具名对象已存在但访问被拒，
 *     实测恰好只出现在 DSH 正在写入的那几个会话上，故按「被占用」保守处理；
 *   - 其它情况               → 'unknown'（不阻断，交由调用方决定）。
 * @param sessionDir - 会话目录。
 * @returns 'free' | 'held' | 'unknown'。
 */
function probeSessionLock(sessionDir) {
  const api = lockProbeBindings()
  if (api === null) return 'unknown'
  try {
    const lockPath = path.join(sessionDir, 'session.lock')
    const name = `Local\\dsh-session-lock-${require('node:crypto').createHash('sha256').update(path.resolve(lockPath).toLowerCase()).digest('hex')}`
    const handle = api.create(null, 1, 1, name)
    if (handle === 0) {
      // 只有 ERROR_ACCESS_DENIED(5) 才等价于「对象已存在但拿不到」——即有人持有。
      // 其余失败（权限、句柄耗尽等）不是持有的证据，归入 unknown 交给调用方判断；
      // 一律按 held 会让移动/删除在无关故障下被永久拒绝。
      return api.lastError() === 5 ? 'held' : 'unknown'
    }
    const wait = api.wait(handle, 0)
    if (wait === 0) {
      api.release(handle, 1, null)
      api.close(handle)
      return 'free'
    }
    api.close(handle)
    return wait === 258 ? 'held' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 探测本机端口是否有进程在监听（用于判断 DSH Web 是否在运行）。 */
function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = require('node:net').connect({ host: '127.0.0.1', port, timeout: 400 })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => resolve(false))
  })
}

/**
 * 判断 DSH 是否正在运行。
 *
 * 两条独立信号，任一命中即认为在运行：
 *   1. Web 端口（默认 3080）正在监听；
 *   2. 存在任何一个被持有的会话写锁（说明有活跃 agent 正在写日志）。
 * 只用于「拒绝移动」这种保守动作，因此宁可误报也不漏报。
 * @returns 运行状态与原因列表。
 */
async function detectRunningDsh() {
  const reasons = []
  for (const port of DSH_WEB_PORTS) {
    if (await isPortListening(port)) reasons.push(`127.0.0.1:${port} 正在监听（DSH Web 界面运行中）`)
  }
  if (fs.existsSync(SESSIONS_DIR)) {
    let live = 0
    for (const project of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const projectPath = path.join(SESSIONS_DIR, project.name)
      for (const session of fs.readdirSync(projectPath, { withFileTypes: true })) {
        if (!session.isDirectory()) continue
        if (probeSessionLock(path.join(projectPath, session.name)) === 'held') live += 1
      }
    }
    if (live > 0) reasons.push(`检测到 ${live} 个会话的写锁被占用（有活跃会话正在写入日志）`)
  }
  return { running: reasons.length > 0, reasons }
}

/** DSH Web 的候选端口：官方默认 3080，另附常用备用端口。 */
const DSH_WEB_PORTS = [3080, 3081, 8080]

/**
 * 删除一批会话的投影缓存。
 *
 * 缓存记录按「会话身份」（createdAt/cwd/格式代）绑定：会话目录一旦删除，这条记录
 * 就永远等不到匹配的日志，成为永不失效的死记录。官方不清理它（缓存本身按身份
 * 失配即丢弃，读路径安全），因此删除动作必须自己收尾。
 * @param sessionIds - 已删除的会话 id 列表。
 * @returns 实际尝试清除的条数。
 */
function removeProjectionCache(sessionIds) {
  let removed = 0
  for (const id of sessionIds) {
    try {
      fs.rmSync(path.join(DSH_ROOT, 'storages', 'session_projcache', 'sessions', `${id}.json`), { force: true })
      removed += 1
    } catch { }
  }
  return removed
}

/**
 * 把会话的归属从原工作区移到目标目录对应的工作区。
 *
 * 会话 id 本身不变（只换目录），因此只动 workspace.json 的两处账目：
 * 原记录摘除该 id（记录清空则删除），目标记录并入（不存在则以目标 realpath 新建）。
 * 最后强制重建「顺序表 ↔ 表项」的一一对应，因为 dsh-workspace 的
 * validateStoredState() 会校验这一点，不齐会直接启动失败。
 * @param sessionId - 会话 id。
 * @param targetReal - 目标目录的 realpath 规范形式。
 * @returns 更新结果摘要。
 */
function updateWorkspaceForMove(sessionId, targetReal) {
  if (!fs.existsSync(WORKSPACE_STATE_FILE)) return { moved: false, reason: '工作区注册表不存在' }
  let state
  try {
    state = JSON.parse(fs.readFileSync(WORKSPACE_STATE_FILE, 'utf8'))
  } catch {
    return { moved: false, reason: '工作区注册表无法解析' }
  }
  const tables = state.tables?.workspaces
  if (tables === undefined) return { moved: false, reason: '工作区注册表结构异常' }

  const now = new Date().toISOString()
  let fromTitle
  for (const [id, record] of Object.entries(tables)) {
    if (!Array.isArray(record.sessionIds) || !record.sessionIds.includes(sessionId)) continue
    fromTitle = record.title
    record.sessionIds = record.sessionIds.filter((sid) => sid !== sessionId)
    record.updatedAt = now
    if (record.sessionIds.length === 0) delete tables[id]
  }

  let targetId
  for (const [id, record] of Object.entries(tables)) {
    if (record.path === targetReal) {
      targetId = id
      break
    }
  }
  if (targetId === undefined) {
    targetId = require('node:crypto').randomUUID()
    tables[targetId] = {
      path: targetReal,
      title: path.basename(targetReal) || targetReal,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
  }
  if (!tables[targetId].sessionIds.includes(sessionId)) tables[targetId].sessionIds.unshift(sessionId)
  tables[targetId].updatedAt = now

  const prior = Array.isArray(state.global.workspaceIds) ? state.global.workspaceIds : []
  const ordered = prior.filter((id) => tables[id] !== undefined)
  if (!ordered.includes(targetId)) ordered.unshift(targetId)
  for (const id of Object.keys(tables)) if (!ordered.includes(id)) ordered.push(id)
  state.global.workspaceIds = ordered

  writeJsonAtomic(WORKSPACE_STATE_FILE, state)
  return { moved: true, workspaceId: targetId, title: tables[targetId].title, from: fromTitle }
}

/**
 * 把一个会话移动到目标目录。
 *
 * 执行顺序刻意做成「先写目标、校验通过、再删源」：任何一步失败都只会清掉
 * 刚写出的目标副本，源会话保持原样，不会出现两头都不完整的中间态。
 * @param sessionDir - 源会话目录。
 * @param targetInput - 目标目录路径（绝对路径或可解析的相对路径）。
 * @param options - `create` 为真时允许创建尚不存在的目标目录。
 * @returns 移动结果摘要。
 */
function moveSession(sessionDir, targetInput, options = {}) {
  const logPath = pickSessionLog(sessionDir)
  if (logPath === undefined) throw new Error('该会话目录没有规范日志，无法移动')
  const header = readSessionHeader(logPath)
  if (header === undefined || typeof header.id !== 'string') throw new Error('无法读取会话头，日志可能损坏')
  const id = header.id
  const sourceCwd = typeof header.cwd === 'string' ? header.cwd : undefined

  if (typeof targetInput !== 'string' || targetInput.trim().length === 0) throw new Error('目标目录不能为空')
  const targetPath = path.resolve(targetInput.trim())
  if (options.create === true && !fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true })

  let targetReal
  try {
    targetReal = fs.realpathSync(targetPath)
  } catch {
    const error = new Error(`目标目录不存在或不可访问：${targetPath}`)
    error.code = 'TARGET_MISSING'
    throw error
  }
  if (!fs.statSync(targetReal).isDirectory()) throw new Error(`目标不是目录：${targetReal}`)

  if (sourceCwd !== undefined) {
    let sourceReal
    try {
      sourceReal = fs.realpathSync(sourceCwd)
    } catch {
      sourceReal = undefined
    }
    if (sourceReal === targetReal) {
      const error = new Error('目标目录与该会话当前的工作目录相同，无需移动')
      error.code = 'SAME_TARGET'
      throw error
    }
  }

  if (probeSessionLock(sessionDir) === 'held') {
    throw new Error(`会话 ${id} 的写锁被占用（DSH 正在写入），已拒绝移动`)
  }

  const targetSessionDir = path.join(SESSIONS_DIR, encodeProjectKey(targetReal), encodeSegment(id))
  if (fs.existsSync(targetSessionDir)) throw new Error(`目标位置已存在同名会话目录：${targetSessionDir}`)
  if (path.resolve(targetSessionDir) === path.resolve(sessionDir)) throw new Error('源与目标位置相同')

  const entries = fs.readdirSync(sessionDir, { withFileTypes: true })
  const logs = entries.filter((entry) => entry.isFile() && SESSION_LOG_PATTERN.test(entry.name)).map((entry) => entry.name)
  if (logs.length === 0) throw new Error('该会话目录没有日志文件')

  fs.mkdirSync(targetSessionDir, { recursive: true })
  try {
    for (const entry of entries) {
      const from = path.join(sessionDir, entry.name)
      const to = path.join(targetSessionDir, entry.name)
      if (entry.isDirectory()) fs.cpSync(from, to, { recursive: true })
      else if (SESSION_LOG_PATTERN.test(entry.name)) fs.writeFileSync(to, rewriteLogHeaderCwd(from, targetReal))
      else fs.copyFileSync(from, to)
    }
    // 写入校验：每一代的 header 都必须已经是新 cwd，否则宁可回滚。
    for (const name of logs) {
      const check = readSessionHeader(path.join(targetSessionDir, name))
      if (check === undefined || check.cwd !== targetReal) throw new Error(`写入校验失败（header.cwd 未更新）：${name}`)
    }
    fs.rmSync(sessionDir, { recursive: true, force: true })
  } catch (error) {
    try {
      fs.rmSync(targetSessionDir, { recursive: true, force: true })
    } catch { }
    throw error
  }

  // 源项目目录若已空则一并清掉，避免侧栏留下空分组。
  const sourceProjectDir = path.dirname(sessionDir)
  let removedProjectDir
  try {
    if (fs.existsSync(sourceProjectDir) && fs.readdirSync(sourceProjectDir).length === 0) {
      fs.rmSync(sourceProjectDir, { recursive: true, force: true })
      removedProjectDir = sourceProjectDir
    }
  } catch { }

  // 投影缓存的匹配身份含 cwd，移动后必然失配；删掉它，避免留下永不命中的死记录。
  try {
    fs.rmSync(path.join(DSH_ROOT, 'storages', 'session_projcache', 'sessions', `${id}.json`), { force: true })
  } catch { }

  return {
    id,
    from: sourceCwd,
    to: targetReal,
    targetSessionDir,
    removedProjectDir,
    workspace: updateWorkspaceForMove(id, targetReal),
  }
}

/**
 * 命令行里的交互式移动：收集目标目录、确认后调用 moveSession。
 * @param nextLine - 行读取器。
 * @param session - readSessionSummary() 的返回值。
 */
async function moveSessionInteractive(nextLine, session) {
  const label = session.title ?? oneLine(session.firstUserText, 30)
  console.log('')
  console.log(`会话 id     ${session.id}`)
  console.log(`当前目录    ${session.header?.cwd ?? '(未记录)'}`)
  console.log(`标题        ${label || '(无)'}`)

  const status = await detectRunningDsh()
  if (status.running) {
    console.log('')
    console.log('[拒绝] 检测到 DSH 正在运行，此时移动会破坏正在写入的日志：')
    for (const reason of status.reasons) console.log(`       - ${reason}`)
    console.log('       请先退出 DSH 再重试。')
    return
  }

  const target = await promptLine(nextLine, '目标目录（绝对路径，留空取消）› ')
  if (target === undefined || target === '') {
    console.log('已取消')
    return
  }
  let create = false
  if (!fs.existsSync(path.resolve(target))) {
    const answer = await promptLine(nextLine, '目标目录不存在，创建它吗？（输入 y 创建，其他取消）› ')
    if (answer === undefined || answer.toLowerCase() !== 'y') {
      console.log('已取消')
      return
    }
    create = true
  }
  if (!(await confirm(nextLine, `将把会话 ${session.id} 移动到 ${path.resolve(target)}（日志与归属一并迁移）`))) {
    console.log('已取消')
    return
  }

  try {
    const result = moveSession(session.sessionPath, target, { create })
    console.log('')
    console.log(`[移动] 完成：${result.from ?? '(无 cwd)'} → ${result.to}`)
    console.log(`[移动] 新位置：${result.targetSessionDir}`)
    if (result.removedProjectDir !== undefined) console.log(`[移动] 源目录已空，一并清除：${result.removedProjectDir}`)
    if (result.workspace.moved === true) {
      console.log(`[移动] 工作区归属已更新：${result.workspace.from ?? '(原无归属)'} → ${result.workspace.title}`)
    } else {
      console.log(`[移动] 工作区归属未更新（${result.workspace.reason}）；下次 --apply 会按磁盘重建`)
    }
    console.log('[移动] 若 DSH 正在运行请重启后再查看侧栏。')
  } catch (error) {
    console.error(`[移动] 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 建立一个「不丢行」的行读取器。
 *
 * 不用 rl.question()：它只在提问的那一刻挂监听，若多行输入（无 TTY 的管道、一次性
 * 粘贴）在同一批到达，提问间歇内触发的 line 事件会被直接丢弃，命令就静默失效。
 * 因此先入队、按需取出，EOF 时以 undefined 表示结束。
 * @param rl - readline 接口。
 * @returns 取下一行的函数（返回去空白后的字符串，或 undefined 表示输入已结束）。
 */
function createLineReader(rl) {
  const queue = []
  let waiter
  let closed = false
  rl.on('line', (line) => {
    if (waiter !== undefined) {
      const resolve = waiter
      waiter = undefined
      resolve(line)
      return
    }
    queue.push(line)
  })
  rl.on('close', () => {
    closed = true
    if (waiter !== undefined) {
      const resolve = waiter
      waiter = undefined
      resolve(undefined)
    }
  })
  return () => {
    if (queue.length > 0) return Promise.resolve(queue.shift())
    if (closed) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      waiter = resolve
    })
  }
}

/** 打印提示并取下一行；输入结束（EOF）返回 undefined，由调用方按「退出」处理。 */
async function promptLine(nextLine, text) {
  process.stdout.write(text)
  const line = await nextLine()
  if (line === undefined) {
    process.stdout.write('\n')
    return undefined
  }
  return line.trim()
}

async function confirm(nextLine, prompt) {
  const answer = await promptLine(nextLine, `${prompt}（输入 y 确认，其他取消）› `)
  if (answer === undefined) return false
  const normalized = answer.toLowerCase()
  return normalized === 'y' || normalized === 'yes'
}

function reportDeletion(deletedSessionIds, note, removedCache) {
  const pruned = pruneWorkspaceState(deletedSessionIds)
  console.log(`[删除] ${note}`)
  console.log(`[删除] 工作区账目同步摘除：${pruned.sessions} 个会话归属、${pruned.workspaces} 个已清空的工作区`)
  console.log(`[删除] 投影缓存已清除 ${removedCache} 条（避免留下永不命中的死记录）`)
  console.log('[删除] 若 dsh 正在运行，请重启后查看侧栏（进程内状态不会热感知磁盘删除）')
}

async function manageOneProject(nextLine, project) {
  for (; ;) {
    const sessions = project.sessionDirs.map((entry) => readSessionSummary(entry.path))
    printSessionTable(project, sessions)
    const input = await promptLine(nextLine, 'd <序号> 删除会话 | m <序号> 移动会话 | i <序号> 详情 | r 刷新 | q 返回上级 › ')
    if (input === undefined || input === '' || input.toLowerCase() === 'q') return
    if (input.toLowerCase() === 'r') continue

    const move = /^m\s+(\d+)$/i.exec(input)
    if (move !== null) {
      const session = sessions[Number(move[1]) - 1]
      if (session === undefined) {
        console.log('序号超出范围')
        continue
      }
      await moveSessionInteractive(nextLine, session)
      continue
    }

    const detail = /^i\s+(\d+)$/i.exec(input)
    if (detail !== null) {
      const session = sessions[Number(detail[1]) - 1]
      if (session === undefined) {
        console.log('序号超出范围')
        continue
      }
      console.log('')
      console.log(`会话 id     ${session.id}`)
      console.log(`日志        ${session.logPath ?? '(无规范日志)'}`)
      console.log(`创建时间    ${formatTime(session.header?.createdAt)}`)
      console.log(`最后事件    ${formatTime(session.lastTime)}`)
      console.log(`工作目录    ${session.header?.cwd ?? '(未记录)'}`)
      console.log(`预设        ${session.header?.agentPreset ?? '-'}      日志版本 v${session.header?.version ?? '?'}`)
      console.log(`标题        ${session.title ?? '(无)'}`)
      console.log(`首条消息    ${oneLine(session.firstUserText, 120) || '(无)'}`)
      if (session.truncated === true) console.log('注意        日志尾部不完整（有未写完的帧），显示内容可能不全')
      continue
    }

    const remove = /^d\s+(\d+)$/i.exec(input)
    if (remove !== null) {
      const session = sessions[Number(remove[1]) - 1]
      if (session === undefined) {
        console.log('序号超出范围')
        continue
      }
      const label = session.title ?? oneLine(session.firstUserText, 24)
      if (!(await confirm(nextLine, `将永久删除会话 ${session.id}（${formatBytes(session.size)}${label === '' ? '' : `，${label}`}）及其全部文件`))) {
        console.log('已取消')
        continue
      }
      fs.rmSync(session.sessionPath, { recursive: true, force: true })
      reportDeletion([session.id], `已删除会话 ${session.id}`, removeProjectionCache([session.id]))
      project.sessionDirs = project.sessionDirs.filter((entry) => entry.name !== path.basename(session.sessionPath))
      if (project.sessionDirs.length === 0) {
        console.log('[提示] 该目录已无会话，可返回上级用 d <序号> 删除整个目录')
        return
      }
      continue
    }
    console.log('无法识别的输入')
  }
}

async function manageSessions(nextLine) {
  for (; ;) {
    const projects = loadProjectEntries()
    if (projects.length === 0) {
      console.log(`未找到任何工作区目录：${SESSIONS_DIR}`)
      return
    }
    printProjectTable(projects)
    const input = await promptLine(nextLine, '<序号> 进入 | d <序号> 删除整个目录 | r 刷新 | q 返回主菜单 › ')
    if (input === undefined || input === '' || input.toLowerCase() === 'q') return
    if (input.toLowerCase() === 'r') continue

    const remove = /^d\s+(\d+)$/i.exec(input)
    if (remove !== null) {
      const project = projects[Number(remove[1]) - 1]
      if (project === undefined) {
        console.log('序号超出范围')
        continue
      }
      const ids = []
      for (const entry of project.sessionDirs) {
        let id
        try {
          const header = entry.logPath === undefined ? undefined : readSessionHeader(entry.logPath)
          if (typeof header?.id === 'string') id = header.id
        } catch { }
        // 头读不出来时退回目录名的严格逆编码，绝不拿编码名当 id。
        ids.push(id ?? decodeSegment(entry.name))
      }
      if (!(await confirm(nextLine, `将永久删除目录 ${project.displayPath}（${project.sessionDirs.length} 个会话，${formatBytes(project.totalBytes)}）`))) {
        console.log('已取消')
        continue
      }
      fs.rmSync(project.path, { recursive: true, force: true })
      reportDeletion(ids, `已删除目录 ${project.dirName}（${project.sessionDirs.length} 个会话）`, removeProjectionCache(ids))
      continue
    }

    const index = Number(input)
    const project = Number.isInteger(index) ? projects[index - 1] : undefined
    if (project === undefined) {
      console.log('无法识别的输入')
      continue
    }
    await manageOneProject(nextLine, project)
  }
}

function applyPatchesInProcess() {
  console.log('[menu] 正在以 --apply 重新执行本脚本，输出如下：')
  const result = spawnSync(process.execPath, [__filename, '--apply'], { stdio: 'inherit' })
  if (result.error !== undefined) console.error('[menu] 启动补丁进程失败:', result.error.message)
  else if (typeof result.status === 'number' && result.status !== 0) console.error(`[menu] 补丁进程退出码 ${result.status}`)
}

async function runMenu() {
  console.log('=============================================================')
  console.log('🚀 DeepSeek Harness 维护台（.js）')
  console.log('=============================================================')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const nextLine = createLineReader(rl)
  try {
    for (; ;) {
      console.log('')
      console.log('  1) 管理会话（按目录查看/删除/移动会话，目录名已反解为可读路径）')
      console.log('  2) 应用补丁（插件 / 预设 / profile 挂载 / 底层补丁 / 工作区自愈）')
      console.log('  q) 退出')
      const choice = await promptLine(nextLine, '选择 › ')
      if (choice === undefined || choice.toLowerCase() === 'q' || choice === '') break
      if (choice === '1') await manageSessions(nextLine)
      else if (choice === '2') applyPatchesInProcess()
      else console.log('无法识别的输入')
    }
  } finally {
    rl.close()
  }
  console.log('[menu] 已退出。')
}

// ── 入口分流：默认进菜单；--apply 才执行补丁 ───────────────────────────────────
const APPLY_MODE = process.argv.includes('--apply') || process.argv.includes('-a')
const LIST_INDEX = process.argv.indexOf('--list')

if (LIST_INDEX >= 0) {
  const target = process.argv[LIST_INDEX + 1]
  const projects = loadProjectEntries()
  if (target === undefined || target.startsWith('-')) {
    printProjectTable(projects)
  } else {
    const project = projects.find((entry) => entry.dirName === target)
      ?? projects.find((entry) => entry.displayPath.includes(target))
      ?? projects[Number(target) - 1]
    if (project === undefined) console.log(`未找到匹配的项目目录：${target}`)
    else printSessionTable(project, project.sessionDirs.map((entry) => readSessionSummary(entry.path)))
  }
  return
}

if (!APPLY_MODE) {
  runMenu().catch((error) => {
    console.error('[menu] 交互界面异常退出:', error)
    process.exitCode = 1
  })
  // CommonJS 顶层 return：菜单接管事件循环，不再落入下面的补丁流程。
  return
}

console.log('=============================================================')
console.log('🚀 DeepSeek Harness 全功能增强与插件生态部署安装器')
console.log('=============================================================')

// 1. 确保必要目录完整就绪

for (const dir of [PLUGINS_DIR, WEB_PROFILE_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    console.log(`[setup] 创建目录: ${dir}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 插件落地位置
//
// 插件文件本身是**手写资源**：它们作为仓库内容持久化在 `~/.dsh/plugins/` 下，由人
// 维护，本脚本既不生成也不覆写 —— 生成器覆写会把磁盘上逐字校对过的内容盖回模板
// 版本。脚本只做两件事：在这里声明它们的绝对路径，供第 4 节挂进 profile 补丁；
// 以及挂载前校验契约（verifyHostPlugins / verifyClientBundle）。
//
// 双面插件（idle-arm / prompt-forge）必须是真正的包目录：dsh-client-modules 靠
// package.json 的 exports["./client"] 定位客户端 bundle，而 nearestPackage 是从模块
// 路径向上找最近的 package.json，所以这份声明只能放在自己的子目录里，不能放到
// plugins/ 根 —— 否则 plugins/ 下所有插件都会被误认为声明了同一个客户端 bundle。
// ─────────────────────────────────────────────────────────────────────────────
const creativeWorkflowPath = path.join(PLUGINS_DIR, 'creative-workflow.js')
const reflectCommandPath = path.join(PLUGINS_DIR, 'reflect-command.js')
const hotreloadMeterPath = path.join(PLUGINS_DIR, 'preset-hotreload-and-meter.js')
const exploreCommandPath = path.join(PLUGINS_DIR, 'explore-command.js')
const gitCommandPath = path.join(PLUGINS_DIR, 'git-command.js')
const injectCommandPath = path.join(PLUGINS_DIR, 'inject-command.js')
const idleGuardPath = path.join(PLUGINS_DIR, 'idle-guard.js')
const IDLE_ARM_DIR = path.join(PLUGINS_DIR, 'idle-arm')
const IDLE_ARM_HOST = path.join(IDLE_ARM_DIR, 'lib', 'index.js')

/**
 * 校验单体宿主插件的存在与导出契约。
 *
 * 这些文件过去由本脚本生成，所以「文件在、能加载」是白送的；现在它们是与
 * prompt-forge / tools.js 同样的持久化手写资源，缺失或写坏时的表现是**静默**的：
 * profile 补丁照样指向一个不存在的 file:// 条目，fiber 停在未激活且不报错，命令与
 * 界面一起消失，而脚本打印部署成功。因此这里在挂载前逐条验到契约层面。
 * @returns {string[]} 问题列表（空数组表示全部通过）。
 */
function verifyHostPlugins() {
  const problems = []
  for (const file of [creativeWorkflowPath, reflectCommandPath, hotreloadMeterPath, exploreCommandPath, gitCommandPath, injectCommandPath, idleGuardPath]) {
    if (!fs.existsSync(file)) {
      problems.push(`缺少 ${file}`)
      continue
    }
    let plugin
    try {
      plugin = require(file)
    } catch (error) {
      problems.push(`${file} 无法加载: ${error.message}`)
      continue
    }
    // 只声明不导出等于没装：cordis 找不到 apply() 就静默跳过这一行。
    if (typeof plugin?.apply !== 'function') problems.push(`${file} 没有导出 apply()`)
    if (typeof plugin?.name !== 'string' || plugin.name.length === 0) problems.push(`${file} 没有导出非空 name`)
  }
  // idle-arm 的宿主半边是 ESM，只核对存在：它唯一的职责是让那个包目录成立。
  if (!fs.existsSync(IDLE_ARM_HOST)) problems.push(`缺少 ${IDLE_ARM_HOST}（idle-arm 的宿主半边）`)
  return problems
}

const hostPluginProblems = verifyHostPlugins()
if (hostPluginProblems.length > 0) {
  for (const problem of hostPluginProblems) console.error(`  [plugins] ${problem}`)
  console.error(`  [plugins] 宿主插件不完整：对应的命令与工具会静默消失。请从仓库恢复 ${PLUGINS_DIR}。`)
  process.exitCode = 1
} else {
  console.log(`[plugins] 宿主插件就位: ${PLUGINS_DIR}`)
}

// prompt-forge 与 idle-arm 同样是「宿主半边 + 客户端半边」的双面插件，理由完全一致：
// dsh-client-modules 靠 package.json 的 exports["./client"] 定位客户端 bundle，而
// nearestPackage 是向上找最近的 package.json，所以声明只能放在自己的子目录里。
//
// 与其它插件不同，它是**手写资源**：lib/ 下五个模块（index / client / prompt /
// forge-prompts / templates）全部在仓库里维护，脚本既不生成也不覆盖 —— 那些文件里的
// 提示词与渲染规则是逐字校对过的，生成器覆写会把磁盘上的内容覆盖成模板里的版本。
const PROMPT_FORGE_DIR = path.join(PLUGINS_DIR, 'prompt-forge')
const PROMPT_FORGE_HOST = path.join(PROMPT_FORGE_DIR, 'lib', 'index.js')
const PROMPT_FORGE_CLIENT = path.join(PROMPT_FORGE_DIR, 'lib', 'client.js')

// msg-edit / md-session-import：两个在 plugins/ 下的双面插件。它们的入口就在包根
// （index.js），不像 prompt-forge / idle-arm 那样放在 lib/ 下。
const MSG_EDIT_DIR = path.join(PLUGINS_DIR, 'msg-edit')
const MSG_EDIT_HOST = path.join(MSG_EDIT_DIR, 'index.js')
const MD_IMPORT_DIR = path.join(PLUGINS_DIR, 'md-session-import')
const MD_IMPORT_HOST = path.join(MD_IMPORT_DIR, 'index.js')

// rewind：会话回退（把会话退到更早的消息，可选一并还原工作区文件）。
// 入口在 lib/ 下，与 prompt-forge 同构；宿主半边 import 了 @deepseek-ai/dsh-llm、
// dsh-home-paths 与 schemastery，因此它和 msg-edit 一样必须是 link: 依赖。
const REWIND_DIR = path.join(PLUGINS_DIR, 'rewind')
const REWIND_HOST = path.join(REWIND_DIR, 'lib', 'index.js')
const REWIND_CLIENT = path.join(REWIND_DIR, 'lib', 'client.js')
// 宿主半边拆成了多个 ESM 模块，任何一个缺失都是 import 期 ERR_MODULE_NOT_FOUND：
// fiber 停在未激活且不报错，整个回退功能静默消失。
const REWIND_MODULES = ['locales.js', 'marker.js', 'rewind.js', 'snapshot.js', 'snapshot-cleanup.js']
const PROFILE_PKG_FILE = path.join(WEB_PROFILE_DIR, 'package.json')

/**
 * 校验一个「宿主半边 + 客户端半边」双面包的声明是否真的成立。
 *
 * 只检查文件存在是不够的：客户端半边要靠 package.json 的 dsh.client + exports["./client"]
 * 才会被 dsh-client-modules 装配，而 bundle 里 `__ModuleLoader__.load({ id })` 的 id
 * 又必须严格等于 package.json 的 name（client-modules 会拿 manifest 里的 id 去比对，
 * 不一致就报「loaded without registering」）。这两处任何一处错位，结果都是界面上的
 * 那块东西静默不出现——脚本却照样打印「部署成功」。所以这里逐条验到契约层面，任一
 * 不满足即以非零码退出，绝不把「界面缺了一块」伪装成成功。
 * @param {string} dir - 包目录。
 * @returns {string[]} 校验发现的问题列表（空数组表示全部通过）。
 */
function verifyClientBundle(dir) {
  const problems = []
  const pkgFile = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgFile)) {
    problems.push(`缺少 ${pkgFile}`)
    return problems
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  } catch (error) {
    problems.push(`${pkgFile} 不是合法 JSON: ${error.message}`)
    return problems
  }
  const name = manifest.name
  if (typeof name !== 'string' || name.length === 0) problems.push(`${pkgFile} 缺少 name`)
  if (manifest?.dsh?.client?.platform !== 'web') problems.push(`${pkgFile} 的 dsh.client.platform 必须是 'web'`)
  const clientExport = manifest?.exports?.['./client']
  const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
  if (typeof clientRel !== 'string' || clientRel.length === 0) {
    problems.push(`${pkgFile} 的 exports["./client"] 未指向客户端 bundle`)
    return problems
  }
  const clientFile = path.join(dir, clientRel)
  if (!fs.existsSync(clientFile)) {
    problems.push(`${pkgFile} 的 exports["./client"] 指向不存在的文件: ${clientRel}`)
    return problems
  }
  // bundle 注册的 id 必须与包名一致，否则 client-modules 直接判为「loaded without registering」。
  const registered = /__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/.exec(fs.readFileSync(clientFile, 'utf8'))
  if (registered === null) {
    problems.push(`${clientFile} 未按 window.__ModuleLoader__.load({ id, factory }) 形式注册`)
  } else if (typeof name === 'string' && registered[1] !== name) {
    problems.push(`bundle 注册 id「${registered[1]}」与 package.json name「${name}」不一致（client-modules 会拒绝装配）`)
  }
  return problems
}

/** 校验 idle-arm 的双面声明（提交键旁的落盘拦截按钮）。 */
const verifyIdleArmBundle = () => verifyClientBundle(IDLE_ARM_DIR)

/**
 * 校验 prompt-forge 的双面声明与模块完整性。
 *
 * 与 idle-arm 同一套契约检查（复用 verifyClientBundle），额外多两条它独有的：
 *   · 宿主半边必须导出 apply / inject / name，且 inject 里带 tools 与 commands；
 *   · lib/ 下五个模块一个都不能少 —— 少一个的后果是 import 期 ERR_MODULE_NOT_FOUND，
 *     fiber 停在未激活且不报错（ESM 的失败不会冒泡到部署脚本）。
 * @returns {string[]} 问题列表（空数组表示全部通过）。
 */
function verifyPromptForgeBundle() {
  const problems = verifyClientBundle(PROMPT_FORGE_DIR)
  for (const file of [PROMPT_FORGE_HOST, PROMPT_FORGE_CLIENT]) {
    if (!fs.existsSync(file)) problems.push(`缺少 ${file}`)
  }
  for (const name of ['prompt.js', 'templates.js', 'forge-prompts.js']) {
    const file = path.join(PROMPT_FORGE_DIR, 'lib', name)
    if (!fs.existsSync(file)) problems.push(`缺少 ${file}（宿主半边 import 它，缺失会让整个插件静默不激活）`)
  }
  // 宿主半边的导出契约：ESM 下用文本匹配，避免在这里引入动态 import（顶层 await 会
  // 把整个部署脚本变成异步模块，而它现在是同步 CommonJS）。
  if (fs.existsSync(PROMPT_FORGE_HOST)) {
    const host = fs.readFileSync(PROMPT_FORGE_HOST, 'utf8')
    for (const symbol of ['export function apply', 'export const inject', 'export const name']) {
      if (!host.includes(symbol)) problems.push(`${PROMPT_FORGE_HOST} 缺少 ${symbol}`)
    }
    if (!/'tools'/.test(host) || !/'commands'/.test(host)) {
      problems.push(`${PROMPT_FORGE_HOST} 的 inject 必须同时包含 'tools' 与 'commands'`)
    }
  }
  return problems
}

const promptForgeProblems = verifyPromptForgeBundle()
if (promptForgeProblems.length > 0) {
  for (const problem of promptForgeProblems) console.error(`  [prompt-forge] ${problem}`)
  console.error('  [prompt-forge] 双面声明不完整：输入框右侧的改写按钮不会出现。请从仓库恢复 plugins/prompt-forge/。')
  process.exitCode = 1
} else {
  console.log(`[plugins] prompt-forge 双面插件就位: ${PROMPT_FORGE_DIR}`)
}

/**
 * 校验 rewind 的双面声明、宿主模块完整性与 link: 依赖。
 *
 * 比 msg-edit 多验两件事，因为 rewind 的宿主半边**真的会用到**那几个裸说明符：
 *   · lib/ 下六个模块一个都不能少（宿主 index.js import 其余五个）；
 *   · profile 里必须有 `dsh-rewind: link:<插件目录>` 且 node_modules 里有对应的
 *     junction —— 裸 @deepseek-ai 说明符只对「linked root 内、且自身 package.json
 *     声明了该 peer」的模块做拦截（dsh-app-boot: findInterceptionLayer / routeLinked）。
 *     缺了这一环，加载期是 ERR_MODULE_NOT_FOUND，fiber 静默停在未激活。
 * @returns {string[]} 问题列表（空数组表示全部通过）。
 */
function verifyRewindBundle() {
  const problems = verifyClientBundle(REWIND_DIR)
  if (!fs.existsSync(REWIND_HOST)) problems.push(`缺少 ${REWIND_HOST}（rewind 的宿主半边）`)
  if (!fs.existsSync(REWIND_CLIENT)) problems.push(`缺少 ${REWIND_CLIENT}（rewind 的客户端半边）`)
  for (const name of REWIND_MODULES) {
    const file = path.join(REWIND_DIR, 'lib', name)
    if (!fs.existsSync(file)) problems.push(`缺少 ${file}（宿主半边 import 它，缺失会让整个插件静默不激活）`)
  }
  if (fs.existsSync(REWIND_HOST)) {
    const host = fs.readFileSync(REWIND_HOST, 'utf8')
    for (const symbol of ['apply', 'inject', 'name']) {
      if (!new RegExp(`^\\s+${symbol},?$`, 'm').test(host.slice(host.lastIndexOf('\nexport {')))) {
        problems.push(`${REWIND_HOST} 的导出块缺少 ${symbol}`)
      }
    }
  }
  let profileManifest
  try {
    profileManifest = JSON.parse(fs.readFileSync(PROFILE_PKG_FILE, 'utf8'))
  } catch (error) {
    problems.push(`${PROFILE_PKG_FILE} 无法解析: ${error.message}`)
    profileManifest = undefined
  }
  if (profileManifest !== undefined) {
    const spec = profileManifest?.dependencies?.['dsh-rewind']
    if (typeof spec !== 'string' || !spec.startsWith('link:')) {
      problems.push(`${PROFILE_PKG_FILE} 缺少 dependencies["dsh-rewind"]: "link:${REWIND_DIR}"（宿主半边的 @deepseek-ai 裸说明符靠它解析）`)
    }
    const junction = path.join(WEB_PROFILE_DIR, 'node_modules', 'dsh-rewind')
    if (!fs.existsSync(junction)) problems.push(`缺少 ${junction}（linked root 是从 node_modules 下的符号链接发现的，不是从 package.json）`)
    // 旧的 npm 包必须彻底退场：它同时声明 dsh.bundle，留在 bundles 里就会和这一份抢同一套界面。
    if (profileManifest?.dsh?.profile?.bundles?.includes('dsh-rewind-plugin')) {
      problems.push(`${PROFILE_PKG_FILE} 的 dsh.profile.bundles 仍含 dsh-rewind-plugin（会与本地插件重复挂载）`)
    }
  }
  return problems
}

/**
 * 确保 rewind 在 profile 的 node_modules 下有一条 junction。
 *
 * linked root 是从 `profiles/<name>/node_modules` 下的**符号链接**发现的
 * （dsh-app-boot: linkedProfileRoots 遍历该目录找 symlink），不是从 package.json 的
 * link: 声明发现的。所以那行依赖只是给人看的，真正起作用的是这条 junction：
 * 它一缺，宿主半边的 @deepseek-ai 裸说明符就没有拦截层，加载期 ERR_MODULE_NOT_FOUND，
 * fiber 静默停在未激活。pnpm 重装 node_modules 会把它冲掉，因此这里在挂载前补齐。
 * @returns {string} 本次动作（已存在 / 已创建），供日志使用。
 */
function ensureRewindLink() {
  const linkPath = path.join(WEB_PROFILE_DIR, 'node_modules', 'dsh-rewind')
  if (fs.existsSync(linkPath)) return '已存在'
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(REWIND_DIR, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  return '已创建'
}

const rewindLinkAction = ensureRewindLink()
const rewindProblems = verifyRewindBundle()
if (rewindProblems.length > 0) {
  for (const problem of rewindProblems) console.error(`  [rewind] ${problem}`)
  console.error('  [rewind] 双面声明不完整：回退入口不会出现。请从仓库恢复 plugins/rewind/。')
  process.exitCode = 1
} else {
  console.log(`[plugins] rewind 双面插件就位: ${REWIND_DIR}（link 挂载点${rewindLinkAction}）`)
}

/**
 * 校验 msg-edit / md-session-import 的双面声明。
 *
 * 与 idle-arm 同一套契约（复用 verifyClientBundle），额外只核对宿主半边在位：
 * 两个宿主半边都是 ESM，不在这个同步脚本里动态 import，缺失的后果同样是「界面
 * 静默少一块」，所以存在性也要验。
 * @param {string} dir - 包目录。
 * @param {string} host - 宿主半边入口文件。
 * @param {string} label - 报告用的名字。
 * @returns {string[]} 问题列表（空数组表示全部通过）。
 */
function verifyPluginHalves(dir, host, label) {
  const problems = verifyClientBundle(dir)
  if (!fs.existsSync(host)) problems.push(`缺少 ${host}（${label} 的宿主半边）`)
  return problems
}

for (const [label, dir, host] of [
  ['msg-edit', MSG_EDIT_DIR, MSG_EDIT_HOST],
  ['md-session-import', MD_IMPORT_DIR, MD_IMPORT_HOST],
]) {
  const problems = verifyPluginHalves(dir, host, label)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  [${label}] ${problem}`)
    console.error(`  [${label}] 双面声明不完整：界面上的入口不会出现。请从仓库恢复 plugins/${label}/。`)
    process.exitCode = 1
  } else {
    console.log(`[plugins] ${label} 双面插件就位: ${dir}`)
  }
}

/**
 * 校验自定义工具集（`tools.js`）的契约。
 *
 * 只检查文件存在是不够的：一个语法错误，或某个工具从注册列表里漏掉，结果都是
 * 「工具静默不见了」——模型调不到它时才发现，而脚本照样打印部署成功。这里把契约
 * 逐条对上：能加载、导出 apply()、inject 里带 `tools`，以及 TOOL_NAMES 声明的每个
 * 工具名在源码里都真的出现在注册调用的位置。
 * @returns {{problems: string[], names: string[]}} 问题列表与声明注册的工具名。
 */
function verifyToolsBundle() {
  const problems = []
  if (!fs.existsSync(TOOLS_FILE)) {
    problems.push(`缺少 ${TOOLS_FILE}`)
    return { problems, names: [] }
  }
  const source = fs.readFileSync(TOOLS_FILE, 'utf8')
  let plugin
  try {
    plugin = require(TOOLS_FILE)
  } catch (error) {
    problems.push(`${TOOLS_FILE} 无法加载: ${error.message}`)
    return { problems, names: [] }
  }
  if (typeof plugin.apply !== 'function') problems.push(`${TOOLS_FILE} 没有导出 apply()`)
  if (!Array.isArray(plugin.inject) || !plugin.inject.includes('tools')) {
    problems.push(`${TOOLS_FILE} 的 inject 里必须包含 'tools'（否则拿不到注册表，工具一个都装不上）`)
  }
  const names = Array.isArray(plugin.TOOL_NAMES) ? plugin.TOOL_NAMES.filter((name) => typeof name === 'string') : []
  if (names.length === 0) problems.push(`${TOOLS_FILE} 未导出 TOOL_NAMES，无从核对注册契约`)
  for (const name of names) {
    // 只声明不注册等于没装：注册调用一律写成 `name: '<工具名>',`。
    if (!source.includes(`name: '${name}',`)) problems.push(`TOOL_NAMES 声明了 ${name}，但源码里没有注册它的调用`)
  }
  return { problems, names }
}

const toolsBundle = verifyToolsBundle()
if (toolsBundle.problems.length > 0) {
  for (const problem of toolsBundle.problems) console.error(`  [tools] ${problem}`)
  console.error(`  [tools] 自定义工具集不完整：这些工具都不会出现在任何会话里。请从仓库恢复 ${TOOLS_FILE}。`)
  process.exitCode = 1
} else {
  console.log(`[tools] 自定义工具集就位: ${TOOLS_FILE}（${toolsBundle.names.join(' / ')}，由各预设按需声明）`)
}

const idleArmProblems = verifyIdleArmBundle()
if (idleArmProblems.length > 0) {
  for (const problem of idleArmProblems) console.error(`  [idle-arm] ${problem}`)
  console.error('  [idle-arm] 双面声明不完整：界面按钮不会出现（宿主端点 /idle-arm/arm 仍可用）。请从仓库恢复 plugins/idle-arm/。')
  process.exitCode = 1
} else {
  console.log(`[plugins] idle-arm 双面插件就位: ${IDLE_ARM_DIR}`)
}

// 3. 自建预设迁移：把目录预设转成声明式预设
//    官方已彻底移除对 ~/.dsh/.agent-presets/<id>/ 目录的读取（官方 skill
//    `editing-cordis-compositions` 原文：Nothing reads that directory any more）。
//    一个预设就是一条 `@deepseek-ai/dsh-agent-preset` 声明行，config 为
//    { id, name, description, order, plugins }，plugins 即 agent.cordis.yml 的条目列表。
//    本阶段逐目录转换：
//      - id                    ← 目录名（官方要求小写字母/数字/连字符）
//      - name / description / order ← preset.yml
//      - plugins               ← agent.cordis.yml 原样内联（逐行整体右移，
//                                注释、块标量、isolate 组、!!js 表达式全部保持原貌）
//      - 相对资源（name: './x.js'）复制到 profiles/web/preset-assets/<id>/ 并改写引用：
//        插入行的相对路径锚定在「声明所在 patch 文件」的目录，也就是 profiles/web/。
const LEGACY_PRESETS_DIR = path.join(DSH_ROOT, '.agent-presets')
const PRESET_ASSETS_DIR = path.join(WEB_PROFILE_DIR, 'preset-assets')
const PRESET_BLOCK_BEGIN = '# >>> better-dsh:agent-presets (generated) >>>'

// YAML 单引号标量：内部单引号按 YAML 规则翻倍。
const yamlScalar = (value) => `'${String(value).replace(/'/g, "''")}'`

// 读 preset.yml 的三个扁平元数据字段（无需完整 YAML 解析）。
function readPresetMeta(file) {
  const meta = {}
  if (!fs.existsSync(file)) return meta
  for (const line of fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
    const match = /^(name|description|order):[ \t]*(.*?)[ \t]*$/.exec(line)
    if (!match) continue
    const raw = match[2].replace(/^['"]|['"]$/g, '')
    if (raw.length === 0) continue
    if (match[1] === 'order' && /^\d+$/.test(raw)) meta.order = Number(raw)
    else meta[match[1]] = raw
  }
  return meta
}

// 复制相对资源并改写引用，返回改写后的正文。仅处理 name 行，避免误伤正文里的 ./ 文本。
function relocateRelativeAssets(presetId, presetDir, body) {
  const pattern = /^([ \t]*-?[ \t]*name:[ \t]*)(['"]?)(\.\/[^'"\n]+?)(\2)[ \t]*$/gm
  return body.replace(pattern, (match, head, quote, relative) => {
    const source = path.join(presetDir, relative.slice(2))
    if (!fs.existsSync(source) || fs.statSync(source).isDirectory()) {
      console.warn(`  [presets] 相对资源缺失，保持原样: ${relative}（预设 ${presetId}）`)
      return match
    }
    const baseName = path.basename(relative)
    const target = path.join(PRESET_ASSETS_DIR, presetId, baseName)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
    console.log(`  [presets] 资源已就位: ${target}`)
    return `${head}${quote}./preset-assets/${presetId}/${baseName}${quote}`
  })
}

// 预设声明里引用自定义工具集的占位名。预设不能写死 file:// 绝对路径：DSH_HOME
// 可被覆盖、仓库可能换位置，写死的路径会在别的机器上静默失效。因此约定一个占位名，
// 由这里改写成当前 TOOLS_FILE 的绝对 URL。
const TOOLS_PLACEHOLDER = 'better-dsh:tools'

// 把预设声明里的工具集占位名改写成本机绝对路径。与 relocateRelativeAssets 分开：
// 那条处理的是「拷贝资源」，这条只是改写一个名字，不搬文件。
function rewriteToolsPlaceholder(presetId, body) {
  const pattern = new RegExp(`^([ \\t]*-?[ \\t]*name:[ \\t]*)(['"]?)${TOOLS_PLACEHOLDER.replace(/[:]/g, '\\:')}(\\2)[ \\t]*$`, 'gm')
  const url = pathToFileURL(TOOLS_FILE).href
  return body.replace(pattern, (match, head, quote) => {
    if (toolsBundle.problems.length > 0) {
      console.warn(`  [presets] 预设「${presetId}」声明了自定义工具集，但工具集不可用（见上方 [tools] 报文），该行保持占位名不动`)
      return match
    }
    console.log(`  [presets] 预设「${presetId}」引用自定义工具集: ${url}`)
    return `${head}${quote}${url}${quote}`
  })
}

// 核对预设声明的工具名是否都真实存在。写错一个名字不会让部署失败（tools.js 只会
// 跳过它），结果是模型调不到那个工具却没有别处报错，因此在这里就点出来。
//
// 从 custom-tools 那一行开始解析，而不是扫全文的 `tools:`：别的插件完全可能也有一个
// 叫 tools 的配置键，按名字扫会把它当成工具清单读。
function checkDeclaredTools(presetId, body) {
  const names = new Set(toolsBundle.names)
  if (names.size === 0) return
  const lines = body.split('\n')
  // name 行此时已由 rewriteToolsPlaceholder 改写为绝对 URL（工具集不可用时仍是占位名），
  // 两种写法都要认。
  const anchor = lines.findIndex((line) => /^[ \t]*-?[ \t]*name:[ \t]*['"]?(better-dsh:tools|file:\/\/)/.test(line)
    && line.includes(TOOLS_PLACEHOLDER) || /^[ \t]*-?[ \t]*name:[ \t]*['"]?file:\/\/.*tools\.js/.test(line))
  if (anchor < 0) return

  const declared = []
  let inTools = false
  let listIndent = -1
  for (let index = anchor + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^[ \t]*-?[ \t]*id:/.test(line)) break // 下一个插件行，说明本行没有 config.tools
    const key = /^([ \t]*)tools:[ \t]*(.*)$/.exec(line)
    if (key !== null) {
      inTools = true
      listIndent = key[1].length
      // 行内写法 `tools: [a, b]` 与块列表共用同一套切分。
      for (const item of key[2].replace(/^\[|\]$/g, '').split(',')) {
        const name = item.trim().replace(/^['"]|['"]$/g, '')
        if (name.length > 0) declared.push(name)
      }
      continue
    }
    if (!inTools) continue
    const item = /^([ \t]*)-[ \t]+([^#\s]+)/.exec(line)
    // 列表项必须比 tools: 更深（块列表），否则说明列表已经结束、这是同级的下一行。
    if (item !== null && item[1].length > listIndent) {
      declared.push(item[2].replace(/^['"]|['"]$/g, ''))
      continue
    }
    if (line.trim().length > 0) break
  }

  if (declared.length === 0) {
    console.warn(`  [presets] 预设「${presetId}」声明了自定义工具集，但没有 config.tools：该预设不会获得任何自定义工具`)
    return
  }
  const unknown = declared.filter((name) => !names.has(name))
  if (unknown.length > 0) {
    console.warn(`  [presets] 预设「${presetId}」声明了不存在的工具 ${unknown.map((n) => `'${n}'`).join('、')}；`
      + `可用的有：${toolsBundle.names.join(' / ')}`)
  }
}

// 生成完整的预设声明段（含起始标记），供 profile patch 整段替换。
function buildPresetDeclarationsBlock() {
  if (!fs.existsSync(LEGACY_PRESETS_DIR)) return { text: '', count: 0, ids: [] }
  const ids = fs.readdirSync(LEGACY_PRESETS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => /^[a-z0-9-]+$/.test(id))
    .filter((id) => fs.existsSync(path.join(LEGACY_PRESETS_DIR, id, 'agent.cordis.yml')))
    .sort()
  if (ids.length === 0) return { text: '', count: 0, ids: [] }

  // 资源目录每次整棵重建，而不是「缺什么补什么」：来源里删掉的资源必须跟着从
  // profile 里消失，否则 preset-assets 会一直留着过期拷贝，将来 grep 到还会以为
  // 它仍然存在。该目录是纯生成物，内容完全由上面这些目录推导得出，可以放心删。
  fs.rmSync(PRESET_ASSETS_DIR, { recursive: true, force: true })

  const blocks = []
  for (const id of ids) {
    const presetDir = path.join(LEGACY_PRESETS_DIR, id)
    const meta = readPresetMeta(path.join(presetDir, 'preset.yml'))
    const rawBody = fs.readFileSync(path.join(presetDir, 'agent.cordis.yml'), 'utf8').replace(/\r\n/g, '\n')
    const body = rewriteToolsPlaceholder(id, relocateRelativeAssets(id, presetDir, rawBody))
    checkDeclaredTools(id, body)

    const lines = [
      `    - id: preset-${id}`,
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      `        id: ${id}`,
    ]
    if (meta.name !== undefined) lines.push(`        name: ${yamlScalar(meta.name)}`)
    if (meta.description !== undefined) lines.push(`        description: ${yamlScalar(meta.description)}`)
    if (meta.order !== undefined) lines.push(`        order: ${meta.order}`)
    lines.push('        plugins:')
    for (const raw of body.split('\n')) {
      // 逐行整体右移 10 空格：空行保持真空行，块标量内部的空白行照原样保留缩进。
      lines.push(raw.length === 0 ? '' : `          ${raw}`)
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    blocks.push(lines.join('\n'))
    console.log(`  [presets] 已迁移预设「${id}」${meta.name === undefined ? '' : `（${meta.name}）`}`)
  }

  const header = [
    PRESET_BLOCK_BEGIN,
    '# 本节由 ~/.dsh/.js 依据 ~/.dsh/.agent-presets/<id>/ 自动生成，请勿手改本段。',
    '# 每个目录在此转成一条声明行，',
    '# name/description/order 取自 preset.yml，plugins 为 agent.cordis.yml 的原样内联；',
    '# 相对资源已复制到 profiles/web/preset-assets/<id>/ 并改写引用。',
  ].join('\n')
  return { text: `${header}\n- insert:\n${blocks.join('\n\n')}\n`, count: ids.length, ids }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3.5 settings.yaml 迁移（「设置」写进 profile 补丁）
//
// 只解析 ~/.dsh/settings.yaml 本身。`settings.yaml.imported` 是官方 dsh-settings
// 导入后留下的归档，里面的值可能已被网页端改过，拿它当迁移源会把过期值写回补丁层
// 覆盖现行设置，因此不读取。
//
// 本阶段用 LEGACY_SECTION_ENTRIES 的映射把「补丁层能表达」的部分直接写进 profile patch：
//   - 有同名条目的 section → 生成 `- id: <条目>` + `config:` 行。补丁层不区分
//     volatile（volatile 只约束「不重挂就能改」的在线编辑），静态 config 一律生效，
//     因此覆盖面比官方导入更全（例如 ui-theme 的 preference 也能落回来）；
//   - 无同名条目的 section → 打印丢弃原因，值仍保留在 settings.yaml 里，不静默消失。
// 幂等：补丁里已存在同名顶层条目的 section 一律跳过，网页端后续的修改不会被覆盖。
//
// 没有 settings.yaml 时整段跳过，并把补丁里现有的托管区块原样保留：托管区块在重建前
// 已被摘除，若此时返回空区块，那段配置就会从补丁里静默消失。
// ─────────────────────────────────────────────────────────────────────────────

const LEGACY_SETTINGS_SOURCES = [
  path.join(DSH_ROOT, 'settings.yaml'),
]
// 官方 dsh-settings 的 LEGACY_SECTION_ENTRIES：旧 section 名 → 现行 Loader 条目 id。
const LEGACY_SECTION_ENTRIES = {
  'ui-developer-tools': 'ui-settings',
  'ui-onboarding': 'ui-settings-general',
  shell: process.platform === 'win32' ? 'pwsh-sandbox' : 'bash-sandbox',
}
const LEGACY_SETTINGS_BLOCK_BEGIN = '# >>> better-dsh:legacy-settings (generated) >>>'

let yamlModuleLoaded
/**
 * 取 dsh 安装目录内的 YAML 实现（yaml 优先，回退 js-yaml）。
 * 本脚本自身不带依赖，所以从已安装的 dsh 依赖树里按绝对路径加载。
 * @returns 模块对象，或 undefined（两者都不可用）。
 */
function yamlModule() {
  if (yamlModuleLoaded !== undefined) return yamlModuleLoaded
  yamlModuleLoaded = null
  const installRoot = path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh')
  for (const name of ['yaml', 'js-yaml']) {
    const candidate = path.join(installRoot, 'node_modules', name)
    if (!fs.existsSync(path.join(candidate, 'package.json'))) continue
    try {
      const loaded = require(candidate)
      if (typeof loaded.parse === 'function' && typeof loaded.stringify === 'function') {
        yamlModuleLoaded = loaded
        break
      }
    } catch { }
  }
  return yamlModuleLoaded
}

/**
 * 把 settings 文档归一化成「待迁移条目」清单。
 *
 * 两种历史形状都必须认：
 *   - 顶层数组：每项已是一条完整的 Loader 条目 `{ id, name?, config? }`，
 *     条目 id 直接可用，不经 LEGACY_SECTION_ENTRIES 映射；
 *   - 更早的 section 映射：`{ <section>: <values> }`，section 名经
 *     LEGACY_SECTION_ENTRIES 映射成现行条目 id。
 *
 * 只认数组会漏掉映射形状的文件；只认映射则会把数组形状的文件解析成【名为 "0" 的
 * section】并整段丢弃——settings.yaml 里那份 provider（网关）配置会被漏掉，而第 5 步
 * 又已把它从补丁里截掉，于是每次运行都净损失一段设置。
 * @param {unknown} document - YAML 解析结果。
 * @returns {{origin: string, ns: string, name: string | undefined, values: unknown}[]} 归一化条目。
 */
function normalizeLegacySections(document) {
  if (Array.isArray(document)) {
    const items = []
    for (const entry of document) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const ns = typeof entry.id === 'string' ? entry.id : undefined
      if (ns === undefined || ns.length === 0) continue
      items.push({
        origin: ns,
        ns,
        name: typeof entry.name === 'string' ? entry.name : undefined,
        values: entry.config ?? {},
      })
    }
    return items
  }
  if (document === null || typeof document !== 'object') return []
  return Object.entries(document).map(([section, values]) => ({
    origin: section,
    ns: LEGACY_SECTION_ENTRIES[section] ?? section,
    name: undefined,
    values,
  }))
}

/**
 * 读取 settings 迁移源文档。
 *
 * 只认 settings.yaml 本身。`settings.yaml.imported` 是官方 dsh-settings 导入后
 * 留下的归档文件——它记录的是「官方已经处理过、且只处理了一部分」的值，
 * 拿它当迁移源会把已被网页端改过的字段重新写回补丁层，覆盖用户的现行设置。
 * 该文件不存在时，这里返回 undefined，调用方据此跳过整段迁移。
 * @returns {{source: string | undefined, items: unknown[] | undefined}}
 */
function readLegacySettings() {
  const source = LEGACY_SETTINGS_SOURCES.find((file) => fs.existsSync(file))
  if (source === undefined) return { source: undefined, items: undefined }
  const yaml = yamlModule()
  if (yaml === null) {
    console.warn('  [settings] 未找到可用的 YAML 实现（yaml / js-yaml），跳过设置迁移')
    return { source, items: undefined }
  }
  try {
    return { source, items: normalizeLegacySections(yaml.parse(fs.readFileSync(source, 'utf8'))) }
  } catch (error) {
    console.warn(`  [settings] 解析失败 ${source}: ${error.message}`)
    return { source, items: undefined }
  }
}

/**
 * 把补丁正文切成三段：托管区块之前的正文、托管区块之外的顶层条目、现有设置区块原文。
 *
 * 托管区块只包含本脚本生成的顶层条目，边界是确定的：
 *   - 设置区块：`- id: <条目>` 若干条，止于预设标记或文件末尾；
 *   - 预设声明区块：恰好一条 `- insert:`，正文全部缩进，止于下一个顶层行。
 *
 * 为什么必须单独摘出「托管区块之外的顶层条目」：官方设置编辑器
 * （dsh-settings 的 configEditor）把用户条目【追加到文件末尾】，即落在预设标记之后。
 * 若「从第一个托管标记截断到文件末尾」，这些条目会被一并抹掉，重建时又不会写回，
 * 于是每次运行都静默删除一段用户配置。
 * @param {string} content - 补丁正文。
 * @returns {{head: string, foreign: string, legacy: string | undefined}} 三段内容。
 */
function splitManagedRegions(content) {
  const lines = content.split('\n')
  let first = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.startsWith(LEGACY_SETTINGS_BLOCK_BEGIN) || line.startsWith(PRESET_BLOCK_BEGIN)) {
      first = i
      break
    }
  }
  if (first < 0) return { head: content.replace(/\s+$/, ''), foreign: '', legacy: undefined }

  const head = lines.slice(0, first).join('\n').replace(/\s+$/, '')
  const foreign = []
  const legacyLines = []
  let inLegacy = false
  let inPreset = false
  let presetBody = false

  for (let i = first; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.startsWith(LEGACY_SETTINGS_BLOCK_BEGIN)) {
      inLegacy = true
      inPreset = false
      legacyLines.push(line)
      continue
    }
    if (line.startsWith(PRESET_BLOCK_BEGIN)) {
      inLegacy = false
      inPreset = true
      presetBody = false
      continue
    }
    if (inLegacy) {
      legacyLines.push(line)
      continue
    }
    if (inPreset) {
      if (!presetBody) {
        if (/^- /.test(line)) presetBody = true
        continue
      }
      // 正文只含缩进行与空行；出现顶层行即表示预设区块结束，其后一律是外部条目。
      if (/^[^ \t]/.test(line)) {
        inPreset = false
        foreign.push(line)
      }
      continue
    }
    foreign.push(line)
  }

  return {
    head,
    foreign: foreign.join('\n').replace(/^\n+/, '').replace(/\s+$/, ''),
    legacy: legacyLines.length === 0 ? undefined : legacyLines.join('\n').trim(),
  }
}

/**
 * 取目标 profile 当前组合里的 Loader 条目 id 集合（用 dsh 自己的 --dump-config，权威且不启动服务）。
 * @param profileName - profile 名。
 * @returns id 集合，或 undefined（无法获取，调用方应跳过迁移）。
 */
function loadProfileEntryIds(profileName) {
  const installRoot = path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh')
  const entry = path.join(installRoot, 'lib', 'bin.js')
  if (!fs.existsSync(entry)) return undefined
  const result = spawnSync(process.execPath, [entry, '--profile', profileName, '--dump-config'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error !== undefined || typeof result.stdout !== 'string') {
    console.warn(`  [settings] 无法读取 profile「${profileName}」的组合（--dump-config 失败），跳过设置迁移`)
    return undefined
  }
  const ids = new Set()
  for (const line of result.stdout.split('\n')) {
    const match = /^- id: (.+)$/.exec(line)
    if (match !== null) ids.add(match[1].trim())
  }
  return ids.size === 0 ? undefined : ids
}

/** 给多行文本的每个非空行加前缀。 */
const indentBlock = (text, prefix) => text.replace(/^(?!$)/gm, prefix).replace(/\n+$/, '')
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 生成设置迁移区块（含起始标记）。
 * @param patchContent - 已摘除托管区块的补丁正文。
 * @param profileName - 目标 profile 名。
 * @returns 区块文本与三段清单（已迁移 / 跳过 / 丢弃）。
 */
function buildLegacySettingsBlock(patchContent, profileName) {
  const empty = { text: '', imported: [], skipped: [], dropped: [], unavailable: false, noSource: false }
  const legacy = readLegacySettings()
  // 没有 settings.yaml 时不是「没有可迁移项」，而是「本次无从判断」：
  // 返回 noSource，让调用方保留补丁里现有的区块原文，而不是把它当成空区块删掉。
  if (legacy.items === undefined) return { ...empty, noSource: legacy.source === undefined }
  if (legacy.items.length === 0) return empty

  const entryIds = loadProfileEntryIds(profileName)
  // 拿不到条目清单 = 无法判断「profile 里有没有同名条目」，此时重建结果不可信。
  // 显式标记出来，交给调用方决定回填现有区块而不是当成「没有可迁移项」。
  if (entryIds === undefined) return { ...empty, unavailable: true }
  const yaml = yamlModule()

  const rows = []
  const imported = []
  const skipped = []
  const dropped = []
  for (const { origin, ns, name, values } of legacy.items) {
    if (!entryIds.has(ns)) {
      dropped.push(`${origin}（profile「${profileName}」没有同名条目「${ns}」）`)
      continue
    }
    if (new RegExp(`^- id: ${escapeRegExp(ns)}$`, 'm').test(patchContent)) {
      skipped.push(`${origin} → ${ns}（补丁里已有同名条目，保留现状）`)
      continue
    }
    const body = indentBlock(yaml.stringify(values, { lineWidth: 0 }), '    ')
    rows.push(`- id: ${ns}\n${name === undefined ? '' : `  name: ${JSON.stringify(name)}\n`}  config:\n${body}`)
    imported.push(`${origin} → ${ns}`)
  }
  if (rows.length === 0) return { text: '', imported, skipped, dropped }

  const header = [
    LEGACY_SETTINGS_BLOCK_BEGIN,
    `# 由 ~/.dsh/.js 从 ${legacy.source} 迁移而来，请勿手改本段。`,
    '# settings.yaml 不作为生效源：设置一律存在本 profile 补丁里。',
    '# 已在其他位置出现同名条目的 section 不会被覆盖（会打印在运行日志里）。',
  ].join('\n')
  return { text: `${header}\n${rows.join('\n\n')}\n`, imported, skipped, dropped }
}

const presetDeclarationBlock = buildPresetDeclarationsBlock()

// 4. 校验并自动更新 profiles/web/cordis.patch.yml 挂载项与配置（含 3.5 的迁移落地）
if (!fs.existsSync(CORDIS_PATCH_FILE) && fs.existsSync(WEB_PROFILE_DIR)) {
  fs.writeFileSync(CORDIS_PATCH_FILE, '# better-dsh: 本 profile 的用户补丁层（在 bundle 层之后应用；其上的家目录层 ~/.dsh/cordis.patch.yml 会覆盖同 id 条目）。\n[]\n', 'utf8')
  console.log(`[profile] 已创建缺失的用户补丁层: ${CORDIS_PATCH_FILE}`)
}

if (fs.existsSync(CORDIS_PATCH_FILE)) {
  let patchContent = fs.readFileSync(CORDIS_PATCH_FILE, 'utf8')
  // 落盘前的完整性校验要拿「本次运行开始时的条目清单」当基准，因此先留一份原文。
  const originalPatchContent = patchContent

  // 清除空数组占位符与废弃标记
  patchContent = patchContent.replace(/^\s*\[\s*\]\s*$/gm, '').trim()

  const absCreative = pathToFileURL(creativeWorkflowPath).href
  const absReflect = pathToFileURL(reflectCommandPath).href
  const absHotreload = pathToFileURL(hotreloadMeterPath).href
  const absExplore = pathToFileURL(exploreCommandPath).href
  const absGitCommand = pathToFileURL(gitCommandPath).href
  const absInjectCommand = pathToFileURL(injectCommandPath).href
  const absIdleGuard = pathToFileURL(idleGuardPath).href
  const absIdleArm = pathToFileURL(IDLE_ARM_HOST).href
  const absPromptForge = pathToFileURL(PROMPT_FORGE_HOST).href
  const absMsgEdit = pathToFileURL(MSG_EDIT_HOST).href
  const absMdImport = pathToFileURL(MD_IMPORT_HOST).href
  const absRewind = pathToFileURL(REWIND_HOST).href

  // 1. host 层不启用 compaction-basic，并摘除该层残留的启用行。
  //    dsh-web-app bundle 明确把该 host 行置为 disabled，压缩后端整体位于
  //    agent preset：standard 预设在自己的 isolate 组里挂载 compaction-basic /
  //    command-compact / tool-result-pruner。若 host 层再挂一个引擎，由于其 auto 默认为
  //    true（会注册 agent/pre-step 自动压缩），将与预设实例对同一会话重复触发压缩，
  //    抢占会话级压缩锁（busy）并重复消耗摘要 token。
  //    /reflect 的自动压缩不依赖 host 行：它通过 agentPresets.serviceFor(agent, 'compaction')
  //    解析到预设内的压缩实例。
  //    匹配用「行首 + 2 空格缩进」精确锁定顶层条目：文件自带的注释行排在更前面，
  //    所以这一行并不在文件开头；而 insert 列表里的同名条目缩进为 4 空格，不会被误删。
  //    末尾的 \n? 是必需的：这一行可能是文件的最后一行（后面没有换行符）。
  const legacyCompactionPattern = /(^|\n)- id: compaction-basic\n  disabled: false\n?/
  if (legacyCompactionPattern.test(patchContent)) {
    patchContent = patchContent.replace(legacyCompactionPattern, '\n').replace(/\n{3,}/g, '\n\n').trim()
    console.log('  [profile] 已摘除 host 层 compaction-basic 启用行（压缩后端由 agent preset 提供）')
  }

  // 摘除顶层 custom-tools 条目。自定义工具集只在预设自己的声明里出现
  // （见第 5 步前的说明），而顶层条目的注册会落进 dsh-tools 的全局层、被所有预设
  // 继承——正是要避免的形态。顶层的 insert 形如：
  //     - insert:\n    - id: custom-tools\n      name: file:///...
  // 它与预设内那一条的缩进不同（预设内是 10 空格下的 4 空格层级，且带 config），
  // 因此按「顶层 insert + 2 空格 id」这一精确形态整段摘除，不会误伤预设内的声明。
  const legacyToolsMountPattern = /(^|\n)- insert:\n    - id: custom-tools\n      name: [^\n]*\n?/
  if (legacyToolsMountPattern.test(patchContent)) {
    patchContent = patchContent.replace(legacyToolsMountPattern, '\n').replace(/\n{3,}/g, '\n\n').trim()
    console.log('  [profile] 已摘除顶层 custom-tools 挂载（工具集只由各预设按需声明）')
  }

  // 挂载位置：托管区块（设置 / 预设声明）必须固定位于文件末尾，因此新条目
  // 一律插到第一个托管标记之前，绝不能 append 到末尾 —— 第 5 步会从第一个托管标记
  // 处整体截断重建，追加到末尾的新条目会被那一步直接抹掉（表现为新插件静默不生效，
  // 而老插件因为恰好位于标记之前得以幸存）。
  const spliceBeforeManaged = (entry) => {
    const markers = [LEGACY_SETTINGS_BLOCK_BEGIN, PRESET_BLOCK_BEGIN]
      .map((marker) => patchContent.indexOf(marker))
      .filter((index) => index >= 0)
    const at = markers.length > 0 ? Math.min(...markers) : patchContent.length
    const head = patchContent.slice(0, at).replace(/\s+$/, '')
    const tail = patchContent.slice(at)
    return tail.length > 0 ? `${head}\n\n${entry}\n\n${tail}` : `${head}\n\n${entry}`
  }

  // 2. 挂载创作工作流插件
  if (!patchContent.includes('creative-workflow-modes')) {
    patchContent = spliceBeforeManaged(`- insert:\n    - id: creative-workflow-modes\n      name: ${absCreative}`)
  } else {
    patchContent = patchContent.replace(/name:\s*['"]?(\.\/plugins\/creative-workflow\.js|.*creative-workflow\.js)['"]?/, `name: ${absCreative}`)
  }

  // 3. 挂载复盘插件
  if (!patchContent.includes('command-reflect')) {
    patchContent = spliceBeforeManaged(`- insert:\n    - id: command-reflect\n      name: ${absReflect}`)
  } else {
    patchContent = patchContent.replace(/name:\s*['"]?(\.\/plugins\/reflect-command\.js|.*reflect-command\.js)['"]?/, `name: ${absReflect}`)
  }

  // 4. 挂载预设热重载插件
  if (!patchContent.includes('preset-hotreload-and-meter')) {
    patchContent = spliceBeforeManaged(`- insert:\n    - id: preset-hotreload-and-meter\n      name: ${absHotreload}`)
  } else {
    patchContent = patchContent.replace(/name:\s*['"]?(\.\/plugins\/preset-hotreload-and-meter\.js|.*preset-hotreload-and-meter\.js)['"]?/, `name: ${absHotreload}`)
  }

  // 4.5 挂载项目探索插件
  if (!patchContent.includes('command-explore')) {
    patchContent = spliceBeforeManaged(`- insert:\n    - id: command-explore\n      name: ${absExplore}`)
  } else {
    patchContent = patchContent.replace(/name:\s*['"]?(\.\/plugins\/explore-command\.js|.*explore-command\.js)['"]?/, `name: ${absExplore}`)
  }

  // 4.55 挂载 git 命令插件（/git c | p | c&p）。斜杠命令与 agent preset 无关：
  //      任何会话里都由用户手动触发，因此挂在这一层。
  if (!patchContent.includes('command-git')) {
    patchContent = spliceBeforeManaged(`- insert:\n    - id: command-git\n      name: ${absGitCommand}`)
  } else {
    patchContent = patchContent.replace(/name:\s*['"]?(\.\/plugins\/git-command\.js|.*git-command\.js)['"]?/, `name: ${absGitCommand}`)
  }
  // 4.56 挂载文件注入命令插件（/inject <路径>… | /inject off）。同样是斜杠命令：
  //      注入哪些文件属于用户的判断，注入内容会常驻系统提示词并计入上下文压力。
  if (!patchContent.includes('command-inject')) {
    patchContent = spliceBeforeManaged(`- insert:\n    - id: command-inject\n      name: ${absInjectCommand}`)
  } else {
    patchContent = patchContent.replace(/name:\s*['"]?(\.\/plugins\/inject-command\.js|.*inject-command\.js)['"]?/, `name: ${absInjectCommand}`)
  }


  // 4.6 挂载闲置落盘警告插件（全局规则，独立于任何 agent preset）
  if (!patchContent.includes('idle-guard')) {
    patchContent = spliceBeforeManaged(`- insert:\n    - id: idle-guard\n      name: ${absIdleGuard}`)
  } else {
    patchContent = patchContent.replace(/name:\s*['"]?(\.\/plugins\/idle-guard\.js|.*idle-guard\.js)['"]?/, `name: ${absIdleGuard}`)
  }

  // 4.7 挂载 idle-arm 双面插件（宿主半边空转；客户端半边提供提交键旁的按钮）。
  //     name 用 file:// 指向宿主半边：client-modules 的 locatePkgJson 对 path-like
  //     行名走 nearestPackage，会从该文件向上找到 idle-arm/package.json，从而拿到
  //     exports["./client"]。因此行名不必等于包名，包目录位置也不受 node_modules 限制。
  //     幂等判据用条目 id `idle-arm`（不能用包名：插入的是 file:// 路径，不含包名，
  //     会导致每次运行都重复插入一条）。
  if (!patchContent.includes('- id: idle-arm')) {
    patchContent = spliceBeforeManaged(`- insert:\n    - id: idle-arm\n      name: ${absIdleArm}`)
  } else {
    patchContent = patchContent.replace(/(- id: idle-arm\n      name:\s*)['"]?[^'"\n]*['"]?/, `$1${absIdleArm}`)
  }

  // 4.8 挂载 prompt-forge 双面插件（宿主半边注册工具/命令/路由；客户端半边提供
  //     输入框右侧的「改写」按钮与面板）。
  //     与 idle-arm 同一套理由：name 用 file:// 指向宿主半边，client-modules 的
  //     locatePkgJson 对 path-like 行名走 nearestPackage，会从该文件向上找到
  //     prompt-forge/package.json，从而拿到 exports["./client"]。因此行名不必等于
  //     包名，包目录位置也不受 node_modules 限制。
  //     幂等判据用条目 id `prompt-forge`（不能用包名：插入的是 file:// 路径，
  //     不含包名，会导致每次运行都重复插入一条）。
  if (!patchContent.includes('- id: prompt-forge')) {
    patchContent = spliceBeforeManaged(`- insert:\n    - id: prompt-forge\n      name: ${absPromptForge}`)
  } else {
    patchContent = patchContent.replace(/(- id: prompt-forge\n      name:\s*)['"]?[^'"\n]*['"]?/, `$1${absPromptForge}`)
  }

  // 4.9 挂载 msg-edit 双面插件（会话内模型输出的原地编辑）。
  //     行名用 file:// 指向宿主半边，与 idle-arm / prompt-forge 同一套理由：locatePkgJson
  //     对 path-like 行名走 nearestPackage，从 index.js 向上找到 msg-edit/package.json，
  //     拿到 dsh.client 与 exports["./client"]。幂等判据用条目 id `msg-edit`。
  //
  //     与那两个不同的是，这个包**同时是 profile 的 link: 依赖**：宿主半边
  //     `import '@deepseek-ai/dsh-session'`（appendPluginRecord / SessionSeq），而裸
  //     @deepseek-ai 说明符只对「profile 树内」或「linked root 内、且自身 package.json
  //     声明了该 peer」的模块做拦截（dsh-app-boot: findInterceptionLayer / routeLinked）。
  //     所以它不声明 dsh.bundle（不安装、不出现在插件列表），但 package.json 里的那行
  //     link 依赖和 node_modules 里的那条 junction 都不能删；改宿主半边不再有
  //     setBundle 可以触发 reconcile，需要重启 dsh。
  if (!patchContent.includes('- id: msg-edit')) {
    patchContent = spliceBeforeManaged(`- insert:\n    - id: msg-edit\n      name: ${absMsgEdit}`)
  } else {
    patchContent = patchContent.replace(/(- id: msg-edit\n      name:\s*)['"]?[^'"\n]*['"]?/, `$1${absMsgEdit}`)
  }

  // 4.10 挂载 md-session-import 双面插件（md 转录稿 → 新会话）。
  //      宿主半边只 import node:crypto，因此不需要 link:，就是最普通的一行 file:// 插件。
  if (!patchContent.includes('- id: md-session-import')) {
    patchContent = spliceBeforeManaged(`- insert:\n    - id: md-session-import\n      name: ${absMdImport}`)
  } else {
    patchContent = patchContent.replace(/(- id: md-session-import\n      name:\s*)['"]?[^'"\n]*['"]?/, `$1${absMdImport}`)
  }

  // 4.11 挂载 rewind 双面插件（会话回退：退到更早的消息，可选还原工作区文件）。
  //      原先它是 npm 包 dsh-rewind-plugin，靠 dsh.bundle.patch 把自己插进 bundle 层；
  //      现在改为本地手写插件，挂载方式与 msg-edit 完全一致：
  //        · 行名 file:// 指向 lib/index.js，locatePkgJson 对 path-like 行名走
  //          nearestPackage，向上找到 rewind/package.json 拿到 dsh.client 与
  //          exports["./client"]；
  //        · 同时是 profile 的 link: 依赖（宿主半边 import 了 @deepseek-ai/dsh-llm、
  //          dsh-home-paths 与 schemastery，裸说明符靠 linked root 拦截解析）。
  //      幂等判据用条目 id `rewind`。
  if (!patchContent.includes('- id: rewind\n')) {
    patchContent = spliceBeforeManaged(`- insert:\n    - id: rewind\n      name: ${absRewind}`)
  } else {
    patchContent = patchContent.replace(/(- id: rewind\n      name:\s*)['"]?[^'"\n]*['"]?/, `$1${absRewind}`)
  }

  // 注意：自定义工具集**不**在这里挂载。tools.js 只提供实现，一个预设能用哪几个
  // 工具由该预设自己的声明决定（见 buildPresetDeclarationsBlock 里的占位名改写）。
  // 挂成这里的顶层条目会把注册写进 dsh-tools 的全局层，而 ToolRuntime.view() 以
  // 全局层为起点组装可见集，于是**每个**预设都会继承——包括设计上不给命令行的
  // 文学类预设，也会凭空多出 node / delete / browser。官方工具走的正是预设声明
  // 这条路（tool-fs / tool-goal / tool-ask-user 都是逐预设声明的）。

  // 5. 重建托管区块（设置迁移 + 自建预设声明）：两段都固定位于文件末尾，
  //    先按标记整体截断、再按固定顺序重建，因此天然幂等。
  //
  //    注意：截断前必须先留存「现有的设置区块原文」。因为设置区块的重建依赖
  //    `dsh --dump-config`（用于确认 profile 里存在同名条目），而该调用在受限环境下
  //    可能失败（沙箱拒绝子进程、dsh 升级中、profile 损坏等）。一旦失败，
  //    buildLegacySettingsBlock() 会返回空文本——若此时已经把它截掉，这一段设置
  //    （provider 列表、默认模型、主题等）就会从补丁里凭空消失，属于静默数据丢失。
  //    因此失败时原样回填，宁可保留现有内容也不丢。
  //
  //    另一个必须守住的边界：托管区块【只包含本脚本生成的顶层条目】，而官方设置
  //    编辑器会把用户条目追加到文件末尾（即落在预设标记之后）。因此摘除必须按
  //    「区块」边界精确进行，绝不能从第一个标记一路截到文件末尾——那样会把用户
  //    自己写/网页端写入的条目（例如 provider 网关配置）一并删掉，
  //    重建时又不会写回，于是每次运行净损失一段配置。
  const managed = splitManagedRegions(patchContent)
  const existingLegacyBlock = managed.legacy
  const foreignEntries = managed.foreign
  if (managed.legacy !== undefined || managed.foreign.length > 0) {
    console.log('  [managed] 已摘除托管区块（设置 / 预设声明），准备重建')
  }
  patchContent = managed.head
  if (foreignEntries.length > 0) {
    // 托管区块之外的用户条目原样前置保留，绝不被重建吞掉。
    patchContent += `\n\n${foreignEntries}`
    console.log(`  [managed] 保留托管区块之外的用户条目 ${foreignEntries.split('\n').filter((line) => /^- /.test(line)).length} 条`)
  }

  // 5.1 settings.yaml 迁移（详见上方「3.5 settings.yaml 迁移」一节）
  const legacySettings = buildLegacySettingsBlock(patchContent, PROFILE_NAME)
  if (legacySettings.text.length > 0) {
    patchContent += `\n\n${legacySettings.text.trim()}`
    console.log(`  [settings] 已迁移 ${legacySettings.imported.length} 个 section: ${legacySettings.imported.join('、')}`)
  } else if ((legacySettings.unavailable === true || legacySettings.noSource === true) && existingLegacyBlock !== undefined) {
    // 重建不可用（没有 settings.yaml，或 --dump-config 失败），原样回填，绝不让设置凭空消失。
    patchContent += `\n\n${existingLegacyBlock}`
    const why = legacySettings.noSource === true ? '未检测到 settings.yaml' : '--dump-config 不可用'
    console.warn(`  [settings] 跳过设置迁移（${why}），已原样保留现有内容，未做改动`)
  } else if (legacySettings.noSource === true) {
    console.log('  [settings] 未检测到 settings.yaml，跳过设置迁移')
  } else if (legacySettings.unavailable === true) {
    console.warn('  [settings] 无法重建设置区块（--dump-config 不可用），本次不写入该区块')
  } else {
    console.log('  [settings] 无待迁移的 section')
  }
  for (const item of legacySettings.skipped) console.log(`  [settings] 跳过（补丁已有同名条目）: ${item}`)
  for (const item of legacySettings.dropped) console.log(`  [settings] 丢弃（目标 profile 无同名条目，值仍留在 settings.yaml）: ${item}`)

  // 5.2 自建预设声明段
  if (presetDeclarationBlock.text.length > 0) {
    patchContent += `\n\n${presetDeclarationBlock.text.trim()}`
    console.log(`  [presets] 已写入 ${presetDeclarationBlock.count} 个预设声明: ${presetDeclarationBlock.ids.join('、')}`)
  } else {
    console.log('  [presets] 未发现目录预设（~/.dsh/.agent-presets/<id>/agent.cordis.yml），跳过')
  }

  // 落盘前的最后一道闸：任何顶层条目都不允许在重建中凭空消失。
  // 上面每一步都可能因为外部条件（--dump-config 失败、条目被改名、判重写错）漏掉
  // 一段配置，而「少写一行」是不会自己报错的——所以这里把「输入里有的顶层 id」与
  // 「输出里有的顶层 id」对一遍，缺一个就拒绝落盘。宁可这次不更新，也不静默丢配置。
  const topLevelIds = (text) => {
    const ids = new Set()
    for (const line of text.split('\n')) {
      const match = /^- id: (.+)$/.exec(line)
      if (match !== null) ids.add(match[1].trim())
    }
    return ids
  }
  const before = topLevelIds(originalPatchContent)
  const after = topLevelIds(patchContent)
  const lost = [...before].filter((id) => !after.has(id))
  if (lost.length > 0) {
    console.error(`  [profile] 拒绝写入：重建会丢失 ${lost.length} 个顶层条目（${lost.join('、')}）`)
    console.error('  [profile] 补丁文件保持原样未改动；这是脚本缺陷，请勿手工绕过。')
    process.exitCode = 1
  } else {
    fs.writeFileSync(CORDIS_PATCH_FILE, patchContent.trim() + '\n', 'utf8')
    console.log(`[profile] 已更新 ${CORDIS_PATCH_FILE}（挂载自定义插件 + 重建预设声明）`)
  }
}

// 5. 底层增强补丁全量应用（内嵌幂等执行，无需外置脚本）：
//    - preset-switch：解除非空白会话锁定，会话头部标签升级为可交互下拉菜单；
//    - compaction：压缩阈值改按 surface 计价，压缩指令忽略规则库。
console.log('[installer] 正在执行底层核心补丁全量注入...')

function applyCorePatches(baseDir) {
  if (!fs.existsSync(baseDir)) return

  // dsh 的 bundle 一律以 LF 发布，而本脚本在 Windows 检出后自身是 CRLF：凡是用
  // 多行模板字面量写成的锚点（4.2 的会话头部槽位就是唯一一处）都会带上 \r\n，
  // 与 LF 的目标文件永不相等，补丁于是「静默降级」——只打印一句跳过告警，
  // 界面缺了一块却仍报部署成功。读取时统一归一化为 LF，使补丁结果与检出方式无关。
  const readTargetCode = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

  // 4.1 preset-switch: 后端 agent 预设注册表解除非空白会话限制
  //     目标包是 dsh-agent-preset-registry（提供 `agentPresets` 服务）；
  //     声明插件是 dsh-agent-preset。
  //     补丁目标的 select() 位于 dsh-agent-preset-registry/lib/index.js。
  //     0.2.2-rc.1 把边界改由 `this.owner.agents.turnBoundaryOf(agent.session)` 读取，
  //     判断形式为 `if (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0) throw ...`；
  //     内层子串替换仍然成立（只移除 lastTurn > 0，保留未闭合回合硬锁）。
  const agentPresetsFile = path.join(baseDir, 'node_modules', '@deepseek-ai', 'dsh-agent-preset-registry', 'lib', 'index.js')
  if (fs.existsSync(agentPresetsFile)) {
    let fileCode = readTargetCode(agentPresetsFile)
    const target = 'boundary.openTurnStartSeq !== null || boundary.lastTurn > 0'
    const rep = 'boundary.openTurnStartSeq !== null'
    if (fileCode.includes(target)) {
      fileCode = fileCode.replace(target, rep)
      try {
        fs.writeFileSync(agentPresetsFile, fileCode, 'utf8')
        console.log('  [patch] dsh-agent-preset-registry: 已解除非空白会话锁定（空闲时可随时切换预设）')
      } catch (err) {
        console.warn(`  [patch] dsh-agent-preset-registry: 写入受权限保护，跳过文件覆盖 (${err.message})`)
      }
    } else if (fileCode.includes(rep)) {
      console.log('  [patch] dsh-agent-preset-registry: 已处于预设解锁状态')
    }
  }

  // 4.2 preset-switch: 前端 dsh-client-ui-agent-preset 解锁 apply 并将头部升级为下拉交互组件
  const uiAgentPresetFile = path.join(baseDir, 'node_modules', '@deepseek-ai', 'dsh-client-ui-agent-preset', 'lib', 'client.js')
  if (fs.existsSync(uiAgentPresetFile)) {
    let fileCode = readTargetCode(uiAgentPresetFile)
    let uiChanged = false

    const applyTarget = 'if (!session.blank || presetOf(session) === staged)'
    const applyRep = 'if (presetOf(session) === staged)'
    if (fileCode.includes(applyTarget)) {
      fileCode = fileCode.replace(applyTarget, applyRep)
      uiChanged = true
      console.log('  [patch] dsh-client-ui-agent-preset: 已解除前端切换预设对 session.blank 的限制')
    }

    const slotTarget = `const label = scope.slots.register({
						name: "conversation.session.header.actions",
						id: "agent-preset",
						order: -10,
						locale: "settings.agentPreset",
						inject: labelInjected
					}, AgentPresetLabel);`
    // AgentPresetLabel 被刻意设计为只读（其源码注释：会话一旦开始，组成即固定），
    // 交互面位于新会话首屏的 conversation.hero.agentPreset 插槽。这里把
    // 二者合进会话头部：闸门条件与 AgentPresetSeat 内部的渲染门完全一致，
    // 保证「渲染下拉」与「回退只读标签」互斥且不留空白：
    //   1. developerTools —— hooks.developerTools，值取自
    //      ctx.configForms.developerTools.enabled（设置 → 通用 → 开发者工具）；
    //   2. seatReady —— hooks.agentPresetSeat，要求花名册非空且当前预设已确定
    //      （options.length > 0 && current !== ""，即 Seat 内部的 `ready`）；
    //   3. mainView —— 键控 hook sessionRetainInfo（由 dsh-client-ui-session 提供），
    //      要求该会话仍在当前主视图保留。
    // 三者全真 → 渲染可交互下拉（AgentPresetSeat）；任一为假 → 回退为原只读标签
    // （AgentPresetLabel），避免头部标签整体消失。
    // 插槽 inject 对 session 作用域插槽的签名是 (sessionId) —— 若以零参调用
    // seatInjected() 会落到不绑定任何会话的 unboundSeat（选择只暂存给下一个新会话，
    // 不作用于当前会话），故此处必须把 sessionId 透传进去。
    const slotRep = `const label = scope.slots.register({
						name: "conversation.session.header.actions",
						id: "agent-preset",
						order: -10,
						locale: "settings.agentPreset",
						inject: (sessionId) => {
							const labelProps = labelInjected();
							const seatProps = seatInjected(sessionId);
							return {
								...labelProps,
								...seatProps,
								hooks: {
									...labelProps.hooks,
									...seatProps.hooks
								},
								load: () => Promise.all([labelProps.load === void 0 ? void 0 : labelProps.load(), seatProps.load === void 0 ? void 0 : seatProps.load()])
							};
						}
					}, function AgentPresetHeaderSeat(props) {
						const developerTools = props.useDeveloperTools === void 0 ? false : props.useDeveloperTools((value) => value === true);
						const seatReady = props.useAgentPresetSeat === void 0 ? false : props.useAgentPresetSeat((snapshot) => snapshot.options.length > 0 && snapshot.current !== "");
						const mainView = props.useSessionRetainInfo === void 0 ? true : props.useSessionRetainInfo((info) => props.sessionId === void 0 || (info === null || info === void 0 ? void 0 : info.retainedBy.mainView ?? 0) > 0);
						if (!developerTools || !seatReady || !mainView) return (0, react_jsx_runtime.jsx)(AgentPresetLabel, props);
						return (0, react_jsx_runtime.jsx)(AgentPresetSeat, props);
					});`

    // 多行锚点与替换体都要先归一化为 LF：它们写作模板字面量，行尾跟着载体文件走，
    // 在 CRLF 检出下会带 \r\n，而目标 bundle 是 LF（readTargetCode 已把目标侧归一化）。
    const slotTargetLf = slotTarget.replace(/\r\n/g, '\n')
    const slotRepLf = slotRep.replace(/\r\n/g, '\n')

    const headerSeatApplied = fileCode.includes('AgentPresetHeaderSeat')
    if (fileCode.includes(slotTargetLf)) {
      fileCode = fileCode.replace(slotTargetLf, slotRepLf)
      uiChanged = true
      console.log('  [patch] dsh-client-ui-agent-preset: 会话头部已注入预设下拉（闸门未开时自动回退为只读标签，不残留空白）')
    } else if (!headerSeatApplied) {
      console.warn('  [patch] dsh-client-ui-agent-preset: 未匹配到会话头部槽位注册代码，已跳过下拉注入（仅应用空白会话解锁）')
    }

    if (uiChanged) {
      try {
        fs.writeFileSync(uiAgentPresetFile, fileCode, 'utf8')
      } catch (err) {
        console.warn(`  [patch] dsh-client-ui-agent-preset: 写入受权限保护，跳过文件覆盖 (${err.message})`)
      }
    } else {
      console.log('  [patch] dsh-client-ui-agent-preset: 无待写入变更（已处于目标状态或已跳过）')
    }
  }

  // 4.3 compaction: 压缩阈值改按 surface 计价 + 压缩提示词忽略规则库
  //     tokenMeter.measure() 的返回形态为
  //     { logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes }：
  //       totalTokens   = provider usage 锚定的「真实请求规模」（含工具 schema）
  //       surfaceTokens = 当前 surface（system/message + 会话消息）的启发式计价
  //     两者之差因此是「工具 schema（estimateToolsTokens）+ provider 用量漂移」；
  //     系统提示词已经作为 system/message 节点计入 surfaceTokens，所以本补丁的实际语义
  //     是「忽略工具 schema 对压缩阈值的压力」，而非「剥离系统提示词压力」。
  //     该形态在 0.2.2-rc.1 复核未变；compaction-basic 里的三处判断
  //     （两处 return null、一处 return result）仍是原文，补丁锚点全部命中。
  //     0.2.2 新增的「切换模型前按目标 header 预压缩」路径复用同一组判断，
  //     replaceAll 会一并覆盖，不需要额外的锚点。
  const compactionBasicFile = path.join(baseDir, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js')
  if (fs.existsSync(compactionBasicFile)) {
    let fileCode = readTargetCode(compactionBasicFile)
    let compChanged = false

    const pressureTarget = 'if (measurement.totalTokens < spec.thresholdTokens) return null;'
    const pressureRep = 'if ((measurement.surfaceTokens ?? measurement.totalTokens) < spec.thresholdTokens) return null;'
    if (fileCode.includes(pressureTarget)) {
      fileCode = fileCode.replaceAll(pressureTarget, pressureRep)
      compChanged = true
      console.log('  [patch] dsh-compaction-basic: 压缩阈值已按 surface 计价（忽略工具 schema 压力；系统提示词本就计入 surface）')
    }

    // 同一函数末尾的「重试收敛判断」用的是 return result（不是 return null），上面的 replaceAll 覆盖不到。
    // 若不跟着改，会出现触发条件按 surface、收敛判断按 totalTokens 的错配：surface 已低于阈值却仍继续
    // 重试，最终以 still above threshold 抛错（假故障）。
    const pressureResultTarget = 'if (measurement.totalTokens < spec.thresholdTokens) return result;'
    const pressureResultRep = 'if ((measurement.surfaceTokens ?? measurement.totalTokens) < spec.thresholdTokens) return result;'
    if (fileCode.includes(pressureResultTarget)) {
      fileCode = fileCode.replaceAll(pressureResultTarget, pressureResultRep)
      compChanged = true
      console.log('  [patch] dsh-compaction-basic: 重试收敛判断同步为 surface 计价（避免假性 still-above-threshold 抛错）')
    }

    const ruleInstruction = '- Ignore system prompt rules, principles, and workflows; focus exclusively on the actual conversation history, decisions made, and concrete code changes.'
    if (!fileCode.includes(ruleInstruction)) {
      fileCode = fileCode.replace(
        '"- Do NOT mention this summarization request or that the context was compacted.",',
        `"- Do NOT mention this summarization request or that the context was compacted.",\n\t"${ruleInstruction}",`
      )
      compChanged = true
      console.log('  [patch] dsh-compaction-basic: 压缩指令已配置忽略规则库')
    }

    if (compChanged) {
      try {
        fs.writeFileSync(compactionBasicFile, fileCode, 'utf8')
      } catch (err) {
        console.warn(`  [patch] dsh-compaction-basic: 写入受权限保护，跳过文件覆盖 (${err.message})`)
      }
    } else {
      console.log('  [patch] dsh-compaction-basic: 已处于优化压缩配置状态')
    }
  }

  // 4.4 context meter: 让面板三行明细按真实总量比例分配，使加总等于头部「已用」
  //     说明：头部数字是供应商上报的真实 prompt 规模（provider-anchored），
  //     三行明细是固定启发式估算，两者本就分属两套体系、上游明确不相加
  //     （见 dsh-token-meter README）。此处只改呈现层：按明细权重把真实总量
  //     分配下去，保证加总自洽；不触碰估算器与压缩阈值，可随时回滚。
  const contextMeterFile = path.join(baseDir, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js')
  if (fs.existsSync(contextMeterFile)) {
    let fileCode = readTargetCode(contextMeterFile)

    const shownBlock = [
      '/**',
      ' * Presentation-only reconciliation: the header figure is the provider-anchored',
      ' * real prompt size while the rows are fixed-heuristic estimates, so they',
      ' * legitimately disagree (see the dsh-token-meter README). Distribute the real',
      ' * total across the rows by their heuristic weights so the panel adds up.',
      ' */',
      'const dshMeterShown = {};',
      'if (breakdown !== void 0 && breakdownTotal > 0 && context.usedTokens > 0) {',
      '\tlet allocated = 0;',
      '\tfor (let rowIndex = 0; rowIndex < ROWS.length; rowIndex += 1) {',
      '\t\tconst rowKey = ROWS[rowIndex].key;',
      '\t\tconst rowValue = rowIndex === ROWS.length - 1',
      '\t\t\t? Math.max(0, context.usedTokens - allocated)',
      '\t\t\t: Math.round(context.usedTokens * breakdown[rowKey] / breakdownTotal);',
      '\t\tdshMeterShown[rowKey] = rowValue;',
      '\t\tallocated += rowValue;',
      '\t}',
      '}',
    ].map((line) => '\t\t\t' + line).join('\n')

    const totalAnchor = 'const breakdownTotal = breakdown === void 0 ? 0 : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens;'
    const ddAnchor = 'children: `~${formatTokens(breakdown[row.key], t)}`'
    const ddRep = 'children: `~${formatTokens(dshMeterShown[row.key] ?? breakdown[row.key], t)}`'

    // 幂等哨兵使用注入代码独有的标识符：早期版本用 'const shown = {};' 这种通用字符串判断，
    // 一旦该串在本 bundle 的其它区域出现，补丁会被误判为「已应用」而静默跳过。
    const alreadyApplied = fileCode.includes('const dshMeterShown = {};') || fileCode.includes('formatTokens(shown[row.key]')
    if (!alreadyApplied) {
      if (fileCode.includes(totalAnchor) && fileCode.includes(ddAnchor)) {
        fileCode = fileCode.replace(totalAnchor, totalAnchor + '\n' + shownBlock)
        fileCode = fileCode.replace(ddAnchor, ddRep)
        try {
          fs.writeFileSync(contextMeterFile, fileCode, 'utf8')
          console.log('  [patch] dsh-client-ui-conversation: 上下文面板明细已按真实总量比例分配（加总对齐头部）')
        } catch (err) {
          console.warn(`  [patch] dsh-client-ui-conversation: 写入受权限保护，跳过文件覆盖 (${err.message})`)
        }
      } else {
        console.log('  [patch] dsh-client-ui-conversation: 未匹配到 ContextMeter 目标代码，跳过')
      }
    } else {
      console.log('  [patch] dsh-client-ui-conversation: 已处于明细比例分配状态')
    }
  }
}

// 遍历全局与 profile 级 dsh 模块应用底层补丁
const globalDshPath = path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh')
applyCorePatches(globalDshPath)

const profileNodeModules = path.join(DSH_ROOT, 'profiles')
if (fs.existsSync(path.join(profileNodeModules, 'node_modules', '@deepseek-ai', 'dsh-agent-preset-registry'))) {
  applyCorePatches(profileNodeModules)
}

// 6. 工作区与会话完整性校验与自动归纳（全内嵌自愈，无需外置脚本）
function syncWorkspaces(dshRoot, force = false) {
  const nodeZlib = require('node:zlib')
  const nodeCrypto = require('node:crypto')
  const sessionsDir = path.join(dshRoot, 'sessions')
  const storagesDir = path.join(dshRoot, 'storages')
  const wsFile = path.join(storagesDir, 'workspace.json')

  if (!fs.existsSync(sessionsDir)) return

  let existingState = { workspaceIds: [], tables: { workspaces: {} } }
  let needRepair = force

  if (!fs.existsSync(wsFile)) {
    needRepair = true
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(wsFile, 'utf8'))
      if (!parsed.tables?.workspaces || Object.keys(parsed.tables.workspaces).length === 0) {
        needRepair = true
      } else {
        existingState = parsed
      }
    } catch {
      needRepair = true
    }
  }

  const projectDirs = fs.readdirSync(sessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  const headers = []
  const scannedSessionIds = new Set()

  // 会话日志按「代」存储：第 0 代是 `session.jsonl`，其后每一代在 `.jsonl` 前带
  // `.vN`（见 dsh-session-format 的 CANONICAL_LOG_FILENAME），压缩后追加 `.zstd`。
  // 活跃会话大量落在 v3/v4：只认 `session.jsonl(.zstd)` 的扫描会整片
  // 漏掉新代日志；而下面的重建只写回「扫描到的」会话，于是这些会话连同账目一起
  // 消失，侧栏显示为「未分组」。因此扫描必须覆盖全部代。
  // 同一目录多代并存时取版本最高的一代；`.bak`/临时文件
  // 不匹配该模式，天然被排除，避免读到过期的头。
  // 版本号与 dsh 的规范正则完全一致：`v` 后必须是 ≥1 的十进制数且无前导零
  // （`session.v0.jsonl` / `session.v01.jsonl` 不是合法文件名，dsh 也不会生成）。
  const SESSION_LOG_PATTERN = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/

  for (const proj of projectDirs) {
    const projDir = path.join(sessionsDir, proj)
    const sessDirs = fs.readdirSync(projDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)

    for (const sess of sessDirs) {
      const sessDir = path.join(projDir, sess)
      const generations = []
      for (const f of fs.readdirSync(sessDir)) {
        const match = SESSION_LOG_PATTERN.exec(f)
        if (match === null) continue
        generations.push({ file: f, version: match[1] === undefined ? 0 : Number(match[1]) })
      }
      generations.sort((left, right) => right.version - left.version)

      for (const generation of generations) {
        let firstLine
        try {
          const target = path.join(sessDir, generation.file)
          firstLine = generation.file.endsWith('.zstd')
            ? nodeZlib.zstdDecompressSync(fs.readFileSync(target)).toString('utf8').split('\n')[0]
            : fs.readFileSync(target, 'utf8').split('\n')[0]
        } catch {
          continue
        }
        if (!firstLine) continue

        try {
          const meta = JSON.parse(firstLine)
          if (meta && meta.type === 'session' && meta.id) {
            if (!scannedSessionIds.has(meta.id)) {
              scannedSessionIds.add(meta.id)
              headers.push(meta)
            }
            break
          }
        } catch { }
      }
    }
  }

  const existingAccounted = new Set()
  // sessionId -> 现有归属路径。已入册的会话必须沿用这条路径，而不是重新按 cwd 解析：
  // 当会话的工作目录暂时不可解析（离线盘、目录已删）时，官方实现只是把它从
  // workspace.sessionIds 的视图里过滤掉（dsh-workspace 的 `get sessionIds()` 会比对
  // sessionPath(id) 与 record.path），durable 记录仍然保留该 id；若脚本重建时丢弃它，
  // 分组链接就永久丢失了（盘符恢复后也不会自动回来）。
  // 同一会话被多条记录登记时（例如项目目录迁移后的重新归属），取 updatedAt 最新的一条。
  const existingPathBySessionId = new Map()
  const existingStampBySessionId = new Map()
  if (existingState.tables?.workspaces) {
    for (const w of Object.values(existingState.tables.workspaces)) {
      if (!Array.isArray(w.sessionIds)) continue
      const stamp = typeof w.updatedAt === 'string' ? w.updatedAt : ''
      for (const sid of w.sessionIds) {
        existingAccounted.add(sid)
        if (typeof w.path !== 'string' || w.path.length === 0) continue
        const seen = existingStampBySessionId.get(sid)
        if (seen !== undefined && seen >= stamp) continue
        existingPathBySessionId.set(sid, w.path)
        existingStampBySessionId.set(sid, stamp)
      }
    }
  }

  // 「待归类」只统计有资格入组的会话：cwd 不可解析的会话（离线盘、目录已删）永远
  // 无法建立归属，若把它们也算作待修，脚本每次运行都会无谓地重写整个注册表。
  const isResolvableCwd = (cwd) => {
    if (typeof cwd !== 'string' || cwd.length === 0) return false
    try {
      return fs.statSync(fs.realpathSync(cwd)).isDirectory()
    } catch {
      return false
    }
  }

  const unaccounted = headers.filter((h) => !existingAccounted.has(h.id) && isResolvableCwd(h.cwd))
  if (unaccounted.length > 0) {
    needRepair = true
  }

  if (!needRepair) {
    console.log(`[workspace] 工作区注册表状态正常（已收纳 ${Object.keys(existingState.tables.workspaces).length} 个工作区，${existingAccounted.size} 个会话）`)
    return
  }

  console.log(`[workspace] 检测到 ${unaccounted.length} 个未归类会话或配置需更新，正在自动重构工作区归属...`)

  const sessionPaths = new Map()
  const unresolvedSessionIds = []
  for (const header of headers) {
    // 1) 已入册会话：沿用现有归属路径，绝不因为 cwd 暂时不可解析而丢组。
    const owned = existingPathBySessionId.get(header.id)
    if (owned !== undefined) {
      sessionPaths.set(header.id, owned)
      continue
    }
    if (!header.cwd) {
      unresolvedSessionIds.push(header.id)
      continue
    }
    // 2) 新会话：cwd 必须能解析出真实目录才建立归属，与 dsh-workspace 的 attachSession
    //    校验保持一致（record.path 必须是 fs.realpath 的规范形式）。此处不做「原始路径补位」：
    //    写出一条永远匹配不上的非规范路径，只会留下一个空的僵尸工作区。
    try {
      const real = fs.realpathSync(header.cwd)
      if (fs.statSync(real).isDirectory()) {
        sessionPaths.set(header.id, real)
        continue
      }
    } catch { }
    unresolvedSessionIds.push(header.id)
  }
  if (unresolvedSessionIds.length > 0) {
    console.log(`[workspace] 另有 ${unresolvedSessionIds.length} 个未入册会话的 cwd 当前不可解析（离线盘或目录已删），本次保持未分组：${unresolvedSessionIds.slice(0, 5).join('、')}${unresolvedSessionIds.length > 5 ? ' …' : ''}`)
  }

  const compareHeaders = (left, right) =>
    right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id))

  const groupsByPath = new Map()
  for (const header of headers) {
    const p = sessionPaths.get(header.id)
    if (p === undefined) continue
    let group = groupsByPath.get(p)
    if (group === undefined) {
      group = []
      groupsByPath.set(p, group)
    }
    group.push(header)
  }

  const groups = [...groupsByPath].map(([p, groupHeaders]) => {
    groupHeaders.sort(compareHeaders)
    return {
      path: p,
      headers: groupHeaders,
      newestAt: groupHeaders[0].createdAt,
    }
  }).sort((left, right) => right.newestAt - left.newestAt || left.path.localeCompare(right.path))

  const existingByPath = new Map()
  if (existingState.tables?.workspaces) {
    for (const [id, rec] of Object.entries(existingState.tables.workspaces)) {
      if (rec?.path) {
        existingByPath.set(rec.path, { id, title: rec.title, createdAt: rec.createdAt })
      }
    }
  }

  const tables = { workspaces: {} }
  const accounted = new Map()

  for (const group of groups) {
    const sessionIds = group.headers.map((h) => h.id).filter((id) => !accounted.has(id))
    if (sessionIds.length === 0) continue

    const existing = existingByPath.get(group.path)
    const id = existing ? existing.id : nodeCrypto.randomUUID()
    const createdAt = existing ? existing.createdAt : new Date(group.newestAt).toISOString()
    const title = existing?.title || path.basename(group.path)

    const record = {
      path: group.path,
      title,
      sessionIds,
      createdAt,
      updatedAt: new Date(group.newestAt).toISOString(),
    }

    tables.workspaces[id] = record
    for (const sid of sessionIds) accounted.set(sid, id)
  }

  // 兜底：旧账里「本次没能入组」的会话 id 必须原样保留，绝不因为重建而消失。
  // 两种来源：扫描不到的会话目录（新代日志、文件名未预期、文件暂不可读），
  // 以及扫描到但 cwd 不可解析的已入册会话（离线盘、目录已删）。
  // 官方记录同样保留这些槽位——视图会按 sessionPath 过滤掉它们，但账目本身不动；
  // 一旦在这里丢弃，归属链接就永久断了（新代日志被漏扫时的事故正是如此）。
  // 原工作区记录（路径、标题、时间戳）一并保留，并且必须进入 workspaceIds：
  // dsh-workspace 的 validateStoredState() 要求顺序表与表项严格一一对应。
  let preservedAccounts = 0
  if (existingState.tables?.workspaces) {
    for (const [workspaceId, previous] of Object.entries(existingState.tables.workspaces)) {
      const orphans = (previous?.sessionIds || []).filter((sid) => !accounted.has(sid))
      if (orphans.length === 0) continue
      preservedAccounts += orphans.length

      const placed = tables.workspaces[workspaceId]
      if (placed !== undefined) {
        for (const sid of orphans) {
          if (placed.sessionIds.includes(sid)) continue
          placed.sessionIds.push(sid)
          accounted.set(sid, workspaceId)
        }
        continue
      }
      tables.workspaces[workspaceId] = {
        path: previous.path,
        title: previous.title || path.basename(previous.path),
        sessionIds: orphans,
        createdAt: previous.createdAt,
        updatedAt: previous.updatedAt || previous.createdAt,
      }
      for (const sid of orphans) accounted.set(sid, workspaceId)
    }
  }
  if (preservedAccounts > 0) {
    console.log(`[workspace] 另有 ${preservedAccounts} 个会话本次未能入组（日志缺失/不可读或 cwd 不可解析），已按原归属保留账目，未从注册表中删除`)
  }

  const groupRank = new Map(groups.map((g) => [g.path, g.newestAt]))
  const priorRank = new Map(
    (existingState.global?.workspaceIds || []).map((id, index) => [id, index])
  )

  const workspaceIds = Object.entries(tables.workspaces).sort(([leftId, left], [rightId, right]) => {
    const leftTime = groupRank.get(left.path) ?? Date.parse(left.createdAt)
    const rightTime = groupRank.get(right.path) ?? Date.parse(right.createdAt)
    return (
      rightTime - leftTime ||
      (priorRank.get(leftId) ?? Number.MAX_SAFE_INTEGER) - (priorRank.get(rightId) ?? Number.MAX_SAFE_INTEGER) ||
      String(leftId).localeCompare(String(rightId))
    )
  }).map(([id]) => id)

  // pendingMutation 是「表/顺序写入被中断」的可恢复标记，官方恢复逻辑
  // （dsh-workspace 的 recoverPendingMutation）只有两种走向：标记里的 workspaceId 仍在顺序表里
  // 就**抛错让启动失败**，否则把该工作区从表里删掉。本次重建已按会话头从头推导出
  // 自洽的「表 + 顺序」，保留这个陈旧标记只会有害（最坏情况直接起不来），因此显式丢弃并告警。
  if (existingState.global?.pendingMutation !== undefined) {
    console.warn('[workspace] 检测到中断写入标记 pendingMutation，已在重建后的自洽状态中丢弃；若侧栏分组异常请手动核对。')
  }

  // global 是官方 schema 的五个字段，重建时必须逐个交代，否则静默丢数据：
  //   initialized / workspaceIds —— 本次重建推导
  //   archivedSessionIds —— 原样透传（归档是用户意图，与本次扫描结果无关）
  //   defaultWorkspaceId —— 官方注释「首次使用的 Workspace 身份，注册被删除后仍然保留」，
  //     因此无条件透传；丢了它等于抹掉「首次使用」这一事实。
  //   pinnedSessionIds —— 官方在会话删除时会同步摘除对应钉子，所以这里也按「会话是否
  //     仍然存在」过滤：判据取「本次重建后仍有归属」或「本次扫描到了头」，前者覆盖
  //     cwd 不可解析但账目被保留的会话，后者覆盖扫描到却未能入组的会话。
  //     validateStoredState() 不校验这两个字段，丢了不会报错——正是静默丢失的典型。
  const priorGlobal = existingState.global || {}
  const pinnedSessionIds = (priorGlobal.pinnedSessionIds || [])
    .filter((id) => accounted.has(id) || scannedSessionIds.has(id))
  if (pinnedSessionIds.length !== (priorGlobal.pinnedSessionIds || []).length) {
    console.log(`[workspace] 钉选会话已按现存会话收敛：${(priorGlobal.pinnedSessionIds || []).length} → ${pinnedSessionIds.length}`)
  }

  const document = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      ...(priorGlobal.defaultWorkspaceId !== undefined ? { defaultWorkspaceId: priorGlobal.defaultWorkspaceId } : {}),
      workspaceIds,
      archivedSessionIds: priorGlobal.archivedSessionIds || [],
      pinnedSessionIds,
    },
    tables,
  }

  if (!fs.existsSync(storagesDir)) {
    fs.mkdirSync(storagesDir, { recursive: true })
  }

  const tmpFile = path.join(storagesDir, `.${nodeCrypto.randomUUID()}.tmp`)
  fs.writeFileSync(tmpFile, JSON.stringify(document, null, 2) + '\n', 'utf8')
  fs.renameSync(tmpFile, wsFile)
  console.log(`[workspace] 工作区归纳完成：注册表共 ${accounted.size} 个会话归属到 ${workspaceIds.length} 个工作区（其中 ${preservedAccounts} 个为沿用旧账、本次未重新定位的会话）`)
}

syncWorkspaces(DSH_ROOT, process.argv.includes('--repair-workspaces') || process.argv.includes('-r'))

console.log('=============================================================')
if (process.exitCode !== undefined && process.exitCode !== 0) {
  console.error(`⚠️  部署未完成：上面有 ${process.exitCode} 号退出码对应的错误，请先处理后再重跑。`)
} else {
  console.log('🎉 恭喜！DSH 全套改进（插件/配置/底层补丁）已全量部署成功！')
}
console.log('=============================================================')