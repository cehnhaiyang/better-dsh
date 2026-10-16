# DSH 维护脚本（`~/.dsh/.js`）迁移与变更历史

本文件记录 `.js` 的基线版本、历次版本迁移的核对结论与已执行的迁移动作。
脚本头部只描述**当前行为**；所有版本沿革与迁移记录以本文件为准。

---

## 当前基线

- 脚本按 **dsh 0.2.1-alpha.4** 的结构维护。
- 维护对象：`~/.dsh/`（可用 `DSH_HOME` 覆盖）与全局安装的 `@deepseek-ai/dsh`。
- 四个底层增强补丁的锚点在 0.2.1-alpha.4 上逐字节命中，补丁逻辑无需改动。

---

## 0.2.0-rc.2 → 0.2.1-alpha.4

已逐项复核，实际差异如下。

### 1. Agent 公开生命周期面收敛（唯一的破坏性变更）

- `agent.phase` 已从公开 `Agent` 接口移除，仅存于 agent-loop 的内部实现。
- 公开面为 `agent.status`（`'idle' | 'running'`）与 `agent.whenIdle()`。
- ⚠ `agent.status` 在维护（maintenance）期间仍报 `'idle'`——官方语义是
  「runMaintenance 执行时 public status stays idle」，因此它无法区分
  「真空闲」与「正在维护」。需要真正静止的判据时必须用 `agent.whenIdle()`。
- 脚本内两处相位判断已随之迁移：
  - reflect 插件的 `waitForIdle`；
  - 热重载插件（preset-hotreload-and-meter）的 `flush`。

### 2. `dsh-web-app` 补丁改为多文件下发

- 除 `cordis.patch.yml` 外，新增 `presets/{standard,ptc,minimal,cordis}.patch.yml`，
  由 `package.json` 的 `dsh.bundle.patch` 按序挂载。
- agent 平面（工具 / 提示词 / 委派）整体下沉到预设；host 层同名行在该 bundle 里显式
  `disabled: true`。
- 自建预设的 `- insert:` 声明写法不受影响：profile 层仍位于 bundle 层之后。

### 3. 未变的结构（复核结论）

- 会话格式仍为 **v4**；header 必填 `isSeeded` / `delegationDepth`，
  可选 `cwd` / `parentSession` / `origin` / `agentPreset`。
- 日志文件名正则 `session(?:\.v([1-9][0-9]*))?\.jsonl` 未变；
  `projectKey()` 与 `encodeSegment()` 的编码规则逐字节未变。
- workspace 存储仍为 `name: "workspace", version: 2`。
- `settings.yaml` 的一次性导入行为未变：`profile.home` 仍解析为 `~/.dsh`，
  导入后原文件改名为 `settings.yaml.imported`，且只接受 volatile 字段。
- `@deepseek-ai/dsh-agent-preset` 的 Config schema 仍为
  `{ id, name, description, order, plugins }`，与脚本生成格式一致。
- `tokenMeter.measure()` 的返回形态未变，仍为
  `{ logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes }`。

---

## 0.1.7 → 0.2.0（在 0.2.1-alpha.4 复核仍成立）

- 会话格式升到 v4（消息内容块扁平化，header 增补 `isSeeded` / `delegationDepth`）。
- 交互式预设选择器由会话头部搬到新会话首屏 `conversation.hero.agentPreset`，
  头部标签退化为只读——由脚本第 5 节的 4.2 号补丁在头部恢复交互面。
- profile 补丁层之上新增家目录层 `~/.dsh/cordis.patch.yml`：同 id 条目以家目录层为准，
  本脚本不创建、不改写它。

---

## 0.1.6 → 0.1.7（在 0.2.1-alpha.4 复核仍成立）

- 预设改为声明式行。
- `dsh-agent-presets`（复数）拆分为 `dsh-agent-preset`（声明插件）+
  `dsh-agent-preset-registry`（`agentPresets` 服务）。
- `~/.dsh/.agent-presets/<id>/` 目录不再被任何代码读取。
- profile patch 改由 dsh-hmr 原生热重放。
- compact 后端下沉到 agent preset：预设的 isolate 组内挂载
  `compaction-basic` / `command-compact` / `tool-result-pruner`；
  `dsh-web-app` bundle 明确把 host 层同名行置为 `disabled`。

---

## 本轮迁移（2026-10-16，0.2.0-rc.2 → 0.2.1-alpha.4）

### 对 `.js` 实际执行的改动

1. 头部基线版本注释由 `0.2.0-rc.2` 更新为 `0.2.1-alpha.4`。
2. `agent.phase` → 公开 API：
   - reflect 插件 `waitForIdle`：轮询 `agent.phase.kind` → `agent.whenIdle()` + 超时竞争；
   - 热重载插件 `flush`：`agent.phase.kind` → `agent.status` 预筛 + `whenIdle()` 即时探测
     （50ms 等待窗，等不到按「忙」处理，语义与原先一致：忙的会话本次跳过重绑）。
3. 同步更新压缩计量与热重载插件的版本复核注释。
4. 版本沿革从脚本头部迁出，集中到本文件。
5. 清理脚本内冗余注释（外层文档块与插件内部注释重复的部分、头部与实现处重复的条目）。

### 移除会话管理图形界面（`--console`）

会话改由 dsh 网页端管理，不再单独开界面。删除范围：

- `~/.dsh/session-console.html` 页面文件（已从版本库删除）；
- 脚本内的 `--console` / `--console-port` 入口分流与 `SESSION_CONSOLE_FILE` 常量；
- 菜单第 3 项「打开会话管理界面」；
- HTTP 服务整段：`buildConsolePayload` / `readJsonBody` / `sendJson` /
  `startSessionConsole` / `resolveConsoleSessionPath`；
- 仅供界面使用的 `readCachedTitle`（投影缓存读标题）。

保留：命令行菜单第 1 项（管理会话）、`--list`、以及 `moveSession` /
`deleteSessionDir` / `loadProjectEntries` / `detectRunningDsh` / `probeSessionLock`
等被 CLI 复用的实现——图形界面原本只是这些实现的第二层调用方。

### 验证方式与结论

- **补丁锚点**：四个补丁的锚点在 0.2.1-alpha.4 上逐字节比对命中。
- **补丁产物**：把四个补丁实际应用到真实文件的副本上，`node --check` 全部通过，
  证明补丁产出的代码语法合法。
- **幂等**：`node .js --apply` 连续运行两次；第二次全部报「已处于目标状态」，
  `profiles/web/cordis.patch.yml` 与生成的插件文件字节级一致，安装目录内四个被打补丁的
  模块 md5 不变。
- **实际启动**：启动 dsh 0.2.1-alpha.4 的 Web profile 正常监听；
  `--dump-config` 输出 201 个顶层条目，7 个自建预设与 6 个自定义插件全部挂载。
- **客户端补丁**：抓取运行时下发的 `dsh-client-ui-agent-preset` 与
  `dsh-client-ui-conversation` 两个 bundle，4.2 号补丁的 `AgentPresetHeaderSeat`
  与 4.4 号补丁的 `dshMeterShown` 标记确实存在。

### 已知副作用（非脚本缺陷）

- 首次实际启动会触发 dsh 官方的 `settings.yaml` 一次性导入，把 `~/.dsh/settings.yaml`
  改名为 `settings.yaml.imported`。这是官方行为，脚本的 legacy 迁移同时读取这两个路径，
  因此不受影响。

## 逐条核对 dsh 0.2.1-alpha.4 源码的实现审计

对照安装目录里 alpha.4 的实际源码（含 `.d.ts` 公开契约）逐项核对脚本的全部实现，
结论与处置如下。

### 核对通过（未做改动）

- **路径编码**：`encodeProjectKey` / `encodeSegment` 与
  `dsh-session-persistence-jsonl` 的 `projectKey()` / `encodeSegment()` 逐字符等价。
  以真实磁盘数据做差分测试：59 个会话目录的 `projectKey(cwd)` 与 `encodeSegment(id)`
  全部与实际目录名一致，0 处不符。
- **日志格式**：`SESSION_LOG_PATTERN` 与 `dsh-session-format` 的
  `CANONICAL_LOG_FILENAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/u` 及 `.zstd` 后缀
  规则一致；「取版本最高的一代」与 `resolveGenerationInDirectory` 的语义一致。
- **zstd 帧扫描**：`scanZstdFrames` 与官方同名函数逐分支等价（魔数、保留位、块类型
  保留值、contentSize 宽度、checksum 尾 4 字节）。对 64 个真实压缩日志验证：首帧
  均为「恰好一行 header」，0 个 torn 尾帧，解压与 JSON 解析 0 错误。
- **移动引擎前置条件**：`rewriteHeaderLine` 的「无损往返才改写」判据在 64 个真实
  header 上 100% 通过；`rewriteLogHeaderCwd` 要求「第 0 帧恰好一行」与官方
  `assertZstdHeaderFrame` 的判据一致。
- **写锁探测**：具名内核信号量名
  `Local\dsh-session-lock-<sha256(小写化绝对路径)>` 与官方
  `acquireLockHandleWin32` 完全一致；锁文件名 `session.lock` 与 `LEASE_FILENAME` 一致。
- **workspace 注册表**：`unit: { name: 'workspace', version: 2 }`、global 五字段
  （`initialized` / `defaultWorkspaceId` / `workspaceIds` / `archivedSessionIds` /
  `pinnedSessionIds`）与 `workspaceDomainSpec` 一致；`record.path` 必须是
  `fs.realpath` 规范形式，与 `realpathNormalize` 一致。实测 20 条记录的 path
  全部等于 `realpath`；顺序表与表项一一对应、无重复 path、无重复 sessionId，
  `validateStoredState()` 的三条不变量全部满足。
- **legacy 设置映射**：`LEGACY_SECTION_ENTRIES` 与 `dsh-settings` 的同名常量逐项一致
  （`ui-developer-tools`→`ui-settings`、`ui-onboarding`→`ui-settings-general`、
  `shell`→`pwsh-sandbox`/`bash-sandbox`）；四个目标条目 id 在 `--dump-config`
  输出中确实存在。
- **Agent 公开面**：`dsh-agent` 的 `runtime-types.d.ts` 里公开面就是
  `agent.status`（`'idle' | 'running'`）与 `agent.whenIdle()`；`phase` 只作为
  `dsh-agent-loop` 的 `private` 字段存在。脚本两处判断用的正是公开面。
  `runMaintenance` 的注释也确认「维护期间 public status stays idle」，因此
  `quiescentNow` 用 `whenIdle()` 而非 `status` 是必需的。
- **会话事件与消息契约**：`session/event(session, event)`、`events[i].time`、
  `turn/start|turn/end|step/end`、`user/message`、`session/title` 的 payload 形状
  与脚本读取方式一致。`agent.steer(UserMessage)` 的 `source: { kind, form: 'notice',
  summary }` 合法（`ContextForm` 明确含 `notice`）。全量日志实测出现
  `plugin:creative-workflow-modes`、`plugin:command-reflect` 两种自定义 source kind
  与 `notice` form，证明运行期接受。
- **服务契约**：`commands.register(definition)` 的 `name`/`description`/`input.hint`/
  `handler({ agent, rawInput, commandId })` 与返回 `{ kind: 'success' | 'error', text }`
  全部匹配 `dsh-commands` 的 `.d.ts`；`systemPrompt` 的
  `system-prompt/assemble(assembly, context, next)` waterfall、`AssembleContext.agent`、
  `PromptAssembly.sections[].{name,text}` 匹配 `dsh-system-prompt` +
  `dsh-agent` 的模块扩展；`webServer.register({ kind: 'exact', path, handler })` 与
  `connection.requestRejection(req) → 401|403|undefined` 匹配
  `dsh-host-webserver` / `dsh-client-connection`（与官方 `open-in-app` 的信任栅栏
  写法逐行同构）；`tools/pre-execute` 的返回 `{ kind: 'deny', reason }` 与
  `PreToolDecision` 一致，`exec.{ name, arguments, agent }` 字段名一致。
- **agentPresets 服务**：`recompose(ctx, id)`、`composedPreset(ctx)`、
  `serviceFor(agent, name)` 三个方法在 `dsh-agent-preset-registry` 的 `.d.ts` 与实现中
  都存在且签名一致；`compaction.compactNow(agent, signal, commandId)` 与
  `CompactionResult.{ shadowedSeqs, shadowedTokenCount }` 匹配 `dsh-compaction`。
- **预设声明模型**：`PresetDefinition.{ id, name?, description?, order?, plugins }`
  与脚本生成的声明段字段完全一致；旧目录预设确实不再被读取。
- **热重载信号**：`loader/entry-init(entry)` 存在（`cordis-plugin-loader`），
  `entry.options.id` 可用；`dsh-hmr` 确实监听
  `[profile.patchPath, join(profile.home, 'cordis.patch.yml')]` 这两个文件，
  与插件的 `watchedFiles` 完全对应。
- **上下文计量**：`TokenMeasurement` 确有 `totalTokens` 与 `surfaceTokens` 两个字段，
  `contextBreakdown` 投影确有 `systemTokens` / `toolsTokens` / `messageTokens`；
  4.4 号补丁依赖的 `ROWS` 三个 key 与 `context.usedTokens` 在 bundle 中确实存在。
- **存储布局**：`storages/workspace.json` 是 `single` 布局整文档，
  `storages/session_projcache/sessions/<id>.json` 是 `per-record` 布局；
  id 满足 `SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/`，脚本拼路径的方式正确。
- **补丁锚点**：4.1 / 4.2 / 4.3 / 4.4 四组锚点在当前安装目录中均已处于「已应用」
  状态；把每个替换反向还原后，原始目标串逐字节重现，证明锚点在 alpha.4 上仍精确命中。
  其中 4.3 的压缩指令行在当前版本里已是官方原文，脚本的 `includes` 判据正确识别为
  「已处于目标状态」，不会重复插入。

### 修正的缺陷

- **删除会话时未清理投影缓存（真实缺陷，已修）**：原先只有 `--console` 图形界面
  的删除路径会调用 `deleteSessionDir()` 清掉
  `storages/session_projcache/sessions/<id>.json`；删除图形界面后，命令行菜单的两条
  删除路径（删单个会话、删整个目录）只做了 `rmSync` + `pruneWorkspaceState()`，
  **不再清理投影缓存**，`deleteSessionDir` 也随之变成 0 引用的死代码。
  处置：删掉死函数，新增职责单一的 `removeProjectionCache(sessionIds)`，两条删除
  路径都传入实际删除的 id 列表；同时去掉报告里原本只在图形界面存在的缓存计数缺口。
  另外，删目录时原来「头读不出来就静默跳过该 id」会让缓存清理漏项，现按
  `decodeSegment()`（`encodeSegment` 的严格逆运算）从目录名还原真实 id 兜底。

### 未改动但值得记录的两点

- `plugins/idle-arm/package.json` 与 `lib/client.js` 是脚本刻意不覆盖的手写资源
  （脚本只在缺失时告警）。当前磁盘上这两份确实缺失，因此 idle-arm 的客户端半边
  （提交键旁的按钮）不会出现，宿主半边的 `POST /idle-arm/arm` 仍正常注册。
  这是既有状态，不属于本次迁移范围。
- `.agent-presets/create/创作准则（无限制版）.md` 在工作区里处于已删除状态。核对了
  脚本全部文件系统调用：只有会话目录、临时文件与生成物被写/删，**没有任何**删除
  preset `.md` 的代码；该文件也不被任何 `agent.cordis.yml` 引用，与脚本行为无关。

