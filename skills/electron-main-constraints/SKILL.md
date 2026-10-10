---
name: electron-main-constraints
description: Electron 主进程的硬约束，决定代码放哪、用什么语言写。含内置 Node 版本与二进制/包版本不一致的实测方法、为什么主进程目录下只能写 .js、为什么 preload 必须是 JS、模块边界等于执行环境边界、webRequest 每 session 每事件只有一个监听器、webview 属性的 hasAttribute 语义与吞指针事件、以及如何避免服务间循环依赖。要在主进程目录下新增文件、想给主进程用 TypeScript、不确定逻辑该放主进程还是渲染层、要实测主进程 Node 能力、或要写 webRequest 与 webview 相关代码时读。
---

# Electron 主进程的硬约束

本技能决定**代码放哪、用什么语言写**。

- 出网与代理见 `proxy-and-networking`
- webview 宿主页面的布局与交互见 `webview-host-layout`
- 怎么让结论可信见 `verification-discipline`

---

## 一、先量版本，不要猜

**内置 Node 版本随 Electron 二进制变，不要凭记忆断言。**

### 二进制版本可能与包版本不一致

`node_modules/electron/dist/` 里的二进制**可能不是 `package.json` 声明的那个版本** ——
install 脚本没跑成时会留着旧的。若包声明 44.x 而 `dist/version` 是 `28.3.3`，
内置 Node 就是 18.18.2 而不是 24.x，**基于它做的任何 Node 能力断言都是错的**。

```powershell
Get-Content node_modules\electron\dist\version                                   # 二进制真实版本
node -e "console.log(require('./node_modules/electron/package.json').version)"   # 包声明版本
```

两者不一致 → 二进制是旧的，先修安装（见 `npm-dependencies`），再谈 Node 能力。
**报结论时把版本一起报出来。**

### 能力要实测，不要按版本推断

TS 类型剥离需要 Node 22.6+（22.18+/23+ 默认开启），Node 18 完全不支持。
但**「版本够」不等于「能用」** —— 在没实测之前，主进程目录下继续写 `.js`。

### 安全实测主进程 Node：`ELECTRON_RUN_AS_NODE=1`

```powershell
$env:ELECTRON_RUN_AS_NODE=1
node_modules\electron\dist\electron.exe -e "console.log('node=' + process.versions.node)"
```

`ELECTRON_RUN_AS_NODE=1` 让 Electron 退化成纯 Node：**不弹窗口、不起 Chromium**。
这是唯一允许的临时验证姿势。

> **绝不为了验证随手起 `BrowserWindow`** —— 会让用户屏幕弹窗。
> 需要真实 Electron 环境时（如项目自带的检查脚本），用已有的、用户认可的脚本，不要临时新建。

---

## 二、语言：主进程目录下只能是 .js

### 约束 1：主进程不能直接 require .ts

Node 18 上类型剥离完全不可用：

```powershell
$env:ELECTRON_RUN_AS_NODE=1
npx electron --experimental-strip-types foo.js
# → bad option: --experimental-strip-types
# → is not allowed in NODE_OPTIONS
```

为一个文件引入编译步骤（`tsconfig.main.json` → `electron/generated/`）是**得不偿失**的：
多出构建管线、产物目录、dev/build 串联、忘记编译就跑旧代码。成本大于收益。

**判据**：为一个文件加构建步骤前，先问「能不能用 JSDoc 拿到同样的编辑器支持」。

### 约束 2：preload 必须是 JS

preload 不由 Node 模块系统加载，而是 **Electron 自己注入**到渲染进程。
Node 的类型剥离发生在模块加载路径上，preload 不走那条路，所以对它无效。

Electron 只认 `.js` / `.cjs` / `.mjs`。`contextIsolation: true`、sandbox 默认开启时限制更严。

**这个约束不影响架构**：preload 只是转发 IPC 的瘦桥接，不含业务逻辑。

---

## 三、模块边界 = 执行环境边界

| | 渲染层 | 主进程 |
|---|---|---|
| 运行时 | 渲染进程（Chromium） | 主进程（Node） |
| 语言 | TS + ESM，打包器处理 | CJS，Node require |
| 权限 | `nodeIntegration: false`，无 `require` | 全量 Node + Electron API |

渲染层拿不到：`net`、`tls`、`http.Agent`、`BrowserWindow`、`screen`、
`webContents.debugger`、`sendInputEvent`、`session.setProxy`。

**这些 API 在哪，代码就在哪** —— 与「想放哪个目录」无关。

### 划界方法：量符号使用，不靠感觉

改动前先统计「谁在用」：

```js
const names = ['httpGetFinal','mapWithConcurrency','setProxy','UA'];
for (const n of names) {
  const c = (src.match(new RegExp('\\b' + n + '\\b', 'g')) || []).length;
  console.log(n, c);
}
```

**通用原则**：一个符号被谁用，就放在谁那里；不要因为「看起来像基础设施」就上提。

### 新增文件前先确认它没有被别处取代

单站特化模块最终会分别内联进主进程入口、或重构为 provider 架构
（见 `pluggable-provider-refactor`）。
**新建文件前先搜一遍，确认没有功能重叠的现有实现。**

---

## 四、webRequest 与 webview 的连带约束

### 约束 3：`webRequest` 每 session 每事件只有一个监听器

官方文档原文：

> ⚠️ **Only the last attached `listener` will be used.**
> Passing `null` as `listener` will unsubscribe from the event.

注册是**替换**语义，不是追加。两个后果：

**① 不能靠「多注册几次」覆盖多个 session**

```js
// ✗ 第二次注册把第一次顶掉（同一 session 时）
sess.webRequest.onBeforeSendHeaders(filter, handler);

// ✓ 按 session 记账，幂等注册
const headerRewriteSessions = new WeakSet();
const applyRequestHeaderRules = (sess) => {
    if (!sess || headerRewriteSessions.has(sess)) return;
    headerRewriteSessions.add(sess);
    sess.webRequest.onBeforeSendHeaders(filter, handler);
};
```

**② 必须显式想清「要挂到哪些 session 上」**

常见的**不对称**：嗅探类逻辑覆盖 `defaultSession` + 主窗口 session + 每个 webview 的 session
（`did-attach-webview` 里补挂），而请求头改写只挂了主窗口的 session。

`<webview>` 默认继承宿主窗口的 session，所以**恰好同源时不会暴露问题**。
一旦给 webview 加 `partition`（独立 session），UA 与防盗链 Referer 就全部失效。

**判据**：写任何 `webRequest` 注册时问一句
**「这段逻辑要作用于哪些 session？我挂全了吗？」** —— 并对照同类注册是否已有多 session 的守卫。

> 可以加静态检查盯住这个对称性，但**新增 webRequest 事件时仍需人工判断该挂哪些 session**。

### 约束 4：`<webview>` 的属性是 `hasAttribute()` 语义

```html
<!-- ✓ 属性存在即为真，取值字符串无关 -->
<webview allowpopups="" ... />
<!-- ✗ 删掉属性会让 window.open 被内核直接丢弃 -->
```

Electron 的 BooleanAttribute 按 `hasAttribute()` 判定。`allowpopups` 缺失时，
`window.open` 被内核丢弃，主进程的 `setWindowOpenHandler → navigate-to-url`（新标签页）
**根本不会触发**。

同族：`webpreferences="contextIsolation=yes"` 是字符串属性，按值解析，语义不同。

### 约束 5：`<webview>` 吞掉指针事件

官方文档同一处的原文：

> You can not add keyboard, mouse, and scroll event listeners to `webview`

**这不是「主进程的事」，但它由主进程启用的 `<webview>` 决定，且只在宿主页面里才暴露。**

webview 是跨进程 OOPIF，事件不冒泡到宿主 `window`：拖动边栏手柄时，
鼠标一压到 webview 上 `mousemove` 就断流，表现为「拖动幅度稍大就失焦」。
**修法见 `webview-host-layout`。**

**判据**：任何跨 webview 边界的指针交互（拖拽、框选、拖放、悬浮）
都要在拖动期间盖一层全视口遮罩，并给 `blur` 兜底收尾。

---

## 五、不要为了让目录好看而造循环依赖

```
main.js ──require──▶ someService.js ──require──▶ main.js   ← 循环
```

Node 遇到循环时，把**执行到一半的 `module.exports`**（默认空对象）交出去，
且**只报 warning 不报错**：

| 写法 | 结果 |
|---|---|
| main 先 `module.exports`，后 require | ✓ 正常 |
| main 先 require，后 `module.exports`（更自然） | ✗ 拿到 `undefined`，只报 warning |

第二种是最坏形态：进程正常启动、界面正常打开，直到第一次用到才炸
`xxx is not a function`，错误信息完全指不到真正原因（导出顺序）。

**哪些服务会循环？** 只有同时满足两个条件的：

1. 主进程入口依赖它
2. 它依赖网络层（`require` 回主进程入口）

**关键洞察**：渲染层用 `fetch`（Chromium 栈，代理配在会话上天然生效）；
主进程用 Node `http`/`https`（代理必须手动注入）。
**这个技术差异正好对应了有无循环风险** —— 只有走 Node `http` 的服务才需要 require 网络层。

而一旦做了全局拦截（见 `proxy-and-networking`），这类服务不再需要 require 网络层，
循环问题**自动消失**。

---

## 自查清单

- [ ] 断言 Node 能力前，量过 `dist/version` 与包声明版本吗？两者一致吗？
- [ ] 新增文件用的是 `.js` 吗（preload 尤其）？
- [ ] 这段逻辑用到的 API 属于哪个运行时？放对目录了吗？
- [ ] 新增文件前，确认过没有功能重叠的现有实现吗？
- [ ] 新增的 `webRequest` 注册该挂哪些 session？挂全了吗？
- [ ] 用了 `<webview>` 的布尔属性吗？删除它会导致什么静默失效？
- [ ] 有没有引入「主进程入口 ↔ 服务」的循环 require？导出顺序对吗？
