# rewind —— 会话回退（双面插件）

把会话退回到更早的一条消息，可选一并把工作区文件还原到那一刻。

界面上是每轮回复旁的「回退到此处」入口；宿主半边负责列出候选、算影响面、执行回退
（截断会话表面 + 还原快照文件），客户端半边负责按钮、候选弹层与确认流程。

## 它和 `dsh-rewind-plugin` 的关系

这份代码来自 npm 包 `dsh-rewind-plugin@0.21.0`，但**不再以 npm 包的形式存在**：

| | 上游 npm 包 | 这里 |
| --- | --- | --- |
| 位置 | `profiles/web/node_modules/` | `~/.dsh/plugins/rewind/` |
| 挂载 | `dsh.profile.bundles` + `dsh.bundle.patch` | profile 补丁里一行 `file://`（id `rewind`） |
| 宿主半边 | `lib/index.js`（esbuild 单文件 bundle） | `lib/` 下 6 个 ESM 模块，按上游模块边界拆开 |
| 客户端半边 | `lib/client.js`（构建产物） | `lib/client.js`（同一个文件，但**它就是源**，手改即可） |
| 类型声明 | `lib/types/**` | 无（不参与类型检查） |
| 构建 | `npm run build`（esbuild + tsc） | **没有构建步骤** |

也就是说：改行为 = 直接改 `lib/` 下的文件，改完重启 dsh 即可，不存在「改了源码忘了
构建」这种坑。

## 结构

```
plugins/rewind/
├── package.json          双面声明：exports["./client"] + dsh.client
├── lib/
│   ├── index.js          插件入口：Config、命令、路由、apply()
│   ├── locales.js        宿主侧文案（8 语言）
│   ├── marker.js         回退标记事件的 kind/source 常量
│   ├── rewind.js         候选列表与目标解析（纯函数，无 IO）
│   ├── snapshot.js       快照库：写前捕获、去重、还原（最大的一个模块）
│   ├── snapshot-cleanup.js  快照自动清理与 /rewind cleanup 子命令
│   └── client.js         浏览器半边（单文件，加载器交接格式）
├── locale/*.json         插件市场用的元数据（标题/简介），8 语言
└── README.md
```

宿主半边的依赖方向是单向的：`index.js` 依赖其余五个，其余五个互不依赖。所以任何
一个模块都可以单独读、单独改，不会牵一发动全身。

## 三条不能动的契约

1. **`package.json` 的 `name` 必须等于 `lib/client.js` 里 `__ModuleLoader__.load({ id })`
   的 id。** 加载器按 id 把 factory 登记进模块表，再按同一 id 取回；不一致就是
   「loaded without registering」，界面上那块东西静默消失。`~/.dsh/.js` 会验这一条。
2. **它必须是 profile 的 `link:` 依赖，且 `node_modules/dsh-rewind` 那条 junction
   必须存在。** 宿主半边 `import '@deepseek-ai/dsh-llm'`、`dsh-home-paths`、
   `schemastery` 三个裸说明符 —— 裸 `@deepseek-ai` 说明符只对「linked root 内、且自身
   package.json 声明了该 peer」的模块做拦截（`dsh-app-boot` 的
   `findInterceptionLayer` / `routeLinked`）。缺了这一环，加载期是
   `ERR_MODULE_NOT_FOUND`，fiber 静默停在未激活。
3. **`lib/client.js` 必须保持单文件。** 客户端没有运行期打包器：整份文件是一段
   `window.__ModuleLoader__.load({ id, factory })` 调用，factory 里是 CommonJS 模块体，
   `require` 由加载器注入。拆成多个相对路径模块无法被解析。

## 为什么客户端半边不拆

上游用 esbuild 把 17 个 TS/TSX 模块打进一个 CJS 文件，再套上加载器交接的外壳。这个
「打包」不是可选的工程习惯，而是格式要求 —— 见契约 3。所以这里保留单文件，只在文件
头写清它是什么、以及段内 `// src/client/<模块>.ts` 就是上游的同名模块边界。

宿主半边没有这个限制（node 原生解析 ESM），因此按模块拆开，和 `prompt-forge/` 一致。

## 维护

- 改完 `lib/` 下任何文件都要**重启 dsh**：这是普通的 `file://` 插件行，没有
  `setBundle` 可以触发 reconcile，热更新不适用。
- `node ~/.dsh/.js --apply` 会重跑契约校验（包目录、双面声明、六个模块是否齐、link:
  依赖与 junction 是否在、旧 npm 包是否已从 bundles 里退场），不通过即非零退出。
- 上游 npm 包目录 `profiles/web/node_modules/dsh-rewind-plugin/` 可以随时删除：它已经
  不在 `dependencies` 也不在 `bundles` 里，留着只是一份可对照的原始产物。

## 已知限制

- 日志是 append-only 的：回退与编辑都只是**追加**记录，磁盘上的历史事件一个都不少。
  因此「复制会话为 Markdown」这类按原始日志逐条渲染的导出器仍会看到旧内容 —— 那是
  导出器的问题，不是这里的问题，修法见交付说明。
- 快照还原按写前捕获，只覆盖被工具写过的文件；进程外的手工改动不在快照里。
