'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// DSH 全量独立部署与维护脚本
//
// 用法：
//   node .js            进入维护台菜单：1 管理会话 / 2 应用补丁 / q 退出
//   node .js --apply    直接执行全部补丁（等价旧版行为，便于脚本化）
//   node .js --list     非交互列出工作区目录（目录名反解为可读路径）
//   node .js --list <目录名|路径片段|序号>   列出该目录下的会话（含标题）
//
// 核心功能：
//   本脚本是 DSH 功能增强与自定义插件生态的「一键生成与维护总入口」。
//   在任何时候运行（`node .js`），会自动全量构建并注入全部改进：
//
//   0. 基线版本：本脚本按 dsh 0.2.1-alpha.4 的结构维护。
//      版本沿革、历次迁移的核对结论与已执行的迁移动作，全部记录在同目录的
//      `CHANGE.md` 里；本头部只描述当前行为，不再复述历史。
//      当前基线下与旧版最关键的一处差异：Agent 的公开生命周期面已收敛，
//      `agent.phase` 不再是公开 API（公开面为 `agent.status` 与 `agent.whenIdle()`），
//      脚本内两处相位判断已按此迁移。
//
//   1. 插件自动创建与落地（直接写在 `~/.dsh/plugins/` 下，不再套一层 custom/）：
//      - 自动生成 `~/.dsh/plugins/reflect-command.js`
//        （/reflect：自省会话复盘工程经验与偏好，沉淀为 Skill，并自动联动执行会话压缩）
//      - 自动生成 `~/.dsh/plugins/creative-workflow.js`
//        （创作工作流模式插件：动态从工作区装配准则与模式提示词）
//      - 自动生成 `~/.dsh/plugins/preset-hotreload-and-meter.js`
//        （预设声明更新后把已运行会话重绑到新修订；上下文明细投影矫正部分已移除，见插件内注释）
//      - 自动生成 `~/.dsh/plugins/explore-command.js`
//        （/explore：全面探索工作区项目的架构与实现，产出一份完善的 PROJECT.md）
//
//   2. 自建预设迁移与落地：
//      扫描 `~/.dsh/.agent-presets/<id>/`，把每个目录转成一条
//      `@deepseek-ai/dsh-agent-preset` 声明行（id 取目录名，name/description/order 取
//      preset.yml，plugins 为 agent.cordis.yml 的原样内联）；相对资源复制到
//      `profiles/web/preset-assets/<id>/` 并改写引用。声明段以固定标记整段重建，幂等。
//
//   3. 旧版 settings.yaml 迁移：
//      `~/.dsh/settings.yaml` 不再是生效源（dsh 只在启动时一次性导入，且只接受
//      volatile 字段）；本脚本用同一套旧名映射把「有同名条目」的 section 直接写进
//      profile patch（静态 config 不受 volatile 限制，覆盖面更全）。补丁里已有同名
//      条目的 section 一律跳过，不覆盖网页端的修改。
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
//      - compaction：压缩阈值改按 surface 计价，并让压缩指令忽略规则库与工作流。
//        compact 后端已下沉到 agent preset，因此脚本不在 host 层强制启用
//        compaction-basic，并会自动清理旧版本注入的那一行。
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
 * 每一代日志都要调用：低代是迁移前的残留，但官方按「版本最高的一代」取用，
 * 而校验路径时会比对 header.cwd，所以哪一代留了旧 cwd，哪一代就会成为隐患。
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
 * 这里改成先入队、按需取出，EOF 时以 undefined 表示结束。
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
// 内嵌资源 A：creative-workflow.js
// ─────────────────────────────────────────────────────────────────────────────
const CREATIVE_WORKFLOW_CODE = `'use strict'

// 创作工作流模式插件（宿主级持久插件）
module.exports = {
  name: 'creative-workflow-modes',
  inject: ['commands', 'systemPrompt'],

  apply(ctx) {
    const PRINCIPLE_FILE = 'principle.md'
    // scope：本模式允许读取与修改的路径，相对会话工作区。
    // 以 '/' 结尾的项匹配整棵子树，其余要求路径完全相等。
    const MODES = {
      research_mode: { label: '源研模式', workflow: 'workflows/research_mode.md', scope: ['正文/', '设定/', '设定台账.md'] },
      plan_mode: { label: '筹划模式', workflow: 'workflows/plan_mode.md', scope: ['正文/', '设定/', '设定台账.md', 'creative_requirements.md', 'implementation_plan.md'] },
      creative_mode: { label: '创作模式', workflow: 'workflows/creative_mode.md', scope: ['正文/', '设定台账.md', 'implementation_plan.md'] },
      polish_mode: { label: '润色模式', workflow: 'workflows/polish_mode.md', scope: ['正文/', '设定台账.md'] },
    }
    const SECTION_NAME = 'creative-workflow:rules'
    // 携带文件路径参数的工具 → 参数名。未列出的工具不触碰文件，不受范围限制。
    const PATH_ARGUMENTS = {
      read: 'file_path',
      write: 'file_path',
      edit: 'file_path',
      read_image: 'file_path',
      glob: 'path',
      grep: 'path',
    }
    // 检索工具的 path 可省略，省略即整个工作区，因此必须要求显式给出。
    const SEARCH_TOOLS = new Set(['glob', 'grep'])

    const nodeFs = require('node:fs')
    const nodePath = require('node:path')
    const commands = ctx.get('commands')
    const systemPrompt = ctx.get('systemPrompt')
    if (!commands || !systemPrompt) {
      console.error('[creative-workflow-modes] 缺少核心服务 (commands/systemPrompt)；插件停用')
      return
    }

    const activeModes = new WeakMap()

    const readWorkspaceFile = async (cwd, rel) => {
      if (typeof cwd !== 'string' || cwd.length === 0) return undefined
      try {
        const target = nodePath.resolve(cwd, rel)
        if (nodeFs.existsSync(target)) {
          return nodeFs.readFileSync(target, 'utf8')
        }
      } catch (error) {
        return undefined
      }
      return undefined
    }

    const sanitize = (text) => text.replaceAll('{{', '{\\u200b{').replaceAll('}}', '}\\u200b}')

    // 把模型给出的路径解析为工作区内的相对路径。解析到工作区之外（含盘符、
    // 上跳越界）返回 undefined，由调用方按越界处理。
    const toWorkspaceRelative = (cwd, raw) => {
      if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
      const base = nodePath.resolve(cwd)
      const target = nodePath.resolve(base, raw)
      const rel = nodePath.relative(base, target)
      if (rel === '') return ''
      if (rel === '..' || rel.startsWith('..' + nodePath.sep) || nodePath.isAbsolute(rel)) return undefined
      return rel.split(nodePath.sep).join('/')
    }

    // 相对路径是否落在某条 scope 项内。空串表示工作区根目录：只有以 '/' 结尾的
    // 目录项能容纳它，单文件项不能。
    const withinScope = (rel, scope) => scope.some((entry) => {
      if (entry.endsWith('/')) return rel === entry.slice(0, -1) || rel.startsWith(entry)
      return rel === entry
    })

    // 工具调用的范围闸门。命中本会话已激活的模式时，只放行该模式 scope 内的
    // 路径；越界一律拒绝并说明原因。无模式激活、工具不碰文件、或路径无法解析
    // （交由工具自身报错）时放行。
    const scopeDenial = (agent, exec) => {
      const name = agent === undefined ? undefined : activeModes.get(agent.session)
      const spec = name === undefined ? undefined : MODES[name]
      if (spec === undefined) return undefined
      const argName = PATH_ARGUMENTS[exec.name]
      if (argName === undefined) return undefined
      const raw = exec.arguments === null || typeof exec.arguments !== 'object' ? undefined : exec.arguments[argName]
      const cwd = agent.session.header.cwd
      if (SEARCH_TOOLS.has(exec.name) && raw === undefined) {
        return \`【\${spec.label}】禁止在整个工作区范围内检索：\${exec.name} 必须显式指定 path。本模式仅允许访问：\${spec.scope.join('、')}。\`
      }
      if (raw === undefined) return undefined
      const rel = toWorkspaceRelative(cwd, raw)
      if (rel === undefined) {
        return \`【\${spec.label}】越界访问被拒绝：\${raw} 不在本模式允许范围内。本模式仅允许访问：\${spec.scope.join('、')}。\`
      }
      if (withinScope(rel, spec.scope)) return undefined
      return \`【\${spec.label}】越界访问被拒绝：\${rel === '' ? '（工作区根目录）' : rel} 不在本模式允许范围内。本模式仅允许访问：\${spec.scope.join('、')}。\`
    }

    ctx.on('tools/pre-execute', (exec, next) => {
      const scopeReason = scopeDenial(exec.agent, exec)
      if (scopeReason !== undefined) return Promise.resolve({ kind: 'deny', reason: scopeReason })
      return next()
    })

    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const agent = context.agent
      const name = agent === undefined ? undefined : activeModes.get(agent.session)
      const spec = name === undefined ? undefined : MODES[name]
      if (spec === undefined) return next()
      const cwd = agent.session.header.cwd
      const [principle, workflow] = await Promise.all([
        readWorkspaceFile(cwd, PRINCIPLE_FILE),
        readWorkspaceFile(cwd, spec.workflow),
      ])
      if (principle === undefined || workflow === undefined) return next()
      const text = [
        \`# 规则与工作流：\${spec.label}\`,
        \`## 《创作准则》\`,
        sanitize(principle),
        \`## 《\${spec.label}工作流》\`,
        sanitize(workflow),
      ].join('\\n\\n')
      const assembled = await next()
      if (assembled.sections.some((section) => section.name === SECTION_NAME)) return assembled
      return { ...assembled, sections: [...assembled.sections, { name: SECTION_NAME, text }] }
    }, { global: true })

    for (const [name, spec] of Object.entries(MODES)) {
      commands.register({
        name,
        description: \`进入\${spec.label}：从当前工作区动态加载《创作准则》与 \${spec.workflow} 并注入提示词\`,
        input: { hint: 'off | 附加指令（如润色目标段落）' },
        handler: async ({ agent, rawInput }) => {
          const arg = rawInput.trim()
          if (arg === 'off') {
            if (activeModes.get(agent.session) !== name) {
              return { kind: 'success', text: \`当前未处于\${spec.label}，无需退出。\` }
            }
            activeModes.delete(agent.session)
            return { kind: 'success', text: \`已退出\${spec.label}：规则文件不再注入提示词。\` }
          }
          const cwd = agent.session.header.cwd
          const [principle, workflow] = await Promise.all([
            readWorkspaceFile(cwd, PRINCIPLE_FILE),
            readWorkspaceFile(cwd, spec.workflow),
          ])
          if (principle === undefined || workflow === undefined) {
            const missing = []
            if (principle === undefined) missing.push(PRINCIPLE_FILE)
            if (workflow === undefined) missing.push(spec.workflow)
            return {
              kind: 'error',
              text: \`无法读取规则文件：\${missing.join('、')}（会话工作区：\${cwd ?? '（未设置）'}）。请确认文件存在后再试。\`,
            }
          }
          activeModes.set(agent.session, name)
          const summary = \`已进入\${spec.label}\`
          const narration = arg === ''
            ? \`已进入\${spec.label}，请遵循《创作准则》与《\${spec.label}工作流》开始执行。\`
            : \`已进入\${spec.label}。指令：\${arg}。请结合该指令并遵循《创作准则》与《\${spec.label}工作流》开始执行。\`
          try {
            agent.steer({
              id: \`mflow:\${name}:\${Date.now()}:\${Math.random().toString(36).slice(2, 10)}\`,
              role: 'user',
              content: [{ type: 'text', text: narration }],
              source: { kind: 'plugin:creative-workflow-modes', form: 'notice', summary },
            })
          } catch (error) {
            return { kind: 'error', text: \`已进入\${spec.label}，但无法启动模型回合：\${error instanceof Error ? error.message : String(error)}\` }
          }
          return {
            kind: 'success',
            text: \`\${summary}：\${PRINCIPLE_FILE} 与 \${spec.workflow} 已从工作区动态加载并注入提示词。修改规则文件后无需更新插件，下一次模型调用自动生效。\`,
          }
        },
      })
    }
  },
}
`

// ─────────────────────────────────────────────────────────────────────────────
// 内嵌资源 B：reflect-command.js
// ─────────────────────────────────────────────────────────────────────────────
const REFLECT_COMMAND_CODE = `'use strict'

// reflect-command.js —— 会话复盘与自动压缩插件 (/reflect, /reflect_project, /reflect_global)
//
// 复盘产出会分流到两个作用域：
//   通用技能   -> $DSH_HOME/skills          （跨项目复用，dsh-skill-filesystem 的 user-dsh 根）
//   项目专属技能 -> <项目根>/.dsh/skills      （仅本项目，project-dsh 根）
// 项目根取「最近含 .git 的祖先目录」而非会话 cwd：技能发现以仓库根为准，
// cwd 常是仓库子目录，写进 cwd 会导致技能根本不被加载。
//
// 三条命令共用同一套提取标准与写作规则，差别只在「本轮允许写哪个作用域」：
//   /reflect          两个作用域都写
//   /reflect_project  只写项目级
//   /reflect_global   只写全局级
// 指令里绝不出现本轮不可写的作用域：只要列出来，模型就会顺手多写一份，
// 而这正是拆分命令要消除的行为。多数会话以项目事实为主，因此单作用域命令
// 必须允许「本轮什么都不写」——否则模型会为了填满作用域硬造一份技能。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/**
 * 解析项目根目录：向上取最近的含 .git 的祖先目录。
 * @param cwd - 会话工作目录。
 * @returns 项目根绝对路径；cwd 无效时返回空串。
 */
function resolveProjectRoot(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return ''
  const base = path.resolve(cwd)
  let current = base
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return base
    current = parent
  }
}

/** 列出目录下已存在的技能名（\`<name>/SKILL.md\` 与扁平 \`<name>.md\` 两种形态）。 */
function listSkills(dir) {
  const names = []
  try {
    if (!fs.existsSync(dir)) return names
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (fs.existsSync(path.join(dir, entry.name, 'SKILL.md'))) names.push(entry.name)
      } else if (entry.name.endsWith('.md')) {
        names.push(entry.name.replace(/\\.md$/, ''))
      }
    }
  } catch (err) {}
  return names
}

/** 把技能名列表渲染成指令里的一小段缩进清单。 */
function describe(names) {
  return names.length > 0 ? names.map((name) => \`  - \${name}\`).join('\\n') : \`  (none yet)\`
}

const GLOBAL_CRITERION =
  'A lesson belongs here when it stays true and actionable after this project is forgotten: language and tool behavior, pitfalls, debugging and verification procedure, stable user collaboration preferences, general architecture or naming principles.'

const PROJECT_CRITERION =
  "A lesson belongs here when it depends on this project's concrete facts: directory layout, module and file responsibilities, internal interface contracts, business rules, the exact dependency and version combination, this project's own build or run procedure."

/**
 * 项目作用域是否根本不存在：无工作目录，或项目根与全局技能目录重合。
 * 此时 /reflect 只剩一个作用域，指令必须按单作用域措辞，否则它会点名一个
 * 不存在的项目目录、或指使模型去写它算不出来的路径。
 */
function isFolded(scope, dirs) {
  return scope === 'both' && dirs.project === ''
}

/**
 * 生成作用域段落：只描述本轮可写的作用域，并点名另一个作用域归属哪条命令。
 * @param scope - 'both' | 'project' | 'global'。
 * @param dirs - 本轮作用域目录，不涉及的为 ''。
 * @returns 指令中的作用域段落。
 */
function scopeSection(scope, dirs) {
  if (scope === 'global' || isFolded(scope, dirs)) {
    return [
      \`## Scope — general only\`,
      \`\`,
      \`Directory: \${dirs.global}\`,
      GLOBAL_CRITERION,
      \`\`,
      scope === 'global'
        ? \`**Write no project-specific skill this round**, even when the conversation is full of project facts. Those belong to \\\`/reflect_project\\\`.\`
        : \`**No separate project scope exists for this session** (no workspace directory, or the project root coincides with the global skills directory), so general skills are the only scope available.\`,
    ].join('\\n')
  }
  if (scope === 'project') {
    return [
      \`## Scope — project-specific only\`,
      \`\`,
      \`Directory: \${dirs.project}\`,
      PROJECT_CRITERION,
      \`\`,
      \`**Write no general skill this round**, even when a reusable lesson comes up. Those belong to \\\`/reflect_global\\\`.\`,
    ].join('\\n')
  }
  return [
    \`## Two scopes — classify every lesson\`,
    \`\`,
    \`Classify every lesson individually. Never generalize a project-specific fact into a general skill, and never bury a general lesson inside a project skill.\`,
    \`\`,
    \`**1. General — reusable across projects**\`,
    \`   Directory: \${dirs.global}\`,
    \`   \${GLOBAL_CRITERION}\`,
    \`\`,
    \`**2. Project-specific — this project only**\`,
    \`   Directory: \${dirs.project}\`,
    \`   \${PROJECT_CRITERION}\`,
  ].join('\\n')
}

/**
 * 生成准入门槛段落。单作用域命令必须显式允许空结果，
 * 否则「本轮只写这一处」会被读成「本轮必须写出点什么」。
 * @param scope - 'both' | 'project' | 'global'。
 * @returns 指令中的准入段落。
 */
function admissionSection(scope, dirs) {
  if (scope === 'global' || isFolded(scope, dirs)) {
    return [
      \`## Admission test\`,
      \`\`,
      \`Ask of every candidate: **would this still be correct and actionable in an unrelated repository, restated without reference to this project?**\`,
      \`- Yes → write it here.\`,
      \`- Only if the reader can see this project's code → **not this round's material.** Do not generalize it to make it fit; leave it out.\`,
      \`- **Writing nothing is a legitimate outcome.** Most sessions are dominated by project-specific work. If nothing survives the test, report that the general scope yielded nothing and stop — never manufacture a skill to fill the scope.\`,
    ].join('\\n')
  }
  if (scope === 'project') {
    return [
      \`## Admission test\`,
      \`\`,
      \`Ask of every candidate: **does this depend on this project's concrete facts — its paths, modules, contracts, dependencies, or its own way of building and running?**\`,
      \`- Yes → write it here.\`,
      \`- A statement that would stay true in an unrelated repository → **not this round's material.** Leave it out rather than dressing it up as a project fact.\`,
      \`- **Writing nothing is a legitimate outcome** when the session produced no project-specific lesson. Report that and stop.\`,
    ].join('\\n')
  }
  return [
    \`## Classification rule\`,
    \`\`,
    \`Ask: **would this still be correct in an unrelated repository?**\`,
    \`- Yes, once restated without reference to this project → general.\`,
    \`- Only if the reader can see this project's code → project-specific.\`,
    \`- Genuinely both layers → write it in both, each trimmed to its own scope. Never paste identical text into both.\`,
    \`- **When in doubt, choose project-specific.** A wrongly generalized skill actively misleads in other projects; a project-specific skill at worst goes unused.\`,
    \`\`,
    \`A scope with no material gets no skill — report it as empty instead of writing a thin one to fill it.\`,
  ].join('\\n')
}

/** 生成「已存在的技能」段落，只列本轮可写的作用域。 */
function existingSection(dirs, existing) {
  const lines = [\`## Already present — extend, do not duplicate\`, \`\`]
  if (dirs.global !== '') lines.push(\`General skills in \${dirs.global}:\`, describe(existing.global), \`\`)
  if (dirs.project !== '') lines.push(\`Project skills in \${dirs.project}:\`, describe(existing.project), \`\`)
  lines.push(\`If a lesson falls inside an existing skill, \\\`read\\\` it and extend it with \\\`edit\\\` rather than creating a parallel skill.\`)
  return lines.join('\\n')
}

/**
 * 组装复盘指令。
 * @param scope - 'both' | 'project' | 'global'。
 * @param dirs - 本轮作用域目录，不涉及的为 ''。
 * @param existing - 各作用域已存在的技能名。
 * @param compaction - 是否挂载了压缩后端，决定是否要求以 /compaction 收尾。
 * @returns 完整的复盘指令文本。
 */
function buildPrompt(scope, dirs, existing, compaction) {
  // 路径说明必须与上面声明的作用域数量一致：/reflect 有两个作用域，只写一个具体
  // 路径会让模型把两个作用域的技能都塞进项目目录；折叠成单作用域时则只有一个。
  const skillDir = dirs.project !== '' && scope !== 'global' ? dirs.project : dirs.global
  const skillPathLine = dirs.global !== '' && dirs.project !== ''
    ? \`Path: <scope directory above>/<skill-name>/SKILL.md — use the general directory for general skills and the project directory for project-specific ones. Start with YAML frontmatter, then the body:\`
    : \`Path: \${skillDir}/<skill-name>/SKILL.md. Start with YAML frontmatter, then the body:\`

  return [
    \`# Session Retrospective — Extract Skills\`,
    \`\`,
    \`Review the **entire conversation above** and extract durable engineering lessons into DSH skills: mistakes and their root causes, corrections the user made, tool and workflow rules, format preferences, hard-won facts about this environment.\`,
    \`\`,
    scopeSection(scope, dirs),
    \`\`,
    admissionSection(scope, dirs),
    \`\`,
    \`## What to extract, in priority order\`,
    \`\`,
    \`1. Mistakes made and their root cause — especially anything the user had to correct.\`,
    \`2. Rules the user stated or enforced: tool usage, output format, workflow order, things never to do.\`,
    \`3. Non-obvious facts about this environment, toolchain, or project that took real effort to establish.\`,
    \`4. Procedures that worked and should be repeated.\`,
    \`\`,
    \`Skip what is already obvious from the code, and skip one-off details with no future use.\`,
    \`\`,
    existingSection(dirs, existing),
    \`\`,
    \`## SKILL.md format\`,
    \`\`,
    skillPathLine,
    \`\`,
    \`    ---\`,
    \`    name: <skill-name>\`,
    \`    description: <one sentence: what this covers and when it should be read>\`,
    \`    whenToUse: <optional: the situation that should trigger reading it>\`,
    \`    ---\`,
    \`    # <Title>\`,
    \`    <the rule, why it holds, the concrete steps, the failure it prevents>\`,
    \`\`,
    dirs.project === ''
      ? ''
      : \`A project-specific skill's \\\`description\\\` must state that it applies to this project only, so it is never mistaken for a general practice elsewhere.\`,
    \`\`,
    \`## Language — English only\`,
    \`\`,
    \`Write every skill in **English**: the frontmatter (\\\`name\\\`, \\\`description\\\`, \\\`whenToUse\\\`) and the whole body. This holds regardless of the language of the conversation or of the user's messages. Skills are read by later sessions in unrelated projects, so one language keeps them consistent and retrievable.\`,
    \`\`,
    \`**Every skill listed above must be checked, and any that is not written in English must be rewritten in full, in English — not only the ones you happen to extend this round.** Read each one, then \\\`write\\\` the English version over it. Translate faithfully: keep every fact, and keep every command, path, version number and error string byte-for-byte. Drop nothing and summarize nothing. Leaving a non-English skill in place defeats this rule.\`,
    \`\`,
    \`## Writing rules\`,
    \`\`,
    \`- Write with the filesystem tools (\\\`read\\\`, \\\`write\\\`, \\\`edit\\\`). Nothing is retained unless it is on disk.\`,
    \`- One skill per coherent topic. A few dense skills beat many thin ones.\`,
    \`- Record the fact and its consequence, not the story of how you found it. Keep exact commands, paths, and error strings when they are the actionable part.\`,
    \`- Every rule must be falsifiable — something a reader could actually violate. Drop anything that only restates the obvious.\`,
    \`- No filler, and do not summarize the conversation back to the reader.\`,
    \`\`,
    \`## Finish\`,
    \`\`,
    \`Report which skills you created or updated, in which scope, and the single most important lesson from this session.\`,
    \`If a scope yielded nothing worth writing, say so plainly — an empty result is a legitimate report, not a failure.\`,
    compaction
      ? \`## Mandatory final action\\n\\nOnly after every SKILL.md is written to disk, your last action must be a tool call that outputs the text /compaction (for example \\\`Write-Output '/compaction'\\\` or \\\`echo /compaction\\\`). That signal triggers context compaction.\\n\\nDo NOT emit /compaction before the skills are saved.\`
      : '',
  ].filter(Boolean).join('\\n')
}

/** 三条命令的唯一差异：本轮允许写哪个作用域。 */
const COMMANDS = [
  {
    name: 'reflect',
    scope: 'both',
    description: '复盘当前会话提取 Skill (SKILL.md)，按通用/项目专属分流沉淀，并在复盘后自动压缩历史上下文',
    summary: '已触发 /reflect (通用 + 项目专属技能分流沉淀)',
  },
  {
    name: 'reflect_project',
    scope: 'project',
    description: '复盘当前会话，仅沉淀项目专属技能 (SKILL.md)，复盘后自动压缩历史上下文',
    summary: '已触发 /reflect_project (仅项目专属技能)',
  },
  {
    name: 'reflect_global',
    scope: 'global',
    description: '复盘当前会话，仅沉淀通用技能 (SKILL.md)；没有值得沉淀的通用经验时会如实说明，复盘后自动压缩历史上下文',
    summary: '已触发 /reflect_global (仅通用技能)',
  },
]

module.exports = {
  name: 'command-reflect',
  inject: ['commands'],

  apply(ctx) {
    const commands = ctx.get('commands')
    if (!commands) return

    const pendingCompaction = new Map()

    function extractToolResultText(event) {
      const content = event.data?.message?.content
      if (!Array.isArray(content)) return ''
      let text = ''
      for (const item of content) {
        // v4 起消息内容块是扁平的（ToolResultMessage.content 直接就是 ContentBlock[]），
        // 早期版本才会套一层 { type: 'tool-result', content: [...] }。两种形态都要认。
        const blocks = Array.isArray(item.content) ? item.content : [item]
        for (const block of blocks) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            text += block.text + ' '
          }
        }
      }
      return text
    }

    function extractToolCallText(event) {
      const args = event.data?.arguments
      return typeof args === 'string' ? args : ''
    }

    function extractAssistantText(event) {
      const content = event.data?.message?.content
      if (!Array.isArray(content)) return ''
      let text = ''
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          text += block.text + ' '
        }
      }
      return text
    }

    function resolveCompaction(agent) {
      const candidates = [
        ctx.get('compaction'),
        agent && agent.ctx ? agent.ctx.get('compaction') : undefined,
      ]
      const presets = ctx.get('agentPresets')
      if (presets && typeof presets.serviceFor === 'function' && agent) {
        candidates.push(presets.serviceFor(agent, 'compaction'))
      }
      return candidates.find((it) => it && typeof it.compactNow === 'function')
    }

    // 压缩总时长上限：压缩会发一次真实的模型请求，输入可达数 MB。
    // 没有上限时，请求一旦悬挂，runMaintenance 的 finally 永不执行，
    // agent 会永久停在维护相位 —— 后续输入全被 latch 住，
    // Web 端表现为「刷新不动、切会话持续加载」。这是必须兜底的根因。
    const COMPACTION_TIMEOUT_MS = 5 * 60 * 1000

    /**
     * 等待 agent 真正静止（既无活动回合，也不在维护中）。
     *
     * 判据用公开的 \`agent.whenIdle()\`：它等到 activityDone 链收敛，而维护任务
     * 同样会占据 activityDone，所以「真空闲」与「正在维护」都能区分——这正是
     * \`agent.status\` 做不到的（该 getter 把 maintenance 相位也报成 'idle'）。
     * \`agent.phase\` 是 agent-loop 的内部实现，不是公开 API，不得依赖。
     *
     * 本函数在 compactNow 之前调用，不在维护任务内部，因此不会触发
     * 「runMaintenance 把 activityDone 设成本次维护 promise」导致的自我死锁；
     * 死锁只在维护内部调用 whenIdle 时才会发生。
     * @param {object} agent - 目标 agent。
     * @param {number} deadline - 等待截止时间戳（毫秒）。
     * @returns {Promise<boolean>} 是否等到静止。
     */
    async function waitForIdle(agent, deadline) {
      if (typeof agent.whenIdle !== 'function') return true
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      let timer
      try {
        return await Promise.race([
          agent.whenIdle().then(() => true),
          new Promise((resolve) => { timer = setTimeout(() => resolve(false), remaining) }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }

    async function triggerCompaction(task) {
      const { agent, commandId } = task
      console.log('[reflect-command] 检测到模型输出的 /compaction 信号，等待回合收尾后执行压缩...')

      // 不在此处 await：本函数由 session/event 观察者调用，而压缩要等当前回合
      // 完全结束（相位回到 idle）才可能成功。setTimeout 让出当前调用栈，
      // 避免与 turn/end 的收尾路径相互阻塞。
      setTimeout(async () => {
        const deadline = Date.now() + COMPACTION_TIMEOUT_MS
        try {
          const compaction = resolveCompaction(agent)
          if (!compaction) {
            console.warn('[reflect-command] 当前会话未提供 compaction 服务，跳过复盘后的自动压缩。')
            return
          }

          const idle = await waitForIdle(agent, deadline)
          if (!idle) {
            console.warn('[reflect-command] 等待 agent 空闲超时，本次跳过自动压缩（会话未受影响）。')
            return
          }

          // 让 turn/end 的收尾（含持久化）先落地，再进入维护相位。
          await new Promise((resolve) => setTimeout(resolve, 300))

          // 超时与取消合成同一个信号：无论哪边先触发，compactNow 都会被中断，
          // runMaintenance 的 finally 得以执行，相位必定回到 idle。
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(new Error('reflect compaction timeout')), Math.max(0, deadline - Date.now()))
          try {
            const result = await compaction.compactNow(agent, controller.signal, commandId)
            if (result) {
              console.log(\`[reflect-command] 自动压缩完成: 折叠 \${result.shadowedSeqs.length} 条历史 (~\${result.shadowedTokenCount} tokens)\`)
            } else {
              console.log('[reflect-command] 自动压缩完成（当前无可折叠历史）')
            }
          } finally {
            clearTimeout(timer)
          }
        } catch (err) {
          // 压缩失败绝不能影响会话可用性：只记录，不上抛。
          console.warn('[reflect-command] 自动压缩异常:', err instanceof Error ? err.message : String(err))
        }
      }, 100)
    }

    function isCompactionSignal(text) {
      if (typeof text !== 'string') return false
      const lower = text.toLowerCase()
      return lower.includes('/compaction') || lower.includes('/compation')
    }

    // 触发时机：模型通过工具输出 /compaction 只是「请求压缩」的意图，
    // 此刻回合仍在运行，而 runMaintenance 要求相位为 idle，立即调用必然被拒。
    // 因此这里只登记意图，等 turn/end 落地后再真正启动压缩。
    ctx.on('session/event', async (session, event) => {
      const task = pendingCompaction.get(session)
      if (!task) return

      let matched = false
      if (event.type === 'tool/result') {
        const text = extractToolResultText(event)
        if (isCompactionSignal(text)) matched = true
      } else if (event.type === 'tool/call') {
        const text = extractToolCallText(event)
        if (isCompactionSignal(text)) matched = true
      } else if (event.type === 'assistant/message') {
        const text = extractAssistantText(event)
        if (isCompactionSignal(text)) matched = true
      }

      if (matched) {
        task.requested = true
        return
      }

      // 回合真正结束后才动手；reason.kind === 'completed' 之外（interrupted /
      // aborted / error）同样收尾，因为相位此时也已回到 idle，压缩仍可进行。
      if (event.type === 'turn/end') {
        if (task.requested === true) {
          pendingCompaction.delete(session)
          void triggerCompaction(task)
        } else {
          // 模型始终没有输出 /compaction：本回合不带压缩意图，清理登记，
          // 避免 pendingCompaction 随会话累积。
          pendingCompaction.delete(session)
        }
      }
    })

    for (const { name, scope, description, summary } of COMMANDS) {
      commands.register({
        name,
        description,
        handler: async ({ agent, commandId }) => {
          if (!agent || !agent.session) {
            return { kind: 'error', text: '无法获取当前会话的 Agent 实例。' }
          }

          const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
          const globalSkillsDir = path.join(dshHome, 'skills')
          const projectRoot = resolveProjectRoot(agent.session.header?.cwd)
          // 无 .git 时项目根回退到 cwd，而 cwd 可能就是家目录 —— 此时「项目级」目录
          // 会与全局目录算出同一个路径。必须折叠成单作用域，否则会指使模型把同一份
          // 技能往同一处写两遍，还会让它以为存在两个互不相干的沉淀位置。
          const candidate = projectRoot === '' ? '' : path.join(projectRoot, '.dsh', 'skills')
          const projectSkillsDir = candidate === globalSkillsDir ? '' : candidate

          // 折叠后 /reflect_project 没有可写的独立目录：如实报错，而不是退化成写全局。
          if (scope === 'project' && projectSkillsDir === '') {
            return {
              kind: 'error',
              text: projectRoot === ''
                ? '当前会话未设置工作目录，无法定位项目级技能目录。'
                : \`项目根与家目录重合，项目级技能目录与全局技能目录同为 \${globalSkillsDir}，没有独立的项目作用域可写。\`,
            }
          }

          const dirs = {
            global: scope === 'project' ? '' : globalSkillsDir,
            project: scope === 'global' ? '' : projectSkillsDir,
          }

          for (const dir of [dirs.global, dirs.project]) {
            if (dir === '') continue
            try {
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
            } catch (err) {}
          }

          const existing = {
            global: dirs.global === '' ? [] : listSkills(dirs.global),
            project: dirs.project === '' ? [] : listSkills(dirs.project),
          }

          const compaction = resolveCompaction(agent)
          const prompt = buildPrompt(scope, dirs, existing, Boolean(compaction))

          if (compaction) {
            pendingCompaction.set(agent.session, { agent, commandId })
          }

          try {
            agent.steer({
              id: \`reflect:\${Date.now()}:\${Math.random().toString(36).slice(2, 10)}\`,
              role: 'user',
              content: [{ type: 'text', text: prompt }],
              source: { kind: 'plugin:command-reflect', form: 'notice', summary },
            })
          } catch (error) {
            pendingCompaction.delete(agent.session)
            return {
              kind: 'error',
              text: \`无法启动复盘轮次：\${error instanceof Error ? error.message : String(error)}\`,
            }
          }

          const scopeLines = [
            dirs.global === '' ? '' : \`- 通用技能：\${dirs.global}\`,
            dirs.project === '' ? '' : \`- 项目专属技能：\${dirs.project}\`,
          ].filter(Boolean).join('\\n')

          const singleScopeNote = scope === 'both'
            ? ''
            : '\\n本轮只写一个作用域：若该作用域确实没有值得沉淀的经验，模型会如实说明，不会强行生成一份。'

          const compactNote = compaction
            ? '技能全部落盘后，模型会通过工具输出 /compaction，系统随即启动上下文压缩总结。'
            : '注意：当前 Agent 预设未挂载压缩后端，本次不会自动压缩上下文。'

          return {
            kind: 'success',
            text: \`已触发【复盘\${compaction ? ' + 压缩' : ''}】流程：模型正在回顾会话历史，把经验写入本轮作用域：\\n\${scopeLines}\\n\${compactNote}\${singleScopeNote}\`,
          }
        },
      })
    }
  },
}

`

// ─────────────────────────────────────────────────────────────────────────────
// 内嵌资源 C：preset-hotreload-and-meter.js
// 插件内部注释已详述实现依据；此处只记脚本层面必须知道的几点：
//   - `agentPresets.recompose(ctx, id)` 会把已有绑定切到新 generation，但它内部的
//     retain() 会命中缓存，所以必须等 dsh-hmr 真正重建完声明行之后再调用，否则只是
//     重绑到旧修订（这正是 flush 要延迟 250ms 的原因）。
//   - `agent.phase` 不是公开 API（公开面为 `agent.status` 与 `agent.whenIdle()`），
//     本插件的空闲判据不读内部相位。
//   - 上下文计量的呈现层修正由第 4.4 号补丁完成，本插件不再覆盖 contextBreakdown 投影。
// ─────────────────────────────────────────────────────────────────────────────
const PRESET_HOTRELOAD_AND_METER_CODE = `'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

module.exports = {
  name: 'preset-hotreload-and-meter',
  inject: ['agentPresets'],

  apply(ctx) {
    const agentPresets = ctx.get('agentPresets')
    if (!agentPresets) {
      console.error('[preset-hotreload] 缺少 agentPresets 服务；插件停用')
      return
    }

    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

    // ── 1. 预设热重载 ───────────────────────────────────────────────────────────
    // 预设不再是 ~/.dsh/.agent-presets/<id>/ 目录，而是 patch 层里的
    // @deepseek-ai/dsh-agent-preset 声明行；dsh-hmr 会监听下列 patch 文件，并在
    // 变更时重放整层（行 dispose 后重新 init，注册表随之拿到新修订）。
    // 官方语义是「已有会话保持启动时的修订」，所以本插件只补最后一步：
    // 把已运行的会话重绑到重放后的新修订，使改动无需重启、也无需新建会话即可生效。
    const watchedFiles = [
      path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'),
      path.join(dshHome, 'cordis.patch.yml'),
    ]

    const fileStamps = new Map()
    const liveAgents = new Map()
    const changedPresetIds = new Set()
    const presetRowsSeen = new Set()
    let flushTimer

    const fileStamp = (file) => {
      try {
        const stat = fs.statSync(file)
        return stat.mtimeMs + ':' + stat.size
      } catch (error) {
        return undefined
      }
    }

    const scheduleFlush = () => {
      if (flushTimer !== undefined) return
      // 留出 patch 重放与注册表重注册的落地时间，再执行重绑。
      flushTimer = setTimeout(() => {
        flushTimer = undefined
        flush()
      }, 250)
    }

    /**
     * 会话当前是否真正静止（无活动回合，也不在维护中）。
     *
     * \`agent.status\` 在维护期间仍报 'idle'（官方语义：runMaintenance 执行时
     * public status stays idle），所以单看 status 无法区分「真空闲」与「正在维护」；
     * \`agent.phase\` 又是 agent-loop 的内部实现，不是公开 API。这里用公开的
     * \`agent.whenIdle()\` 做即时探测：真空闲时它在微任务内就 resolve，
     * 维护或回合进行中则要等，因此给一个很短的等待窗——等不到就按「忙」处理。
     * 语义：忙的会话本次跳过重绑，等下一次 patch 变更再试。
     * @param {object} agent - 目标 agent。
     * @returns {Promise<boolean>} 是否可立即重绑。
     */
    const quiescentNow = (agent) => {
      if (typeof agent.whenIdle !== 'function') return Promise.resolve(true)
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 50)
        const settle = (value) => { clearTimeout(timer); resolve(value) }
        agent.whenIdle().then(() => settle(true), () => settle(false))
      })
    }

    const flush = async () => {
      const ids = [...changedPresetIds]
      changedPresetIds.clear()
      const label = ids.length > 0 ? '（' + ids.join('、') + '）' : ''
      const targets = []
      for (const agent of liveAgents.values()) {
        let presetId
        try {
          presetId = agentPresets.composedPreset(agent.ctx)
        } catch (error) {
          presetId = undefined
        }
        if (presetId === undefined) continue
        if (ids.length > 0 && !ids.includes(presetId)) continue
        if (agent.status !== undefined && agent.status !== 'idle') {
          console.log('[preset-hotreload] 会话 ' + agent.id + ' 状态为 ' + agent.status + '，本次跳过重绑')
          continue
        }
        if (!(await quiescentNow(agent))) {
          console.log('[preset-hotreload] 会话 ' + agent.id + ' 仍在活动或维护中，本次跳过重绑')
          continue
        }
        targets.push({ agent, presetId })
      }
      if (targets.length === 0) {
        console.log('[preset-hotreload] 预设声明已更新' + label + '，当前无空闲会话需要重绑；新建会话将直接使用新修订。')
        return
      }
      console.log('[preset-hotreload] 检测到预设声明更新' + label + '，正在为 ' + targets.length + ' 个空闲会话重绑新修订...')
      for (const target of targets) {
        try {
          await agentPresets.recompose(target.agent.ctx, target.presetId)
          console.log('[preset-hotreload] 会话 ' + target.agent.id + ' 已重绑到预设「' + target.presetId + '」的最新修订。')
        } catch (error) {
          console.warn('[preset-hotreload] 会话 ' + target.agent.id + ' 重绑预设「' + target.presetId + '」失败：' + (error instanceof Error ? error.message : String(error)))
        }
      }
    }

    // 信号一：预设声明行的重新初始化。首次挂载只登记、不算变更，避免开机误报。
    ctx.on('loader/entry-init', (entry) => {
      const id = !entry || !entry.options ? undefined : entry.options.id
      if (typeof id !== 'string' || !id.startsWith('preset-')) return
      if (!presetRowsSeen.has(id)) {
        presetRowsSeen.add(id)
        return
      }
      changedPresetIds.add(id.slice('preset-'.length))
      scheduleFlush()
    })

    // 信号二：patch 文件时间戳（覆盖「patch 变更但预设行未重建」的情形），
    // 并在步骤边界登记活动会话，供重绑阶段定位。
    // agent/pre-step 由 agent 作用域载体派发（scopeTarget(agent, agent)），
    // 宿主行必须声明 global 才能收到会话作用域里的事件。
    ctx.on('agent/pre-step', async (payload, next) => {
      const agent = payload === undefined || payload === null ? undefined : payload.agent
      if (agent !== undefined && typeof agent.id === 'string') {
        liveAgents.set(agent.id, agent)
        // 上限兜底：只保留最近活动的 64 个会话，避免长期持有已结束会话的 Agent。
        if (liveAgents.size > 64) {
          const oldest = liveAgents.keys().next().value
          liveAgents.delete(oldest)
        }
      }
      for (const file of watchedFiles) {
        const stamp = fileStamp(file)
        if (stamp === undefined) continue
        const previous = fileStamps.get(file)
        fileStamps.set(file, stamp)
        if (previous !== undefined && previous !== stamp) {
          changedPresetIds.clear()
          scheduleFlush()
        }
      }
      return typeof next === 'function' ? next() : undefined
    }, { global: true })

    // ── 2. 上下文计量说明 ───────────────────────────────────────────────────────
    // 此处原有一段覆盖 contextBreakdown 投影的代码，已移除。原因：
    //   (a) SessionProjectionRegistry.register() 为「先注册者胜」—— dsh-token-meter
    //       在构造时就注册了 contextBreakdown，插件后注册只增加引用计数，
    //       其 apply/view 会被直接丢弃，属于死代码；
    //   (b) 该 fold 只统计顶层 type==='text' 块，而 tool/result 内容嵌套在
    //       {type:'tool-result', content:[...]} 内部，工具消息被计为 0，且完全
    //       未处理压缩的 replace 操作——即便生效也会得到严重偏小的数字。
    // 面板「明细与总量对不上」的根因：头部数字取 contextPressure 的 projectedTokens
    // （provider usage 锚定的真实请求规模），三行明细取 contextBreakdown 的启发式估算，
    // 两者本就分属两套体系、上游明确不相加。修正只做在呈现层
    // （applyCorePatches 的 4.4：按明细权重把真实总量分配下去），
    // 不触碰估算器与压缩阈值，可随时回滚。
  },
}
`

// ─────────────────────────────────────────────────────────────────────────────
// 内嵌资源 D：explore-command.js
// ─────────────────────────────────────────────────────────────────────────────
const EXPLORE_COMMAND_CODE = `'use strict'

// explore-command.js —— 工作区项目全面探索插件 (/explore)
//
// 与 /reflect 的分工：
//   /reflect  面向「会话历史」——萃取经验，沉淀为 Skill；
//   /explore  面向「代码仓库」——通读实现，沉淀为 PROJECT.md。
// 两者都是「注册命令 + steer 一个带完整指令的模型回合」，不引入任何新的工具面。
const fs = require('node:fs')
const path = require('node:path')

/**
 * 解析项目根目录：向上取最近的含 .git 的祖先目录。
 *
 * 不能用 cwd 直接当项目根：DSH 的 skill 发现、git 相关行为都以仓库根为准，
 * 而会话 cwd 可能是仓库的子目录。找不到 .git 时回退到 cwd 本身。
 * @param cwd - 会话工作目录。
 * @returns 项目根绝对路径；cwd 无效时返回空串。
 */
function resolveProjectRoot(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return ''
  const base = path.resolve(cwd)
  let current = base
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return base
    current = parent
  }
}

module.exports = {
  name: 'command-explore',
  inject: ['commands'],

  apply(ctx) {
    const commands = ctx.get('commands')
    if (!commands) return

    commands.register({
      name: 'explore',
      description: '全面探索当前工作区项目的架构与实现，产出一份完善的 PROJECT.md',
      input: { hint: '[可选：聚焦方向，如「数据流」「插件系统」]' },
      handler: async ({ agent, rawInput }) => {
        if (!agent || !agent.session) {
          return { kind: 'error', text: '无法获取当前会话的 Agent 实例。' }
        }

        const cwd = agent.session.header?.cwd
        const projectRoot = resolveProjectRoot(cwd)
        if (projectRoot === '') {
          return { kind: 'error', text: '当前会话未设置工作目录，无法定位项目根目录。' }
        }

        const targetFile = path.join(projectRoot, 'PROJECT.md')
        let existing = false
        try {
          existing = fs.statSync(targetFile).isFile()
        } catch (err) {
          existing = false
        }

        const focus = rawInput ? rawInput.trim() : ''

        const promptLines = [
          \`# Project Exploration — Produce PROJECT.md\`,
          \`\`,
          \`Explore this project's architecture and implementation thoroughly, then write a complete \\\`PROJECT.md\\\`.\`,
          \`\`,
          \`- Project root: \${projectRoot}\`,
          \`- Output file: \${targetFile}\`,
          existing
            ? \`- **This file already exists.** Read it in full first. Keep what is still accurate and keep any hand-written sections as they are; add what this exploration newly establishes. Do not replace it with a rewrite that loses existing content.\`
            : \`- **This file does not exist yet.** Create it.\`,
          focus ? \`- **User-requested focus: \${focus}** — still cover the whole project, but go deeper here than anywhere else.\` : '',
          \`\`,
          \`## Method\`,
          \`\`,
          \`1. **Map the shape first.** List the tree, skipping generated and vendored directories (\\\`node_modules\\\`, \\\`.git\\\`, \\\`dist\\\`, \\\`build\\\`, caches). Read the package manifest, build and bundler config, language and framework config, CI config, and any top-level docs.\`,
          \`2. **Find the boundaries.** Locate the entry points, the external surfaces (CLI arguments, HTTP routes, exported API, plugin registration points), where configuration is read, and where state is persisted.\`,
          \`3. **Read the implementation.** Open the files that actually carry the logic. Determine the real data flow and control flow from the code, never from filenames, comments, or directory names alone.\`,
          \`4. **Verify every claim.** Each statement in the document must be traceable to a file you read. Where comments or docs disagree with the code, the code is correct — and say so. Where you could not confirm something, mark it explicitly as unverified. Never fill a gap by guessing.\`,
          \`5. **Cover at minimum:** entry points, core modules, data model, configuration, build and run procedure, external dependencies and integration points.\`,
          \`\`,
          \`## What PROJECT.md must contain\`,
          \`\`,
          \`1. **What this is** — the problem it solves, who it is for, what stage it is at.\`,
          \`2. **Stack** — language, runtime and version requirements, frameworks, key third-party dependencies, each with the file that establishes it.\`,
          \`3. **Layout** — the responsibility of each significant directory and file, against real paths.\`,
          \`4. **Architecture** — module boundaries, dependency direction, and the core data flow. Use a diagram (mermaid or ASCII) when prose would be slower to read.\`,
          \`5. **Key mechanisms** — how the important parts actually work: protocols, algorithms, state management, concurrency, error handling.\`,
          \`6. **Build and run** — the exact commands for install, build, start, test, and package, plus their prerequisites.\`,
          \`7. **Conventions and extension points** — code style, naming, and how to add a module, plugin, or endpoint.\`,
          \`8. **Constraints and traps** — platform limits, known defects, easy mistakes, unfinished areas.\`,
          \`\`,
          \`Adapt these sections to the project. Drop any that do not apply rather than padding them.\`,
          \`\`,
          \`## Writing rules\`,
          \`\`,
          \`- Use the filesystem and search tools (\\\`read\\\`, \\\`glob\\\`, \\\`grep\\\`) to read the source, then \\\`write\\\` or \\\`edit\\\` to land the result. Nothing counts until it is on disk.\`,
          \`- On a large project, write the document section by section as you finish exploring each area, instead of reading everything before writing anything.\`,
          \`- Density over length. The document should be worth more than the time it takes to read.\`,
          \`- Prefer concrete specifics — exact commands, real paths, actual version numbers, real function names — over general description.\`,
          \`- No filler, no disclaimers, no directory listing restated as prose to look thorough.\`,
          \`- Match the language of the project's existing documentation. If there is none, write in Chinese.\`,
          \`\`,
          \`## Finish\`,
          \`\`,
          \`Report what you covered, the most important things the reader should know, and anything you could not verify.\`,
        ].filter(Boolean).join('\\n')

        const summary = focus ? \`已触发 /explore (聚焦: \${focus})\` : \`已触发 /explore (项目全面探索)\`

        try {
          agent.steer({
            id: \`explore:\${Date.now()}:\${Math.random().toString(36).slice(2, 10)}\`,
            role: 'user',
            content: [{ type: 'text', text: promptLines }],
            source: { kind: 'plugin:command-explore', form: 'notice', summary },
          })
        } catch (error) {
          return {
            kind: 'error',
            text: \`无法启动探索轮次：\${error instanceof Error ? error.message : String(error)}\`,
          }
        }

        return {
          kind: 'success',
          text: \`已触发【项目探索】流程：\\n- 项目根目录：\${projectRoot}\\n- 产出文件：\${targetFile}\${existing ? '（已存在，将增量完善而非覆盖）' : '（新建）'}\\n模型正在通读源码，完成后会写入该文件并汇报结论。\`,
        }
      },
    })
  },
}
`

// ─────────────────────────────────────────────────────────────────────────────
// 内嵌资源 E：idle-guard.js
// ─────────────────────────────────────────────────────────────────────────────
// 落盘拦截规则，两种模式：默认（普通提交键）不拦截任何调用；武装（界面按钮发起）
// 由客户端先 POST /idle-arm/arm 置位，随后按检查点拦截非落盘调用，持续到回合结束。
// 时间曲线、三阶段压力、计数器分工等设计理由全部写在插件内部注释里（随插件一起
// 落盘到 ~/.dsh/plugins/idle-guard.js），此处不重复。
//
// 脚本层面需要知道的两点：
//   1. 武装为什么不用宿主命令传递分钟数：`session.command()` 执行的是宿主斜杠命令，
//      它既不读也不提交输入框草稿——空草稿会照样推一条命令流程，有草稿时用户输入
//      反而永远发不出去。武装必须是「静默的旁路」，与提交动作分开。
//   2. 基准取会话自身的回合计时（turn/start 事件的 time），即界面左下角「深度求索中，
//      用时」的同一个起点，因此本规则与用户看到的计时永远一致，不另起一套时钟。
// ─────────────────────────────────────────────────────────────────────────────
const IDLE_GUARD_CODE = `'use strict'

// idle-guard.js —— 闲置落盘拦截（宿主级持久插件）
module.exports = {
  name: 'idle-guard',
  inject: ['webServer', 'connection'],
  apply(ctx) {
    // 会落盘的工具。它们一到就把计时清零——本规则唯一认可的生产行为。
    const EDIT_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
    const MINUTE_MS = 60000
    // 起拦分钟数的合法区间。下限取 3 而非 1：单段间隔的下限就是 3 分钟，允许更小的
    // 起拦时间会让首段间隔低于下限——要么静默按 3 跑（用户填的数被改写），要么违反
    // 「每段不少于 3 分钟」。把区间收在 3 上，两个毛病一起没有。
    const MIN_MINUTES = 3
    const MAX_MINUTES = 600
    // 单段间隔下限：读一次警告、判断、落实成一次落盘所需的最短时间。
    const MIN_GAP = 3
    // 每个阶段要送达几次拦截：软阶段 1 次，严厉阶段连拦 2 次，之后进入闩锁（无限次）。
    // 阶段边界由这张表推出，不在别处硬编码——改「连拦几次」只需要改这里一个数字。
    const STRIKES_PER_STAGE = [1, 2]
    // 送满这些次数就进入闩锁阶段。
    const TERMINAL_SERVED = STRIKES_PER_STAGE.reduce((a, b) => a + b, 0)
    // 武装端点。kind 为 exact，只接 POST。
    const ARM_PATH = '/idle-arm/arm'

    /**
     * 三阶段警告词，下标 = 阶段（0/1/2），二级下标 = 是否已经落过盘。
     *
     * 阶段按**已送达的拦截次数**递增：用户说的是「第几次拦截」，压力理应随
     * 「被警告过几次」上升。而「何时允许拦」仍由时间曲线决定——两者是正交的，
     * 阶段管措辞与重复方式，曲线管节奏。
     *
     * 每一级都保留「尚未落盘 / 落盘后又空转」的区分：模型明明落过盘却被说成
     * 「从未编辑」，会把它往错误方向推，这条区分在任何一级都成立。
     */
    const WARNINGS = [
      // 第一阶段：软拦截。措辞保持最初版本不变。
      [
        '【警告】自本任务开始已过去 {m} 分钟，你仍未进行过任何文件编辑，请你提高工作效率，减少低效检索、重复思考与无目的空转，专注于用户给予的任务本身，不要分散注意力，并尽快落盘修改！',
        '【警告】距上次落盘已过去 {m} 分钟，这段时间你没有产生新的落盘成果。请你提高工作效率，减少低效检索、重复思考与无目的空转，专注于用户给予的任务本身，不要分散注意力，尽快把新的成果落盘修改！',
      ],
      // 第二阶段：措辞更严厉，且本阶段要连拦两次才放行。
      [
        '【严重警告】自本任务开始已过去 {m} 分钟，你依然没有进行过任何文件编辑。这是第二次拦截，下一次将不再放行你的任何非落盘调用。立刻停止检索与空转，现在就去落盘。',
        '【严重警告】距上次落盘已过去 {m} 分钟，你依然没有产生新的落盘成果。这是第二次拦截，下一次将不再放行你的任何非落盘调用。立刻停止检索与空转，现在就把新成果落盘。',
      ],
      // 第三阶段：强制状态。不再看时钟，重复拦截直到出现一次落盘。
      [
        '【强制拦截】自本任务开始已过去 {m} 分钟，你始终没有进行过任何文件编辑。在你完成一次文件编辑之前，每一次非落盘的工具调用都会被拒绝。立即停止一切检索，直接落盘。',
        '【强制拦截】距上次落盘已过去 {m} 分钟，你始终没有产生新的落盘成果。在你完成一次新的文件编辑之前，每一次非落盘的工具调用都会被拒绝。立即停止一切检索，直接落盘修改。',
      ],
    ]

    /**
     * 已送达 served 次拦截时，该用哪个阶段。
     *
     * 按累计次数逐级扣除，而不是写死 served 与阶段号的对应关系：后者
     * 一旦改了 STRIKES_PER_STAGE 就会悄悄错位，而且「第二阶段连拦两次」的第二次
     * 极易被算成第三阶段——那正是把严厉措辞写成强制措辞的原因。
     */
    const stageOf = (served) => {
      let stage = 0
      let left = served
      while (stage < STRIKES_PER_STAGE.length && left >= STRIKES_PER_STAGE[stage]) {
        left -= STRIKES_PER_STAGE[stage]
        stage += 1
      }
      return stage
    }

    /** 按当前已送达次数与是否落过盘取警告词。 */
    const reasonFor = (state, minutes) => {
      const stage = Math.min(stageOf(state.served), WARNINGS.length - 1)
      return WARNINGS[stage][state.edited ? 1 : 0].replace('{m}', String(minutes))
    }

    /**
     * 已武装的会话 → { minutes, gap, edited, consumed, served, lastStage, pending }。
     * 未列入 = 默认模式，完全不拦截。
     *
     * consumed 与 served 必须分开，这是本规则最容易写错的地方：
     *   · consumed —— 已消费到第几个检查点，只由时钟推进，决定**何时允许拦**。
     *   · served   —— 已实际送达几次拦截，只在批次结算时推进，决定**拦得多重**。
     * 合用一个计数器会有两种错法：按 served 逐次加一，模型一口气想过了很多检查点时
     * passed 远大于 served，闸门一直开着，三个阶段会背靠背连发；按 passed 直接赋值，
     * 阶段二想「连拦两次」就凑不齐——第二次得等到下一个检查点，那就不叫连拦了。
     *
     * lastStage 记的是**上一次拦截所用的阶段**。阶段二的第二次连拦靠它判断：
     * 只有上一次拦截已经是严厉级，才补第二次。否则软拦截刚结算完（served=1）就会
     * 被误判成「阶段二还差一次」，在 T(2) 之前提前开出严厉级。
     *
     * 所有计数器都**只在 step/end 推进**，绝不在 pre-execute 里改：模型常在一个批次
     * 里并发调用多个工具，若在拦截时就推进，同批其余调用会因「已消费」而全部放行——
     * 那正是要堵的漏洞。
     */
    const armed = new WeakMap()
    /** 会话 → 计时基准时刻（回合开始，或最近一次落盘）。 */
    const idleBase = new WeakMap()

    /**
     * 单段间隔：起拦时间是用户对任务耗时的预估，间隔取它的一半。
     *
     * 为什么是预估的一半而不是别的：S 这种量级的人工预估本身就有两倍上下的误差
     * （计划谬误的量级）。间隔比 S/2 更密，就落进预估自身的噪声带——警告会在用户
     * 认可的工作节奏内反复打断，退化成重复打扰；比 S/2 更疏，盲区就超过用户自认可
     * 接受时长的一半，限时失去意义。取一半是这两侧之间唯一不带任意常数的分界。
     *
     * 下限 3 分钟：读一次警告、判断、落实成一次落盘，短于 3 分钟做不到。下限同时
     * 兜住 S 很小的情况，而输入下限也是 3，所以它实际上只在 S=3、4、5 时生效
     * （ceil(S/2) 分别为 2、2、3）。
     *
     * @param {number} minutes - 用户设定的起拦分钟数 S。
     */
    const gapOf = (minutes) => Math.max(MIN_GAP, Math.ceil(minutes / 2))

    /**
     * 反解已越过的检查点个数：满足 T(k) <= elapsed 的最大 k，其中
     *     T(k) = S + (k-1)·gap，gap = gapOf(S)
     * 即首段为 S，此后每段恒为 gap。
     *
     * 反解写成 k = floor((elapsed - S) / gap) + 1 也等价，但那样「正算」与「反解」
     * 就是两套式子，一旦哪天改了曲线就得同时改两处，漏一处就出现「明明过了点却没拦」
     * 那种错位。这里只留一份递推，正算反解共用同一串 T(k)。
     *
     * 增量求和是 O(k)，而 k 在本场景里是个位数到两位数（S=3 时每分钟一个检查点，
     * 跑满一小时也才 60 个），不必为性能牺牲可读性。
     *
     * 时钟被 NTP 回拨（elapsed 为负）无需特判：首个区间恒为 S 分钟，next > elapsed
     * 立刻成立，循环直接返回 0。这是 36001 个负采样点扫出来的结论，不是推断——
     * 所以这里没有 Math.max(0, …) 那种看着稳妥的冗余钳制。
     *
     * @param {number} elapsedMs - 距基准已过的毫秒数。
     * @param {number} base - 用户设定的起拦分钟数 S。
     * @param {number} gap - 单段间隔（分钟）。
     */
    const checkpointsPassed = (elapsedMs, base, gap) => {
      let total = base * MINUTE_MS
      let k = 0
      // 上界：total = S + k·gap ≥ k·min(S, gap)，故 k 到 ceil(elapsed/min(S,gap)) + 1
      // 时 total 必已超过 elapsed，循环一定在更早处 break。取 +2 留一格余量。
      // 这里不能用 S 当步长：S 很大时 gap = S/2 远小于 S，按 S 估的上界会把循环
      // 提前掐断，返回一个偏小的 k——那正是「明明过了点却没拦」。
      const limit = Math.ceil(elapsedMs / (Math.min(base, gap) * MINUTE_MS)) + 2
      while (k < limit) {
        if (total > elapsedMs) break
        k += 1
        total += gap * MINUTE_MS
      }
      return k
    }

    const sendJson = (res, status, payload) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(payload))
    }

    /**
     * 武装端点：客户端按钮在提交前调用，把分钟数交给本会话。
     * 复用 composition 的 connection 服务做信任栅栏（Host/Origin 与登录令牌），
     * 与会话无关的调用者拿不到任何东西。
     */
    const readBody = (req) => new Promise((resolve, reject) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 4096) reject(new Error('body too large'))
      })
      req.on('end', () => resolve(raw))
      req.on('error', reject)
    })

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: ARM_PATH,
      handler: async (req, res) => {
        // 信任栅栏：与 open-in-app 等宿主路由同一套校验。
        const connection = Reflect.get(ctx, 'connection')
        const rejection = connection === undefined ? undefined : connection.requestRejection(req)
        if (rejection !== undefined) {
          res.statusCode = rejection
          res.end()
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('allow', 'POST')
          res.end()
          return
        }
        let payload
        try {
          payload = JSON.parse((await readBody(req)) || '{}')
        } catch (error) {
          sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' })
          return
        }
        const minutes = payload === null || typeof payload !== 'object' ? undefined : payload.minutes
        if (!Number.isSafeInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
          sendJson(res, 400, { ok: false, message: '起拦时间需在 ' + MIN_MINUTES + ' 到 ' + MAX_MINUTES + ' 分钟之间' })
          return
        }
        const sessionId = payload.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          sendJson(res, 400, { ok: false, message: '缺少 sessionId' })
          return
        }
        // 用 agents 注册表按 id 找活跃会话：session/created 只在创建时触发，
        // 对「已在运行」的会话永远不补发，靠它登记会漏掉绝大多数情况。
        const agents = ctx.get('agents')
        const agent = agents === undefined ? undefined : agents.get(sessionId)
        const session = agent === undefined ? undefined : agent.session
        if (session === undefined) {
          sendJson(res, 404, { ok: false, message: '会话未就绪：' + sessionId })
          return
        }
        // 间隔随起拦时间一次性算定并随武装一起存下：拦截路径上不该反复推导同一常量。
        const gap = gapOf(minutes)
        armed.set(session, { minutes: minutes, gap: gap, edited: false, consumed: 0, served: 0, lastStage: -1, pending: false })
        // 武装即起算。不这么做的话，在「回合已跑了一会儿」时点按钮，基准仍是该回合的
        // 起点，模型的下一次调用会被立刻拦下——用户刚设定的起拦时间形同虚设。
        // 随后的 turn/start 会把基准重新对齐到新回合的起点，只会让窗口更长，不会更短。
        idleBase.set(session, Date.now())
        sendJson(res, 200, { ok: true, minutes: minutes, gap: gap })
      },
    }), 'idle-guard: POST ' + ARM_PATH)

    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') {
        // 每个回合开启时把基准对齐到会话计时，并让三阶段从头开始：
        // 新回合是新任务，上一回合的升级不该继承过来。
        idleBase.set(session, event.time)
        const state = armed.get(session)
        if (state !== undefined) {
          state.edited = false
          state.consumed = 0
          state.served = 0
          state.lastStage = -1
          state.pending = false
        }
        return
      }
      // 回合结束即解除武装：武装只对发起它的那一轮负责，不泄漏到后续回合。
      if (event.type === 'turn/end') {
        armed.delete(session)
        return
      }
      if (event.type !== 'step/end') return
      // 结算整个批次：本步内所有非落盘调用都已被拒，此刻才推进计数器，
      // 否则同批其余调用会因「已消费」而全部放行。
      const state = armed.get(session)
      if (state === undefined) return
      if (!state.pending) return
      state.pending = false
      // 本批次确实送出过一次拦截：送达计数加一，同时把时钟已越过的检查点一并消费掉。
      state.lastStage = stageOf(state.served)
      state.served += 1
      const since = idleBase.get(session)
      if (since !== undefined) {
        state.consumed = checkpointsPassed(Date.now() - since, state.minutes, state.gap)
      }
    }, { global: true })

    ctx.on('tools/pre-execute', (exec, next) => {
      const agent = exec.agent
      const session = agent === undefined ? undefined : agent.session
      if (session === undefined) return next()

      const state = armed.get(session)
      if (state === undefined) return next()

      if (EDIT_TOOLS.has(exec.name)) {
        // 落盘达成一次产出：记住「已经落过盘」，把计时从此刻重新起算，并解除第三阶段的
        // 闩锁、退回第一阶段——一次落盘就是本规则要的结果，压力理应全部释放。
        // 武装本身保留到回合结束：本规则是逐阶段拦截，不是「落盘一次即解封」，
        // 否则模型写一行就再也不会被拦。
        state.edited = true
        state.consumed = 0
        state.served = 0
        // lastStage 必须一并复位。它记的是「上一次拦截用的是哪个阶段」，落盘后阶梯
        // 已经回到第一阶段，留着旧值会让「阶段二连拦两次」的判据误命中，落盘刚过
        // 就立刻再吃一次严厉拦截——落盘等于没落。
        state.lastStage = -1
        state.pending = false
        idleBase.set(session, Date.now())
        return next()
      }

      const since = idleBase.get(session)
      if (since === undefined) return next()
      const minutes = Math.floor((Date.now() - since) / MINUTE_MS)
      const stage = stageOf(state.served)

      // 第三阶段是闩锁：不再看时钟，每一次非落盘调用都拒，直到出现一次落盘。
      if (stage >= WARNINGS.length - 1) {
        state.pending = true
        return Promise.resolve({ kind: 'deny', reason: reasonFor(state, minutes) })
      }

      // 前两阶段由时间曲线放行：时钟越过了尚未消费的检查点才拦。
      // consumed 只在 step/end 推进，所以同批的其余调用会看到同一个 consumed，
      // 一起被拒——批次漏洞就是这么堵住的。
      const passed = checkpointsPassed(Date.now() - since, state.minutes, state.gap)
      if (passed > state.consumed) {
        state.pending = true
        return Promise.resolve({ kind: 'deny', reason: reasonFor(state, minutes) })
      }

      // 第二阶段要「连拦两次」，而第二次**不占新的检查点**——否则得等到下一个检查点，
      // 那就不叫连拦了。条件是「上一次拦截已经用的是严厉级，且本阶段还没送满」，
      // 而不是「served 到了某个数」：软拦截结算完 served=1，若按计数判断就会在
      // T(2) 之前提前开出严厉级。
      if (state.lastStage === 1 && state.served < TERMINAL_SERVED) {
        state.pending = true
        return Promise.resolve({ kind: 'deny', reason: reasonFor(state, minutes) })
      }

      return next()
    })
  },
}
`

const IDLE_ARM_HOST_CODE = `// idle-arm 宿主半边。
//
// 它本身不做任何事：落盘拦截的规则与武装端点全部在 ~/.dsh/plugins/idle-guard.js
// 里（POST /idle-arm/arm）。这个包存在的唯一理由是它的客户端半边需要一个
// package.json 才能被 dsh-client-modules 定位（clientExportOf 读 exports["./client"]）。
//
// 为什么不把 package.json 放在 ~/.dsh/plugins/ 根：client-modules 的 nearestPackage
// 是从模块路径向上找最近的 package.json，根上的那一份会让同级所有插件都被误认为
// 声明了同一个客户端 bundle。独立子目录把这份声明精确地限制在本插件上。
export const name = 'dsh-plugin-idle-arm'
export const inject = []

export function apply() {}
`

// 2. 将插件代码写入 ~/.dsh/plugins/
const creativeWorkflowPath = path.join(PLUGINS_DIR, 'creative-workflow.js')
fs.writeFileSync(creativeWorkflowPath, CREATIVE_WORKFLOW_CODE, 'utf8')
console.log(`[plugins] 已生成创作工作流插件: ${creativeWorkflowPath}`)

const reflectCommandPath = path.join(PLUGINS_DIR, 'reflect-command.js')
fs.writeFileSync(reflectCommandPath, REFLECT_COMMAND_CODE, 'utf8')
console.log(`[plugins] 已生成复盘压缩插件: ${reflectCommandPath}`)

const hotreloadMeterPath = path.join(PLUGINS_DIR, 'preset-hotreload-and-meter.js')
fs.writeFileSync(hotreloadMeterPath, PRESET_HOTRELOAD_AND_METER_CODE, 'utf8')
console.log(`[plugins] 已生成预设热重载插件（上下文计量投影部分已移除）: ${hotreloadMeterPath}`)

const exploreCommandPath = path.join(PLUGINS_DIR, 'explore-command.js')
fs.writeFileSync(exploreCommandPath, EXPLORE_COMMAND_CODE, 'utf8')
console.log(`[plugins] 已生成项目探索插件: ${exploreCommandPath}`)

const idleGuardPath = path.join(PLUGINS_DIR, 'idle-guard.js')
fs.writeFileSync(idleGuardPath, IDLE_GUARD_CODE, 'utf8')
console.log(`[plugins] 已生成闲置落盘警告插件: ${idleGuardPath}`)

// idle-arm 是「宿主半边 + 客户端半边」的双面插件，因此必须是一个真正的包目录：
// dsh-client-modules 靠 package.json 的 exports["./client"] 定位客户端 bundle，
// 而 nearestPackage 是向上找最近的 package.json，所以这份声明只能放在自己的子目录里，
// 不能放到 plugins/ 根（否则同级四个插件都会被误认为共用同一个客户端 bundle）。
const IDLE_ARM_DIR = path.join(PLUGINS_DIR, 'idle-arm')
const IDLE_ARM_PKG = path.join(IDLE_ARM_DIR, 'package.json')
const IDLE_ARM_HOST = path.join(IDLE_ARM_DIR, 'lib', 'index.js')
const IDLE_ARM_CLIENT = path.join(IDLE_ARM_DIR, 'lib', 'client.js')
fs.mkdirSync(path.join(IDLE_ARM_DIR, 'lib'), { recursive: true })
// package.json 与客户端 bundle 是手写资源（内容在仓库里，见 plugins/idle-arm/），脚本不生成也不覆盖。
// 宿主半边则相反：它的内容就在上面那个 IDLE_ARM_HOST_CODE 里，属于生成物，必须每次覆写。
// 早先这里用的是 existsSync 守卫，结果模板改了、磁盘上那份没跟着改，注释里还留着
// 早已不存在的 /idle-arm 命令——生成物一旦有「只在缺失时写」的守卫就会这样悄悄漂移。
fs.writeFileSync(IDLE_ARM_HOST, IDLE_ARM_HOST_CODE, 'utf8')

/**
 * 校验 idle-arm 的双面声明是否真的成立。
 *
 * 只检查文件存在是不够的：客户端半边要靠 package.json 的 dsh.client + exports["./client"]
 * 才会被 dsh-client-modules 装配，而 bundle 里 `__ModuleLoader__.load({ id })` 的 id
 * 又必须严格等于 package.json 的 name（client-modules 会拿 manifest 里的 id 去比对，
 * 不一致就报「loaded without registering」）。这两处任何一处错位，结果都是按钮
 * 静默不出现——脚本却照样打印「部署成功」。所以这里逐条验到契约层面，任一不满足即
 * 以非零码退出，绝不把「界面缺了一块」伪装成成功。
 * @returns 校验发现的问题列表（空数组表示全部通过）。
 */
function verifyIdleArmBundle() {
    const problems = []
    if (!fs.existsSync(IDLE_ARM_PKG)) {
        problems.push(`缺少 ${IDLE_ARM_PKG}`)
        return problems
    }
    if (!fs.existsSync(IDLE_ARM_CLIENT)) {
        problems.push(`缺少 ${IDLE_ARM_CLIENT}（客户端半边不存在，提交键旁的按钮不会出现）`)
        return problems
    }
    let manifest
    try {
        manifest = JSON.parse(fs.readFileSync(IDLE_ARM_PKG, 'utf8'))
    } catch (error) {
        problems.push(`${IDLE_ARM_PKG} 不是合法 JSON: ${error.message}`)
        return problems
    }
    const name = manifest.name
    if (typeof name !== 'string' || name.length === 0) problems.push(`${IDLE_ARM_PKG} 缺少 name`)
    if (manifest?.dsh?.client?.platform !== 'web') problems.push(`${IDLE_ARM_PKG} 的 dsh.client.platform 必须是 'web'`)
    const clientExport = manifest?.exports?.['./client']
    const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
    if (typeof clientRel !== 'string' || clientRel.length === 0) {
        problems.push(`${IDLE_ARM_PKG} 的 exports["./client"] 未指向客户端 bundle`)
    } else if (!fs.existsSync(path.join(IDLE_ARM_DIR, clientRel))) {
        problems.push(`${IDLE_ARM_PKG} 的 exports["./client"] 指向不存在的文件: ${clientRel}`)
    }
    // bundle 注册的 id 必须与包名一致，否则 client-modules 直接判为「loaded without registering」。
    const registered = /__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/.exec(fs.readFileSync(IDLE_ARM_CLIENT, 'utf8'))
    if (registered === null) {
        problems.push(`${IDLE_ARM_CLIENT} 未按 window.__ModuleLoader__.load({ id, factory }) 形式注册`)
    } else if (name !== undefined && registered[1] !== name) {
        problems.push(`bundle 注册 id「${registered[1]}」与 package.json name「${name}」不一致（client-modules 会拒绝装配）`)
    }
    return problems
}

const idleArmProblems = verifyIdleArmBundle()
if (idleArmProblems.length > 0) {
    for (const problem of idleArmProblems) console.error(`  [idle-arm] ${problem}`)
    console.error('  [idle-arm] 双面声明不完整：界面按钮不会出现（宿主端点 /idle-arm/arm 仍可用）。请从仓库恢复 plugins/idle-arm/。')
    process.exitCode = 1
} else {
    console.log(`[plugins] idle-arm 双面插件就位: ${IDLE_ARM_DIR}`)
}

// 3. 自建预设迁移：把旧版目录预设转成声明式预设
//    官方已彻底移除对 ~/.dsh/.agent-presets/<id>/ 目录的读取（官方 skill
//    `editing-cordis-compositions` 原文：Nothing reads that directory any more）。
//    现在一个预设就是一条 `@deepseek-ai/dsh-agent-preset` 声明行，config 为
//    { id, name, description, order, plugins }，plugins 即旧 agent.cordis.yml 的条目列表。
//    本阶段按官方迁移口径逐目录转换：
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

    const blocks = []
    for (const id of ids) {
        const presetDir = path.join(LEGACY_PRESETS_DIR, id)
        const meta = readPresetMeta(path.join(presetDir, 'preset.yml'))
        const rawBody = fs.readFileSync(path.join(presetDir, 'agent.cordis.yml'), 'utf8').replace(/\r\n/g, '\n')
        const body = relocateRelativeAssets(id, presetDir, rawBody)

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
        '# 旧目录预设不再被读取：每个目录在此转成一条声明行，',
        '# name/description/order 取自 preset.yml，plugins 为 agent.cordis.yml 的原样内联；',
        '# 相对资源已复制到 profiles/web/preset-assets/<id>/ 并改写引用。',
    ].join('\n')
    return { text: `${header}\n- insert:\n${blocks.join('\n\n')}\n`, count: ids.length, ids }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3.5 旧版 settings.yaml 迁移（「设置」改存 profile 补丁）
//
// dsh-settings 只在启动时把 ~/.dsh/settings.yaml 一次性导入——先改名为
// settings.yaml.imported，再逐 section 写进「同名 Loader 条目」的 config；且它只接受
// 声明为 volatile 的字段（write() 里三道拒绝：无同名条目 / 无 volatile 字段 /
// 该字段非 volatile）。导入不成的 section 只打一条警告，值就永远留在 .imported 里，
// 网页端自然读不到。
//
// 本阶段用同一套旧名映射把「补丁层能表达」的部分直接写进 profile patch：
//   - 有同名条目的 section → 生成 `- id: <条目>` + `config:` 行。补丁层不区分
//     volatile（volatile 只约束「不重挂就能改」的在线编辑），静态 config 一律生效，
//     因此覆盖面比官方导入更全（例如 ui-theme 的 preference 也能落回来）；
//   - 无同名条目的 section → 打印丢弃原因，值仍保留在 legacy 文件里，不静默消失。
// 幂等：补丁里已存在同名顶层条目的 section 一律跳过，网页端后续的修改不会被覆盖。
// ─────────────────────────────────────────────────────────────────────────────

const LEGACY_SETTINGS_SOURCES = [
    path.join(DSH_ROOT, 'settings.yaml'),
    path.join(DSH_ROOT, 'settings.yaml.imported'),
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
 * 把 legacy 文档归一化成「待迁移条目」清单。
 *
 * 两种历史形状都必须认：
 *   - 顶层数组：每项已是一条完整的 Loader 条目 `{ id, name?, config? }`，
 *     条目 id 直接可用，不经旧名映射；
 *   - 更早的 section 映射：`{ <section>: <values> }`，section 名经
 *     LEGACY_SECTION_ENTRIES 映射成现行条目 id。
 *
 * 只认数组会漏掉旧文件；只认映射则会把新文件解析成【名为 "0" 的 section】并整段
 * 丢弃——settings.yaml 里那份 provider（网关）配置因此从未被迁移过，而第 5 步又已
 * 把它从补丁里截掉，于是每次运行都净损失一段设置。
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

/** 读取 legacy 设置文档；settings.yaml 优先，其次 .imported。 */
function readLegacySettings() {
    const source = LEGACY_SETTINGS_SOURCES.find((file) => fs.existsSync(file))
    if (source === undefined) return { source: undefined, items: undefined }
    const yaml = yamlModule()
    if (yaml === null) {
        console.warn('  [settings] 未找到可用的 YAML 实现（yaml / js-yaml），跳过 legacy 设置迁移')
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
 * 把补丁正文切成三段：托管区块之前的正文、托管区块之外的顶层条目、上一版 legacy 区块原文。
 *
 * 托管区块只包含本脚本生成的顶层条目，边界是确定的：
 *   - legacy 设置区块：`- id: <条目>` 若干条，止于预设标记或文件末尾；
 *   - 预设声明区块：恰好一条 `- insert:`，正文全部缩进，止于下一个顶层行。
 *
 * 为什么必须单独摘出「托管区块之外的顶层条目」：官方设置编辑器
 * （dsh-settings 的 configEditor）把用户条目【追加到文件末尾】，即落在预设标记之后。
 * 旧实现「从第一个托管标记截断到文件末尾」会把这些条目一并抹掉，重建时又不会写回，
 * 于是每次运行都静默删除一段用户配置（实测：provider 网关配置被连删两次）。
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
        console.warn(`  [settings] 无法读取 profile「${profileName}」的组合（--dump-config 失败），跳过 legacy 设置迁移`)
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
 * 生成 legacy 设置迁移区块（含起始标记）。
 * @param patchContent - 已摘除上一版托管区块的补丁正文。
 * @param profileName - 目标 profile 名。
 * @returns 区块文本与三段清单（已迁移 / 跳过 / 丢弃）。
 */
function buildLegacySettingsBlock(patchContent, profileName) {
    const empty = { text: '', imported: [], skipped: [], dropped: [], unavailable: false }
    const legacy = readLegacySettings()
    if (legacy.items === undefined) return empty
    if (legacy.items.length === 0) return empty

    const entryIds = loadProfileEntryIds(profileName)
    // 拿不到条目清单 = 无法判断「profile 里有没有同名条目」，此时重建结果不可信。
    // 显式标记出来，交给调用方决定回填旧内容而不是当成「没有可迁移项」。
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
        '# settings.yaml 不再是生效源：设置一律存在本 profile 补丁里。',
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

    // 清除旧的空数组占位符与废弃标记
    patchContent = patchContent.replace(/^\s*\[\s*\]\s*$/gm, '').trim()

    const absCreative = pathToFileURL(creativeWorkflowPath).href
    const absReflect = pathToFileURL(reflectCommandPath).href
    const absHotreload = pathToFileURL(hotreloadMeterPath).href
    const absExplore = pathToFileURL(exploreCommandPath).href
    const absIdleGuard = pathToFileURL(idleGuardPath).href
    const absIdleArm = pathToFileURL(IDLE_ARM_HOST).href

    // 1. 不在 host 层启用 compaction-basic（同时自愈：删除旧版本脚本注入的那一行）。
    //    dsh-web-app bundle 明确把该 host 行置为 disabled，压缩后端整体下沉到
    //    agent preset：standard 预设在自己的 isolate 组里挂载 compaction-basic /
    //    command-compact / tool-result-pruner。若 host 层再挂一个引擎，由于其 auto 默认为
    //    true（会注册 agent/pre-step 自动压缩），将与预设实例对同一会话重复触发压缩，
    //    抢占会话级压缩锁（busy）并重复消耗摘要 token。
    //    /reflect 的自动压缩不依赖 host 行：它通过 agentPresets.serviceFor(agent, 'compaction')
    //    解析到预设内的压缩实例。
    //    匹配用「行首 + 2 空格缩进」精确锁定顶层条目：旧版脚本是 prepend，但文件自带的注释
    //    行排在更前面，所以这一行并不在文件开头；而 insert 列表里的同名条目缩进为 4 空格，
    //    不会被误删。
    //    末尾的 \n? 是必需的：这一行可能是文件的最后一行（后面没有换行符）。
    const legacyCompactionPattern = /(^|\n)- id: compaction-basic\n  disabled: false\n?/
    if (legacyCompactionPattern.test(patchContent)) {
        patchContent = patchContent.replace(legacyCompactionPattern, '\n').replace(/\n{3,}/g, '\n\n').trim()
        console.log('  [profile] 已移除旧的 host 层 compaction-basic 启用行（压缩后端由 agent preset 提供）')
    }

    // 挂载位置：托管区块（legacy 设置 / 预设声明）必须固定位于文件末尾，因此新条目
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

    // 4. 挂载预设热重载与上下文计量修正插件
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

    // 5. 重建托管区块（legacy 设置迁移 + 自建预设声明）：两段都固定位于文件末尾，
    //    先按标记整体截断、再按固定顺序重建，因此天然幂等。
    //
    //    注意：截断前必须先留存「现有的 legacy 区块原文」。因为 legacy 区块的重建依赖
    //    `dsh --dump-config`（用于确认 profile 里存在同名条目），而该调用在受限环境下
    //    可能失败（沙箱拒绝子进程、dsh 升级中、profile 损坏等）。一旦失败，
    //    buildLegacySettingsBlock() 会返回空文本——若此时已经把它截掉，这一段设置
    //    （provider 列表、默认模型、主题等）就会从补丁里凭空消失，属于静默数据丢失。
    //    因此失败时原样回填，宁可保留旧内容也不丢。
    //
    //    另一个必须守住的边界：托管区块【只包含本脚本生成的顶层条目】，而官方设置
    //    编辑器会把用户条目追加到文件末尾（即落在预设标记之后）。因此摘除必须按
    //    「区块」边界精确进行，绝不能从第一个标记一路截到文件末尾——那样会把用户
    //    自己写/网页端写入的条目（例如 provider 网关配置）当成自己的旧版本删掉，
    //    重建时又不会写回，于是每次运行净损失一段配置。
    const managed = splitManagedRegions(patchContent)
    const existingLegacyBlock = managed.legacy
    const foreignEntries = managed.foreign
    if (managed.legacy !== undefined || managed.foreign.length > 0) {
        console.log('  [managed] 已摘除上一版生成的托管区块（legacy 设置 / 预设声明），准备重建')
    }
    patchContent = managed.head
    if (foreignEntries.length > 0) {
        // 托管区块之外的用户条目原样前置保留，绝不被重建吞掉。
        patchContent += `\n\n${foreignEntries}`
        console.log(`  [managed] 保留托管区块之外的用户条目 ${foreignEntries.split('\n').filter((line) => /^- /.test(line)).length} 条`)
    }

    // 5.1 旧版 settings.yaml 迁移（详见上方「4. 旧版 settings.yaml 迁移」一节）
    const legacySettings = buildLegacySettingsBlock(patchContent, PROFILE_NAME)
    if (legacySettings.text.length > 0) {
        patchContent += `\n\n${legacySettings.text.trim()}`
        console.log(`  [settings] 已迁移 ${legacySettings.imported.length} 个 legacy section: ${legacySettings.imported.join('、')}`)
    } else if (legacySettings.unavailable === true && existingLegacyBlock !== undefined) {
        // 重建不可用（多半是 --dump-config 失败），原样回填，绝不让设置凭空消失。
        patchContent += `\n\n${existingLegacyBlock}`
        console.warn('  [settings] 无法重建 legacy 设置区块（--dump-config 不可用），已原样保留现有内容，未做改动')
    } else {
        console.log('  [settings] 无待迁移的 legacy section')
    }
    for (const item of legacySettings.skipped) console.log(`  [settings] 跳过（补丁已有同名条目）: ${item}`)
    for (const item of legacySettings.dropped) console.log(`  [settings] 丢弃（目标 profile 无同名条目，值仍留在 legacy 文件）: ${item}`)

    // 5.2 自建预设声明段
    if (presetDeclarationBlock.text.length > 0) {
        patchContent += `\n\n${presetDeclarationBlock.text.trim()}`
        console.log(`  [presets] 已写入 ${presetDeclarationBlock.count} 个预设声明: ${presetDeclarationBlock.ids.join('、')}`)
    } else {
        console.log('  [presets] 未发现可迁移的目录预设（~/.dsh/.agent-presets/<id>/agent.cordis.yml），跳过')
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
        console.log(`[profile] 已更新 ${CORDIS_PATCH_FILE}（挂载自定义插件 + 重建预设声明，不再改动压缩后端开关）`)
    }
}

// 5. 底层增强补丁全量应用（内嵌幂等执行，无需外置脚本）：
//    - preset-switch：解除非空白会话锁定，会话头部标签升级为可交互下拉菜单；
//    - compaction：压缩阈值改按 surface 计价，压缩指令忽略规则库。
console.log('[installer] 正在执行底层核心补丁全量注入...')

function applyCorePatches(baseDir) {
    if (!fs.existsSync(baseDir)) return

    // 4.1 preset-switch: 后端 agent 预设注册表解除非空白会话限制
    //     包名沿革：dsh-agent-presets（复数）已拆成
    //     dsh-agent-preset（声明插件）与 dsh-agent-preset-registry（`agentPresets` 服务）。
    //     补丁目标的 select() 现位于 dsh-agent-preset-registry/lib/index.js，
    //     仍以 `boundary !== void 0 && (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0)`
    //     的形式出现，因此内层子串替换照旧成立。
    const agentPresetsFile = path.join(baseDir, 'node_modules', '@deepseek-ai', 'dsh-agent-preset-registry', 'lib', 'index.js')
    if (fs.existsSync(agentPresetsFile)) {
        let fileCode = fs.readFileSync(agentPresetsFile, 'utf8')
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
        let fileCode = fs.readFileSync(uiAgentPresetFile, 'utf8')
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

        const headerSeatApplied = fileCode.includes('AgentPresetHeaderSeat')
        if (fileCode.includes(slotTarget)) {
            fileCode = fileCode.replace(slotTarget, slotRep)
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
    //     该形态在 0.2.1-alpha.4 复核未变，compaction-basic 里的三处判断
    //     （两处 return null、一处 return result）仍是原文，补丁锚点全部命中。
    const compactionBasicFile = path.join(baseDir, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js')
    if (fs.existsSync(compactionBasicFile)) {
        let fileCode = fs.readFileSync(compactionBasicFile, 'utf8')
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
        let fileCode = fs.readFileSync(contextMeterFile, 'utf8')

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
    // 同一目录多代并存时取版本最高的一代（低代是迁移前的残留）；`.bak`/临时文件
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

// 收尾横幅必须反映真实结果：前面任何一步设了非零退出码（补丁拒绝落盘、idle-arm 声明不完整等），
// 就不能再喊「全量部署成功」——否则失败被一句祝贺盖住，正是本脚本要消灭的那种静默故障。
console.log('=============================================================')
if (process.exitCode !== undefined && process.exitCode !== 0) {
    console.error(`⚠️  部署未完成：上面有 ${process.exitCode} 号退出码对应的错误，请先处理后再重跑。`)
} else {
    console.log('🎉 恭喜！DSH 全套改进（插件/配置/底层补丁）已全量部署成功！')
}
console.log('=============================================================')