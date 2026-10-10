---
name: proxy-and-networking
description: Electron 主进程出网与代理接管的正确做法与五个硬坑——为什么"每个出网点自己传 agent"不可靠、如何用 globalAgent 与 net.fetch 做全局拦截、fetch 既不读 globalAgent 也不读会话代理、agent 设为 false 在接管后会递归爆栈、proxyBypassRules 里 <-loopback> 的含义是反的、ffmpeg 是独立进程拿不到 agent 且只认 HTTP 代理、以及本机代理两个端口协议不同（10808 SOCKS5 / 10810 HTTP）该用哪个。要新增主进程出网代码、排查"浏览器能开但某功能直连超时"、要把代理从逐点注入改为全局生效、或要选代理端口时读。
---

# 主进程出网与代理接管

**核心原则：「每个出网点自己记得传 agent」是不可靠的设计。**
只要有一处忘了传，那条路径就静默绕过代理，症状是「浏览器能开、某个功能直连超时」，极难定位。
同一个代码库里重复犯这个错是常态 —— 这正说明「靠人记得」的方案不成立。

- 依赖怎么装进来见 `npm-dependencies`
- 代码该放主进程还是渲染层见 `electron-main-constraints`
- 怎么证明「确实走了代理」见 `verification-discipline`

---

## 一、全局接管

```js
// 模块加载时接管
http.globalAgent = proxiedHttpAgent;
https.globalAgent = proxiedHttpsAgent;

// app ready 后补上 fetch（net.fetch 依赖 ready 的运行时）
globalThis.fetch = electron.net.fetch;
```

Node 在 `options.agent === undefined` 时使用 `globalAgent`，
所以**任何不传 agent 的调用都自动走代理**，调用方无需知情、无需配合。

实测覆盖（`https.get` 完全不提 agent）：

| 写法 | 自动走代理 |
|---|---|
| `https.get(url, {headers})` | ✓ |
| `https.get(url, {agent: undefined})` | ✓ |
| `https.request(url, {method:'GET'})` | ✓ |
| `fetch(url)` | ✓（需换成 net.fetch，见坑 1） |
| `net.fetch(url)` | ✓（本就遵循会话代理） |

### 接管后，手动传 agent 的代码全是废码

**必须删掉。** 留着不仅冗余，还会掩盖「拦截失效」——
某处拦截没生效时，手动那处仍在工作，问题被推迟到没手动的地方才暴露。
漏删的典型表现是回归测试直接报 `httpsAgent is not defined`。

> 这条是 `user-collaboration-preferences`「全局机制取代的代码要删掉」的具体实例。

---

## 二、五个坑

### 坑 1：fetch 既不读 globalAgent 也不读会话代理

Node 的 `fetch` 由 undici 实现，**两条路都不走**。同一个已配好 SOCKS5 的会话里：

```
net.fetch  : HTTP 200  61399B     ← 遵循会话代理
原生 fetch : 失败 fetch failed     ← 无视一切代理配置
```

**解法**：把 `globalThis.fetch` 换成 Electron 的 `net.fetch`。
它走 Chromium 网络栈，而会话代理由 `session.defaultSession.setProxy` 配置，天然生效。

```js
function installGlobalFetch() {
    try {
        const electron = require('electron');
        if (typeof electron.net?.fetch !== 'function') return false;
        globalThis.fetch = electron.net.fetch.bind(electron.net);
        return true;
    } catch (_e) {
        return false;   // 非 Electron 环境（测试/CLI）：保持原生 fetch
    }
}
```

**时序**：`net.fetch` 依赖已 ready 的 Electron 运行时。
模块加载（早于 ready）时只能接管 agent，fetch 要在 `app.whenReady()` 里补一次。

### 坑 2：`agent: false` 在接管后会递归爆栈

接管 `globalAgent` 后，**`agent: false` 的含义变了**。

Node 对 `agent: false` 的处理不是「不代理」，而是
**「以当前 `globalAgent` 的构造函数新建一个实例」**。
而 `globalAgent` 已经是隧道 agent → 新建出来的还是隧道 agent
→ 「连代理」的请求又去连代理 → 无限递归：

```
RangeError: Maximum call stack size exceeded
  at tunnelThroughProxy
  at ProxiedHttpAgent.createConnection
  at Object.request (node:http)
  at tunnelThroughProxy            ← 回到起点
```

**解法**：给「为了建立隧道而发的请求」一个**永不代理**的专用 agent：

```js
const directHttpAgent = new http.Agent({ keepAlive: false });

// 所有 CONNECT 探测与 HTTP 隧道都显式用它
const req = http.request({
    host: proxyEndpoint.host, port: proxyEndpoint.port,
    method: 'CONNECT', path: `${targetHost}:${targetPort}`,
    agent: directHttpAgent,          // ← 不能用 agent: false
});
```

凡是「连代理本身」的请求（协议探测、HTTP CONNECT、SOCKS5 握手）都要走这条路。
裸 `net.connect` / `tls.connect` 不受影响（它们不经过 agent 体系）。

### 坑 3：`<-loopback>` 是反向的

Chromium 的 `proxyBypassRules` 里，**`<-loopback>` 的含义是「解除对环回的隐式绕过」**，
即强制把本地流量也送进代理 —— 与「绕过环回」的直觉正好相反。

实测：加上它，`resolveProxy('http://127.0.0.1:<本地端口>/...')` 返回
`SOCKS5 127.0.0.1:10808`；去掉它，返回 `DIRECT`。

**正确写法**：

```js
const BYPASS = 'localhost;127.0.0.1;[::1]';   // 显式列出即可，不要加 <-loopback>
await ses.setProxy({ proxyRules, proxyBypassRules: BYPASS });
```

**为什么必须有 bypass**：默认会话同时承载渲染层，而本地服务全在环回上
（本机 AI 网关、开发态 dev server 等）。
一旦被送进代理，表现是「开了代理之后 AI 全挂、开发页打不开」，原因极难定位。

### 坑 4：ffmpeg 是独立进程，拿不到 agent

`spawn` 出来的 ffmpeg 不在 Node 的 agent 体系里，且**只认 HTTP 代理，不支持 SOCKS5**。

**规则**：仅当当前生效的是 http 代理时才注入，否则保持原样。

```js
if (appliedProxy && appliedProtocol === 'http') {
    proxyArgs.push('-http_proxy', `http://${appliedProxy}`);
}
```

注入 `socks5://` 会让 ffmpeg 直接报协议不支持 —— **比不走代理还糟**。
宁可维持原行为，也不制造新的失败。

### 坑 5：本机代理有两个端口，协议不同

本机代理由 `D:\tools\Whale.exe`（白鲸加速器）提供，**开了两个口、协议不一样**：

| 端口 | 进程 | 协议 | `curl -x` 到 github.com |
|---|---|---|---|
| 10808 | `vcore.exe` | **SOCKS5** | `socks5://` → 200；`http://` → `Proxy CONNECT aborted` |
| 10810 | `Whale.exe` | **HTTP** | `http://` → 200 |

两者都是 `Whale.exe` 的子进程。10810 同时被写进 Windows 系统代理：

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
  ProxyEnable = 1
  ProxyServer = 127.0.0.1:10810
```

**应用自己的设置里的 `"proxyPort": "127.0.0.1:10808"` 与系统代理无关**，是两条独立的配置。

**选端口的规则**：

| 用途 | 用哪个 | 原因 |
|---|---|---|
| 支持 socks5 的客户端（浏览器 / 主进程 / 渲染层） | 10808 | 应用设置里配的就是它 |
| **npm / prebuild-install / @electron/get** | **10810** | 这些只支持 HTTP 代理，不认 socks5 |

`prebuild-install` 内部用 `tunnel-agent`，传 `socks5://` 会直接失败（见 `npm-dependencies`）。

---

## 三、自检

改完代理相关代码，跑项目自带的代理回归脚本（若有）—— 用真实 Electron 环境跑，
断言的是 `resolveProxy` 的返回值和实际连通性，不是「代码看起来对」。

```powershell
npx electron scripts/proxy-check.js
```

若项目还没有这样的脚本，**先问用户是否可以新建一个**，不要临时手搓 ——
手搓的探测脚本更容易得出错误结论（见 `verification-discipline`）。

---

## 自查清单

- [ ] 新写的出网代码有没有手动传 agent（接管后那是废码，该删）？
- [ ] 用的是 `fetch` 还是 `net.fetch`？`globalThis.fetch` 接管了吗？
- [ ] 「连代理本身」的请求用的是专用 direct agent，而不是 `agent: false`？
- [ ] `proxyBypassRules` 里有没有误加 `<-loopback>`？环回服务列全了吗？
- [ ] 给 ffmpeg 注入代理前，确认过当前是 HTTP 代理而非 SOCKS5 吗？
- [ ] 选端口时，这个工具支持 socks5 吗（不支持就用 10810）？
- [ ] 跑过项目自带的代理回归脚本吗？
