# md-session-import 验证套件

`../md-session-import/` 里那个插件的回归测试。它依赖 DSH 的内部格式（v4 会话日志、
`formatSessionMarkdown` 的输出、`adoptSessionEvent` 校验器），所以**DSH 升级后应当重跑**。

在 `C:\Users\q1505\.dsh` 目录下执行：

| 命令 | 验证内容 |
|---|---|
| `node bundles\md-session-import-verify\resources.mjs` | locale JSON 是合法 UTF-8、无 BOM、字段齐全；client.js 内 8 种语言的键集与 zh 完全一致 |
| `node bundles\md-session-import-verify\round-trip.mjs` | 用**真实的**导出格式化器生成输入，把解析出的事件全部喂给**真实的** `adoptSessionEvent`；3 个真实会话日志往返一致 |
| `node bundles\md-session-import-verify\host-route.mjs` | 用假持久化服务与假工作区注册表驱动路由：create→append→close 顺序、写句柄释放、工作区归属与 attach 顺序、错误码与 HTTP 状态、体积上限 |
| `node bundles\md-session-import-verify\storage.mjs` | 挂载**真实的** JSONL 持久化后端 + **真实的** `workspaceRegistry`（storage → storage-json → storage-domain → workspace 四级链）跑完整流程：落盘读回、续写、工作区归属、cwd 不匹配时真实拒绝、未知工作区不落盘 |
| `node bundles\md-session-import-verify\client-graph.mjs` | 从运行中的 Harness 的 `/plugins/events` 读取客户端模块图，并逐字节比对服务端返回的 bundle 与本地文件 |

`storage.mjs` 在临时目录 `../.verify-import-root` 下自建 `sessions/` 与 `storages/`，跑完可整目录删除。

`round-trip.mjs` 引用了三个真实会话日志的路径（位于 `../sessions/`）。那些会话被删除后，
把该文件顶部的 spec 列表换成仍然存在的会话即可。

失败时会打印结构化的差异（行号、长度、计数），不会打印会话正文。
