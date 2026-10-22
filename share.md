# 炼化产物：prompt-forge

把 `new/` 下三个第三方 DSH 插件炼化成我们自己的一个插件，一份内核、三种强度。

## 插件

| 项 | 值 |
|---|---|
| 包名 | `dsh-plugin-prompt-forge` |
| 安装位置 | `~/.dsh/plugins/prompt-forge/` |
| 仓库 | https://github.com/cehnhaiyang/better-dsh |
| 源码目录 | https://github.com/cehnhaiyang/better-dsh/tree/main/plugins/prompt-forge |
| 落地提交 | `7349145` — 新增 prompt-forge 提示词锻造插件：炼化三个上游实现为一份内核 |
| 挂载方式 | `~/.dsh/.js` 生成到 `profiles/web/cordis.patch.yml` 的 `- id: prompt-forge` 行 |

### 文件清单

| 文件 | 行数规模 | 作用 |
|---|---|---|
| `lib/index.js` | 27 KB | 宿主半边：`/forge` 命令、`forge_prompt` 工具、`/api/forge/*` 六条路由、`promptForge` 服务 |
| `lib/client.js` | 18 KB | 客户端半边：输入框右侧「改写」按钮 + 面板（强度、模板、结果、撤销） |
| `lib/prompt.js` | 25 KB | 纯函数层：七段渲染、格式骨架、参数收窄、输出清洗、表单文档 |
| `lib/forge-prompts.js` | 11 KB | 模型侧 system 提示词：底座 + 三强度段落 + 输出纪律 |
| `lib/templates.js` | 11 KB | 8 套内置结构化模板（由上游 `templates.json` 脚本转写） |
| `tools/selftest.mjs` | 7.9 KB | 纯函数自检（19 项） |
| `tools/hosttest.mjs` | 9.0 KB | 宿主契约自检（39 项） |
| `tools/routetest.mjs` | 7.5 KB | 路由自检（30 项） |
| `tools/clienttest.mjs` | 7.4 KB | 客户端装配自检（26 项） |

## 三条入口

| 入口 | 形态 | 用法 |
|---|---|---|
| `/forge` | 宿主斜杠命令 | `/forge <草稿>`；`--rewrite` / `--augment` / `--structure` 指定强度；`revise <意见>` 迭代上一版 |
| `forge_prompt` | 模型可调用工具 | 参数 `draft` / `mode` / `digest` / `feedback` |
| 输入框右侧按钮 | 客户端插槽 `conversation.input.right` | 选强度与模板 → 改写 → 结果填入输入框；出结果后按钮变「撤销」 |

## 三种强度

| 强度 | 行为 |
|---|---|
| `rewrite` | 只重述 + 明确化，不添加原文没有的信息 |
| `augment` | 在重述之上保守补充「不说会导致执行模型误判」的大逻辑（默认） |
| `structure` | 产出七段结构化提示词：身份 / 目标 / 硬性规则 / 工具使用策略 / 输出格式 / 数据不足时 / 示例 |

## 上游来源

炼化自以下三个实现（本地目录 `new/`，未纳入仓库）：

| 上游 | 版本 | 取用 | 弃用 |
|---|---|---|---|
| [dsh-prompt-enhancer](https://github.com/Fishsb/dsh-prompt-enhancer) | 3.4.2 | 语义保真五步法、`DISCIPLINE_PROMPT` 输出纪律、`cleanOutput` 三层剥离、增量模板红线 | 语音识别（ASR / RecordRTC）、更新器、`undici` 依赖 |
| [dsh-plugin-structured-prompt](https://github.com/YuChenLiao/dsh-plugin-structured-prompt) | 0.4.0 | 七段渲染、输出格式骨架、`prefer()` 空白回退、`splitCallableTools`、8 套模板 | 提示词库检索（prompts.chat 代理）、表单 UI |
| [prompt_optimize_dsh](https://github.com/xiaozuishuai-eng/prompt_optimize_dsh) | 1.2.0 | 投递队列 + 客户端轮询自动填入、`ctx.llm` 复用（零密钥） | 规范文件外部化、八大板块格式 |

## 自检

```powershell
cd ~/.dsh/plugins/prompt-forge
node tools/selftest.mjs    # 19 项：渲染 / 清洗 / 参数回退 / 模板完整性
node tools/hosttest.mjs    # 39 项：导出契约、工具与命令注册、端到端改写、错误路径
node tools/routetest.mjs   # 30 项：六条路由注册、幂等重扫、dispose 不误删他人路由
node tools/clienttest.mjs  # 26 项：bundle 注册 id、插槽、样式
```

四套全 PASS。

## 线上验证

| 项 | 结果 |
|---|---|
| `GET /api/forge/meta` | 200，三种强度 + 8 套模板正确返回 |
| 真实模型 `rewrite` | 「请编写一个脚本，把日志按天分别放进不同的文件夹；不要删除原始日志文件。」 |
| 真实模型 `augment` | 四条要求，含「如无特别说明，以日志文件对应的日期作为归属依据」 |
| 真实模型 `structure` | 五段齐备，无空板块 |
| 生成器幂等 | 跑两遍，patch 里 `id: prompt-forge` 恒为 1 条 |

## 生效条件

宿主半边（命令、工具、路由）随 profile patch 热生效；**客户端按钮需要重启 DSH** 才会出现，因为客户端 bundle 要重新装配。
