# md-session-import 验证套件

`../md-session-import/` 里那个插件的回归测试。它依赖 DSH 的内部格式（v4 会话日志、
`formatSessionMarkdown` 的输出、`adoptSessionEvent` 校验器），所以**DSH 升级后应当重跑**。

在 `C:\Users\q1505\.dsh` 目录下执行：

| 命令 | 验证内容 |
|---|---|
| `node bundles\md-session-import-verify\resources.mjs` | locale JSON 是合法 UTF-8、无 BOM、字段齐全；client.js 内 8 种语言的键集与 zh 完全一致 |
| `node bundles\md-session-import-verify\round-trip.mjs` | 用**真实的**导出格式化器生成输入，把解析出的事件全部喂给**真实的** `adoptSessionEvent`；3 个真实会话日志往返一致 |
| `node bundles\md-session-import-verify\host-route.mjs` | 用假持久化服务、假工作区注册表与假预设注册表驱动路由：create→append→close 顺序、写句柄释放、工作区归属与 attach 顺序、预设解析（未知/损坏/未挂载三种拒绝）、错误码与 HTTP 状态、体积上限、**预设校验必须先于写入** |
| `node bundles\md-session-import-verify\storage.mjs` | 挂载**真实的** JSONL 持久化后端 + **真实的** `workspaceRegistry`（storage → storage-json → storage-domain → workspace 四级链）跑完整流程：落盘读回、续写、工作区归属、cwd 不匹配时真实拒绝、未知工作区不落盘 |
| `node bundles\md-session-import-verify\client-graph.mjs` | 从运行中的 Harness 的 `/plugins/events` 读取客户端模块图，并逐字节比对服务端返回的 bundle 与本地文件 |

`storage.mjs` 在临时目录 `../.verify-import-root` 下自建 `sessions/` 与 `storages/`，跑完可整目录删除。

`round-trip.mjs` 引用了三个真实会话日志的路径（位于 `../sessions/`）。那些会话被删除后，
把该文件顶部的 spec 列表换成仍然存在的会话即可。

## 已知限制：正文里的 `>`

导出格式用 `>` 引用行表示用户消息，而**正文里没有转义机制**。如果一条 assistant 回复
自己就含有一行以 `>` 开头的文本（例如引用一段示例），导出会原样写出，导入时它和真正的
用户消息无法区分，于是多出一个用户轮次。

这是**文档格式的歧义**，不是导入的缺陷：格式里没有任何办法区分两者，而猜一个转义规则
会破坏导出实际产生的每一份文档。`round-trip.mjs` 不回避这一点——它统计这种碰撞的数量，
并断言「多出来的轮次恰好等于碰撞数」，而不是放宽成「数量差不多」。

本机 `session-e8e95284`（the-worm-of-bliss）就是这样一个实例：100 轮里有 1 轮是这么来的。

失败时会打印结构化的差异（行号、长度、计数），不会打印会话正文。
