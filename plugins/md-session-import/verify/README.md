# md-session-import 验证套件

`../md-session-import/` 里那个插件的回归测试。它依赖 DSH 的内部格式（v4 会话日志、
`formatSessionMarkdown` 的输出、`adoptSessionEvent` 校验器），所以**DSH 升级后应当重跑**。

在 `C:\Users\q1505\.dsh` 目录下执行：

| 命令 | 验证内容 |
|---|---|
| `node plugins\md-session-import\verify\resources.mjs` | locale JSON 是合法 UTF-8、无 BOM、字段齐全；client.js 内 8 种语言的键集与 zh 完全一致 |
| `node plugins\md-session-import\verify\round-trip.mjs` | 用**真实的**导出格式化器生成输入，把解析出的事件同时喂给**真实的** `adoptSessionEvent` 和**真实的**恢复路径（`sessionFormatCatalog.createRestore` → `decodeRow` → `finish`，surface 折叠与工具调用生命周期的唯一权威）；扫描 `../sessions/` 里工具调用最多的 5 个真实会话做往返，并逐条比对工具名、参数、结果正文与错误标志 |
| `node plugins\md-session-import\verify\host-route.mjs` | 用假持久化服务、假工作区注册表与假预设注册表驱动路由：create→append→close 顺序、写句柄释放、工作区归属与 attach 顺序、预设解析（未知/损坏/未挂载三种拒绝）、错误码与 HTTP 状态、体积上限、**预设校验必须先于写入** |
| `node plugins\md-session-import\verify\storage.mjs` | 挂载**真实的** JSONL 持久化后端 + **真实的** `workspaceRegistry`（storage → storage-json → storage-domain → workspace 四级链）跑完整流程：工具调用与结果真的落盘并可读回、续写、工作区归属、cwd 不匹配时真实拒绝、未知工作区不落盘 |
| `node plugins\md-session-import\verify\client-graph.mjs` | 从运行中的 Harness 的 `/plugins/events` 读取客户端模块图，并逐字节比对服务端返回的 bundle 与本地文件 |

`storage.mjs` 在临时目录 `../.verify-import-root` 下自建 `sessions/` 与 `storages/`，跑完可整目录删除。

`round-trip.mjs` 不再写死会话 id：它扫描 `../sessions/`，取「含工具调用且有 `>` 用户消息」
的会话中工具调用最多的 5 个。语料变了它自动跟着变；一个都没有时会明确报一条失败。

## 导入会重建什么、不会重建什么

`<details>` 里的 `**Tool: \`name\`**` / `**Result**` 条目会被重建为真实的 `tool/call` 与
`tool/result` 事件：一次模型调用一个 step，助手消息带 `tool-call` 块，紧跟着配对的调用与结果。

文档里没有的东西不会被伪造，只按下面的方式处理：

- **调用 id**：导出不写 id，而调用与结果必须同 id 配对，否则下一次请求在 provider 那里就失败。
  因此每对现铸一个新 id——配对是精确的，只有拼写是新的。
- **参数格式**：导出会把 JSON 参数重新缩进，导入存下的是这份缩进后的字符串；块与 `tool/call`
  必须是同一个字符串（日志会逐字节比对），值本身不变。
- **附件字节**：结果里的图片/文件导出成 `[Image: …]` / `[File: …]` 标签，导入保留标签文本，
  字节本来就不在文档里。
- **没有结果的调用**：导出写 `(no result recorded)`，导入就存这段文本并标为错误结果——
  step 不能带着未解决的调用关闭，而伪造一个成功是在撒谎。
- **模型调用的分界**：如果下一次调用没有输出任何文本，它的工具条目会紧跟在上一批后面，
  与「同一批并行调用」在文档里形状相同。导入按连续条目合并成一条助手消息，即同样的工作在
  同样的顺序里，只是两条消息并成一条。

行尾（CRLF）会被规范化：Markdown 文档无法区分正文里的 `\r\n` 与文档自身的换行，验证套件
按「规范化后一致」比对，这一点是格式的固有损失，不是导入的缺陷。

## 已知限制：正文里的 `>`

导出格式用 `>` 引用行表示用户消息，而**正文里没有转义机制**。如果一条 assistant 回复
自己就含有一行以 `>` 开头的文本（例如引用一段示例），导出会原样写出，导入时它和真正的
用户消息无法区分，于是多出一个用户轮次。

这是**文档格式的歧义**，不是导入的缺陷：格式里没有任何办法区分两者，而猜一个转义规则
会破坏导出实际产生的每一份文档。`round-trip.mjs` 不回避这一点——它统计这种碰撞的数量，
并断言「多出来的轮次恰好等于碰撞数」，而不是放宽成「数量差不多」。

本机 `session-e8e95284`（the-worm-of-bliss）就是这样一个实例：100 轮里有 1 轮是这么来的。

失败时会打印结构化的差异（行号、长度、计数），不会打印会话正文。
