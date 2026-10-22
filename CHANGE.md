# DSH 维护脚本（`~/.dsh/.js`）迁移与变更历史

本文件记录 `.js` 的基线版本、历次版本迁移的核对结论与已执行的迁移动作。
脚本头部只描述**当前行为**；所有版本沿革与迁移记录以本文件为准。

---

## 当前基线

- 脚本按 **dsh 0.2.1-rc.2** 的结构维护。
- 维护对象：`~/.dsh/`（可用 `DSH_HOME` 覆盖）与全局安装的 `@deepseek-ai/dsh`。
- 四个底层增强补丁的锚点在 0.2.1-rc.2 上逐字节命中，补丁逻辑无需改动。

---

## typecheck / test / node 合并为单一 `js` 工具，新增 build 动作

### 改法

- `tools.js` 里的 `typecheck`、`test`、`node` 三个工具合并为一个 `js` 工具，用
  `action` 四选一：`check` / `node` / `test` / `build`。命令、参数与工作目录仍是本文件
  的常量，模型能给的只有「做哪件事」与「对哪个路径」，可注入面没有变大。
- `build` 是新动作：在工作区根目录跑 `npm run build`；`project` 传相对路径则改在该
  子项目目录里跑。路径过 `resolveInside`（`allowRoot: true`，省略即构建本体）。
- `paths` 只对 `action=node` 有效，`project` 只对 `action=build` 有效；给错动作当场
  报错，而不是默默换个对象跑一遍。
- 三处重复的「Windows 上 .cmd 垫片必须借 cmd.exe」抽成共用基础设施
  `runShellCommand`（原先 `typecheck` 的兜底路径与 `test` 各写了一遍）。
- `TOOL_NAMES` 因此从六个变成四个（`js` / `git` / `delete` / `browser`）；三个声明了
  自定义工具集的预设（`test`、`ts-build`、`dark-adaptation`）同步改写 `config.tools`，
  `.js` 的校验文案不再写死工具个数。

### 验证方式与结论

以假 `ctx` 收注册项，在临时工作区实跑：`node`（单文件）、`test`、`build`（本体）、
`build`（`project: sub` 子项目）、`build`（`project: ..` 越界拒绝）、`check`（伪造
`node_modules/typescript/bin/tsc`，确认走 `process.execPath` 主路径且参数为
`--noEmit --pretty false`）、`node` 缺 `paths`、`node` 路径不存在、未知 `action`、
`paths` 配给 `test`——十项输出均符合预期。`node .js --apply` 重跑后，profile patch 里
三处 `config.tools` 均为新的四个工具名，9 个预设声明照常生成。

---

## 自定义工具集归一到一份实现，使用范围仍由各预设声明

六个自定义工具（typecheck / test / git_commit / node / delete / browser）原先以
「每个预设自带一份本地插件」的形式存在：`test` 与 `ts-build` 两个预设目录里各有一份
**逐字节相同**的五个文件（typecheck / test / git-commit / node / delete），`browser`
只存在于 `test`。同一份实现存两份，改一处忘一处就是静默的行为分裂。

### 改法

- 六个工具合并为**一个**根目录文件 `~/.dsh/tools.js`（手写资源，脚本只校验不生成）。
- 预设仍然自己声明要用哪几个工具，只是不再带插件文件：

  ```yaml
  - id: custom-tools
    name: 'better-dsh:tools'
    config:
      tools: [typecheck, test, git_commit, node, delete, browser]
  ```

  `better-dsh:tools` 是占位名，`.js` 在生成预设声明时把它改写成 `tools.js` 的本机
  `file://` 绝对路径（DSH_ROOT 可被 `DSH_HOME` 覆盖，写死路径换台机器就静默失效）。
  `config.tools` 是**该预设**要用的工具名，`tools.js` 的 `apply(ctx, config)` 只注册
  这些。于是：实现只有一份，而每个预设的工具集仍由自己说了算。
- `.js` 新增 `verifyToolsBundle()`：改写前核对 `tools.js` 能否加载、是否导出 `apply()`、
  `inject` 是否含 `tools`、`TOOL_NAMES` 里每个工具名是否真的出现在注册调用中；另有
  `checkDeclaredTools()` 核对各预设声明的工具名是否存在（写错名字只会让工具静默变少，
  很难查，所以在部署时就点出来）。

### 为什么必须是「预设声明」而不是「宿主平面全局挂载」

`tools.register()` 把注册写进 `dsh-tools` 的分层作用域表，写进哪一层由**调用方上下文**
决定（`ScopedLayers.effect` → `scopeOf(ctx)`，即 `ctx[kScope]`）：

- 声明在预设 `plugins` 列表里的行，在**那个预设的作用域**里挂载 ——
  `dsh-agent-preset-registry.activate()` 给每个预设铸一个独立的 `createScope`，
  预设的行就挂在这个作用域下。因此该预设的会话看得到，别的预设看不到；
- 挂成 profile 顶层条目（ctx 不带作用域标签）则进入 **global 层**，而
  `ToolRuntime.view(scope)` 以 `this.layers.global.tools.entries()` 为起点组装可见集，
  于是**每个**预设的会话都会继承它。

后一种形态曾在本轮尝试中被采用，是错的：它把 `node` / `delete` / `git_commit` 这类
执行能力强加给所有预设，包括设计上完全不给命令行的文学类预设；而且那样一来「预设声明
自己用什么工具」这句话本身就失去了意义。官方工具走的正是前一条路 —— tool-fs /
tool-goal / tool-ask-user 都是逐个声明在各预设的 `plugins` 里的。

（若真要全局生效，正确写法是 `tools.restrict({ allow/deny })`，但它只在 agent 作用域内
合法、会被 `dsh-tools` 拒于全局调用，且本部署用不上。）

### 附带修掉的两处陈旧残留

- `profiles/web/preset-assets/` 原先只做「缺什么补什么」的增量复制：来源里删掉的资源
  会一直留在 profile 里。现在该目录在生成预设声明前**整棵重建** —— 它完全由
  `.agent-presets/<id>/` 推导得出，删除是安全的。
- `.js` 里新增一段清理：移除历史上曾写进 profile patch 的顶层 `custom-tools` 挂载
  （按「顶层 insert + 2 空格 id」的精确形态摘除，不会误伤预设内那条同级缩进的声明）。

### 验证方式与结论

- **等价性**：以假 `ctx` 分别加载 git HEAD 里的六个旧插件与新的 `tools.js`，逐项比对
  `description` / `parameters` / `output.schema` / `output.render` /
  `presentCall`（含 null、undefined、`{}`、错类型参数等回放输入）/ `presentResult`
  （正常、isError、非对象值）——全部逐字节一致。
- **真实执行**：两套实现分别在临时工作区跑 `execute` 并比对输出——真跑 `tsc`
  （伪造 `node_modules/typescript/bin/tsc`，退出码 0 与 2 两路，含 300KB 输出触发截断
  提示）与 PATH 兜底报错、真跑 `npm run test`（通过 / 非零退出 / test 目录不存在三路）、
  真 `git add -A` + `commit`（比对输出并确认两边工作区都变干净）、`node` 的 10 个场景
  （单文件 / 目录递归 / 非零退出 / 不存在 / `..` 越界 / 根目录本身 / 绝对路径 / 非 .js /
  单脚本超限截断 / 多脚本整段封顶）、`delete` 的 5 个场景（含删除后目录内容一致）、
  `browser` 的 10 个场景（缺参、未知 action、截图越界与缺省路径等，含真跑
  agent-browser 截图）。
- **声明式选择**：子集只注册子集；无 `config.tools` 一个都不注册；未知名被跳过并报错。
- **部署**：`node .js --apply` 连跑两次，补丁 md5 不变、历史顶层条目被正确清除、
  `preset-assets/` 只剩三个预设自己的 `inject-filezone.js`。
- **运行时（关键的那条）**：以临时 overlay 挂探针插件真实启动 web profile，逐个读
  注册表里**真实挂载的预设修订**作用域：`test` 声明六个 -> 可见六个、`ts-build` 声明
  五个 -> 可见五个、十个未声明的预设（含六个文学类与四个官方预设）-> 一个都不可见；
  全局层为空。另单独验证：作用域销毁后注册随之注销；未知工具名报错且不注册。


---

## 0.2.1-alpha.4 → 0.2.1-rc.2

先逐项复核 0.2.1-rc.2 的安装目录，再按结论修改脚本。**rc.2 未改动脚本依赖的任何公开契约**，
因此本轮没有版本迁移动作；唯一修改来自复核时发现的一个与版本无关的真实缺陷。

### 1. 契约复核：全部通过（未做改动）

- **路径编码**：`encodeProjectKey` / `encodeSegment` 与
  `dsh-session-persistence-jsonl` 的 `projectKey()` / `encodeSegment()`（含 `.`/`..` 特例、
  `~XXXX` 转义、`--` 包裹、251 截断）逐字符等价。
- **日志格式**：`dsh-session` 的 `SESSION_FORMAT_VERSION` 仍为 **4**；
  `sessionFormatLogFilename()` 仍是 `session.jsonl` / `session.v${N}.jsonl`，
  `.zstd` 后缀规则未变；`SESSION_LOG_PATTERN` 与之一致。
- **会话头**：`SessionHeader` 字段未变（`isSeeded` / `delegationDepth` 仍必填，
  `cwd` / `parentSession` / `origin` / `agentPreset` 仍为可选）；移动引擎改写的
  `cwd` 仍是无损往返安全的字段。
- **workspace 存储**：`workspaceDomainSpec` 仍是 `name: "workspace", version: 2`，
  global 五字段与 `workspaceRecord`（`path`/`title`/`sessionIds`/`createdAt`/`updatedAt`）
  未变，`pendingMutation` 语义未变。
- **Agent 公开面**：仍是 `agent.status`（`'idle' | 'running'`）与 `agent.whenIdle()`；
  `phase` 仍只存在于 `dsh-agent-loop` 内部。`runMaintenance` 的注释仍确认
  「维护期间 public status stays idle」。
- **agent-preset**：`Config` 仍是 `{ id, name, description, order, plugins }`；
  `agentPresets` 服务仍提供 `composedPreset(ctx)` / `recompose(ctx, id)` / `serviceFor(...)`。
- **各服务面**：`commands.register(definition)`（`rawInput` / `commandId` / `CommandResult`
  的 `success|error`）、`system-prompt/assemble`（`PromptAssembly.sections[].{name,text}`，
  `AssembleContext.agent` 仍由 dsh-agent 增强）、`tools/pre-execute`
  （`PreToolDecision` 的 `deny+reason`、`exec.{name,arguments,agent,signal}`）、
  `webServer.register({kind,path,handler})`、`connection.requestRejection`、
  `agents.get(id)`、`loader/entry-init`、`session/event(session, event)`、
  `agent.steer(UserMessage)` 的 `source.form: 'notice'`、`compaction.compactNow(agent, signal, commandId)`
  全部与脚本用法一致。
- **hmr 监听**：`dsh-hmr` 仍监听 `[profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)]`，
  `PROFILE_PATCH_FILENAME = "cordis.patch.yml"`，与插件的 `watchedFiles` 对应。
- **bundle 结构**：`dsh-web-app` 的 `dsh.bundle.patch` 仍是
  `cordis.patch.yml + presets/{standard,ptc,minimal,cordis}.patch.yml`。
- **settings 导入**：`dsh-settings` 的 `importLegacyDocument()` 仍是「先把
  `settings.yaml` 改名为 `settings.yaml.imported`，再逐 section `update()`」，
  `LEGACY_SECTION_ENTRIES` 三条映射未变。
- **CLI**：`--dump-config` 仍在，输出仍是 `- id: <entry>` 行式，脚本的解析正则照旧命中。

### 2. 修复：4.2 的多行锚点因行尾差异永不命中（唯一的实际改动）

- **症状**：补丁 4.2 分两段——`applyTarget`（单行）与会话头部槽位 `slotTarget`（多行）。
  单行那段一直正常，多行那段**从未真正命中**：脚本只打印
  「未匹配到会话头部槽位注册代码，已跳过下拉注入」，然后照常报「部署成功」，
  结果是会话头部的预设下拉一直没注入，而日志看起来一切正常。
- **成因**：脚本自身在 Windows 检出后是 CRLF，而 dsh 的 bundle 以 **LF** 发布。
  `slotTarget` / `slotRep` 是模板字面量，行尾跟着载体文件走，于是带上 `\r\n`，
  与 LF 的目标文件永不相等（实证：`rawHit=false`，把两侧都归一化成 LF 后 `lfNormHit=true`）。
  全脚本 208 个模板字面量中只有 8 个带 CRLF，其中 6 个是写出去即完事的插件代码块（无害），
  另 2 个正是这两处锚点/替换体。
- **处置**：补丁函数新增 `readTargetCode()`，读取目标 bundle 时统一归一化为 LF；
  `slotTarget` / `slotRep` 在匹配与注入前同样归一化。补丁结果因此与检出方式无关。
- **影响面**：只影响补丁注入的源码文本，不改补丁语义；目标文件本就是 LF，
  归一化对它们是无操作，写入仍是 LF。

### 3. 验证方式与结论

- **锚点比对**：4.1 / 4.2（两段）/ 4.3（三处）/ 4.4（两处）锚点逐字节比对 rc.2 原文命中；
  修复前用副本实证 4.2 的 `slotTarget` 不命中、归一化后命中。
- **补丁产物**：把四个补丁实际应用到真实安装目录，四个 bundle 的 `node --check` 全部通过；
  变更行数与预期一致（4.1 一行、4.2 两处、4.3 三处替换 + 一条指令、4.4 注入 + 一处替换）。
- **幂等**：`node .js --apply` 连续运行两次；第二次全部报「已处于目标状态」，
  工作区注册表报「状态正常」，四个被打补丁模块的 md5 在两次之间不变。
- **组合**：`--profile web --dump-config` 退出码 0，204 个顶层条目，
  4 个官方预设与 8 个自建预设、6 个自定义插件全部挂载。
- **实际启动**：启动 rc.2 的 Web profile 正常监听（无 error/warn），
  抓取运行时下发的 `dsh-client-ui-agent-preset` 与 `dsh-client-ui-conversation` bundle，
  `AgentPresetHeaderSeat` 与 `dshMeterShown` 标记确实存在——补丁确实到达浏览器。

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
  改名为 `settings.yaml.imported`。这是官方行为。脚本的 legacy 迁移**只读 `settings.yaml`
  本身**，不再把 `.imported` 当迁移源（那是官方已处理过一部分的旧值归档，拿它回写会覆盖
  网页端现行设置）；`settings.yaml` 不存在时整段跳过并原样保留上一版托管区块。

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

### 补全 idle-arm 的客户端半边

`plugins/idle-arm/` 原先只有脚本生成的宿主半边，`package.json` 与 `lib/client.js`
缺失，因此「提交键旁的武装按钮」从未出现过——而脚本只打印一行 `console.warn`，
结尾照样喊「部署成功」。本次补齐并顺势堵掉这条静默失败路径。

- **新增 `plugins/idle-arm/package.json`**：`dsh.client.platform = 'web'`、
  `exports["./client"] = "./lib/client.js"`；`inject` 只声明真正需要的
  `dsh-client-locale` 与 `dsh-client-ui-conversation`。
- **新增 `plugins/idle-arm/lib/client.js`**：以
  `window.__ModuleLoader__.load({ id, factory })` 注册，`id` 严格等于包名
  （`dsh-client-modules` 用 manifest 里请求的 id 与注册 id 比对，不一致就报
  「loaded without registering」并静默不装配）；在 `conversation.input.right`
  （提交键左侧）挂一个「落盘拦截」按钮。交互按既有设计恢复：**点按钮 → 展开小面板
  配置起栏时间 → 确认后置位并自动提交**，不需要用户再按一次提交键或回车。
  置位走旁路 POST `idle-arm/arm`（交 `{ sessionId, minutes }`）；自动提交调用插槽
  注入的 `inputActions.submit()`，与用户按提交键走同一条提交流程。顺序固定为
  「先置位、后提交」，置位失败则不提交并回显宿主原因；面板内按 Enter 同样确认。
  文案走 `ctx.locale.register`（zh/en），样式经 `ctx.effect` 注入，用主题令牌取色
  因而跟随明暗主题。
- **脚本改为契约校验而非存在性告警**：新增 `verifyIdleArmBundle()`，逐条核对
  `dsh.client.platform`、`exports["./client"]` 指向的文件真实存在、以及
  bundle 注册 id 与 `package.json` 的 `name` 一致；任一不满足即以退出码 1 结束。
- **成功横幅改为条件输出**：结尾的「🎉 全量部署成功」只在
  `process.exitCode` 为 0 时打印，否则打印「⚠️ 部署未完成」。此前任何一步设了
  非零退出码（补丁拒绝落盘、idle-arm 声明不完整等）都会被一句祝贺盖住。

验证：`node --check` 通过；`--apply` 连跑两次字节级幂等；启动 dsh Web 后抓取
实际下发的 bundle，确认 `id: 'dsh-plugin-idle-arm'` 与包名一致、且包含面板与
`inputActions.submit()` 调用；`POST /idle-arm/arm` 的信任栅栏（401）、方法守卫
（405）、非法 JSON／越界分钟数／缺 sessionId（400）、未知会话（404）逐项实测
符合预期；把 bundle 放进迷你 React 运行时真实执行，27 项断言全过，其中直接覆盖
「确认即自动提交、无需第二次按键」与「置位先于提交」两条关键顺序。

### 未改动但值得记录的一点

- `.agent-presets/create/创作准则（无限制版）.md` 在工作区里处于已删除状态。核对了
  脚本全部文件系统调用：只有会话目录、临时文件与生成物被写/删，**没有任何**删除
  preset `.md` 的代码；该文件也不被任何 `agent.cordis.yml` 引用，与脚本行为无关。

