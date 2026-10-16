---
name: proxy-and-networking
description: The correct way to do outbound networking and proxy takeover in an Electron main process, and five hard pitfalls — why "each outbound call site passes its own agent" is unreliable, how to intercept globally with globalAgent and net.fetch, that fetch reads neither globalAgent nor the session proxy, that agent set to false recurses into a stack overflow after takeover, that <-loopback> in proxyBypassRules means the opposite of what it looks like, that ffmpeg is a separate process which cannot receive an agent and accepts an HTTP proxy only, and that this machine's proxy exposes two ports with different protocols (10808 SOCKS5 / 10810 HTTP) and which one to use. Read when adding main-process outbound code, when diagnosing "the browser opens but some feature times out on a direct connection", when converting the proxy from per-call-site injection to global effect, or when choosing a proxy port.
---

# Main-Process Outbound Networking and Proxy Takeover

**Core principle: "each outbound call site remembers to pass an agent" is an unreliable design.**
As long as one place forgets, that path silently bypasses the proxy, with the symptom "the browser opens but some feature times out on a direct connection" — extremely hard to locate.
Repeating this mistake within one codebase is normal — which is exactly what shows that "rely on people remembering" does not work.

- For how dependencies get installed see `npm-dependencies`
- For whether code belongs in the main process or the renderer see `electron-main-constraints`
- For how to prove "it really went through the proxy" see `verification-discipline`

---

## 1. Global takeover

```js
// Take over at module load
http.globalAgent = proxiedHttpAgent;
https.globalAgent = proxiedHttpsAgent;

// Add fetch after app ready (net.fetch depends on the ready runtime)
globalThis.fetch = electron.net.fetch;
```

Node uses `globalAgent` when `options.agent === undefined`,
so **any call that passes no agent automatically goes through the proxy**, with no knowledge or cooperation required from the caller.

Measured coverage (`https.get` never mentions an agent):

| Form | Goes through the proxy automatically |
|---|---|
| `https.get(url, {headers})` | yes |
| `https.get(url, {agent: undefined})` | yes |
| `https.request(url, {method:'GET'})` | yes |
| `fetch(url)` | yes (must be swapped for net.fetch, see pitfall 1) |
| `net.fetch(url)` | yes (it already follows the session proxy) |

### After takeover, code that passes an agent manually is all dead code

**It must be deleted.** Keeping it is not merely redundant; it also masks "the interception stopped working" —
when interception fails somewhere, the manual site still works, so the problem surfaces only later at a place without the manual agent.
The typical symptom of a missed deletion is a regression test failing outright with `httpsAgent is not defined`.

> This is a concrete instance of `user-collaboration-preferences`'s "delete code superseded by a global mechanism".

---

## 2. Five pitfalls

### Pitfall 1: fetch reads neither globalAgent nor the session proxy

Node's `fetch` is implemented by undici and **takes neither route**. In one session already configured for SOCKS5:

```
net.fetch  : HTTP 200  61399B     <- follows the session proxy
native fetch: fails, "fetch failed" <- ignores every proxy setting
```

**Fix**: replace `globalThis.fetch` with Electron's `net.fetch`.
It uses the Chromium network stack, and the session proxy is configured by `session.defaultSession.setProxy`, so it takes effect naturally.

```js
function installGlobalFetch() {
    try {
        const electron = require('electron');
        if (typeof electron.net?.fetch !== 'function') return false;
        globalThis.fetch = electron.net.fetch.bind(electron.net);
        return true;
    } catch (_e) {
        return false;   // non-Electron environment (tests/CLI): keep the native fetch
    }
}
```

**Ordering**: `net.fetch` depends on a ready Electron runtime.
At module load (earlier than ready) you can only take over the agents; fetch must be installed later inside `app.whenReady()`.

### Pitfall 2: `agent: false` recurses into a stack overflow after takeover

After taking over `globalAgent`, **the meaning of `agent: false` changes**.

Node does not treat `agent: false` as "do not proxy" but as
**"construct a new instance from the current `globalAgent`'s constructor"**.
Since `globalAgent` is already the tunnel agent, the new instance is a tunnel agent too
-> the "connect to the proxy" request goes to the proxy again -> infinite recursion:

```
RangeError: Maximum call stack size exceeded
  at tunnelThroughProxy
  at ProxiedHttpAgent.createConnection
  at Object.request (node:http)
  at tunnelThroughProxy            <- back to the start
```

**Fix**: give "requests issued in order to establish the tunnel" a dedicated agent that **never proxies**:

```js
const directHttpAgent = new http.Agent({ keepAlive: false });

// Every CONNECT probe and HTTP tunnel uses it explicitly
const req = http.request({
    host: proxyEndpoint.host, port: proxyEndpoint.port,
    method: 'CONNECT', path: `${targetHost}:${targetPort}`,
    agent: directHttpAgent,          // <- not agent: false
});
```

Every request that "connects to the proxy itself" (protocol probe, HTTP CONNECT, SOCKS5 handshake) must take this route.
Bare `net.connect` / `tls.connect` are unaffected (they do not go through the agent system).

### Pitfall 3: `<-loopback>` is inverted

In Chromium's `proxyBypassRules`, **`<-loopback>` means "remove the implicit loopback bypass"**,
i.e. it forces local traffic through the proxy too — the exact opposite of the intuition "bypass loopback".

Measured: with it added, `resolveProxy('http://127.0.0.1:<local port>/...')` returns
`SOCKS5 127.0.0.1:10808`; with it removed, it returns `DIRECT`.

**Correct form**:

```js
const BYPASS = 'localhost;127.0.0.1;[::1]';   // list them explicitly; do not add <-loopback>
await ses.setProxy({ proxyRules, proxyBypassRules: BYPASS });
```

**Why a bypass is mandatory**: the default session also carries the renderer, and every local service lives on loopback
(the local AI gateway, a dev-mode dev server, and so on).
Once they are sent into the proxy, the symptom is "after enabling the proxy all AI is down and the dev page will not open", with a cause that is extremely hard to locate.

### Pitfall 4: ffmpeg is a separate process and cannot receive an agent

An ffmpeg spawned via `spawn` is outside Node's agent system, and it **accepts an HTTP proxy only, not SOCKS5**.

**Rule**: inject only when the currently effective proxy is an http proxy; otherwise leave it as is.

```js
if (appliedProxy && appliedProtocol === 'http') {
    proxyArgs.push('-http_proxy', `http://${appliedProxy}`);
}
```

Injecting `socks5://` makes ffmpeg report an unsupported protocol outright — **worse than not proxying at all**.
Better to keep the original behavior than to manufacture a new failure.

### Pitfall 5: this machine's proxy has two ports with different protocols

The local proxy is provided by `D:\tools\Whale.exe` (the Whale accelerator), which **opens two ports with different protocols**:

| Port | Process | Protocol | `curl -x` to github.com |
|---|---|---|---|
| 10808 | `vcore.exe` | **SOCKS5** | `socks5://` -> 200; `http://` -> `Proxy CONNECT aborted` |
| 10810 | `Whale.exe` | **HTTP** | `http://` -> 200 |

Both are child processes of `Whale.exe`. 10810 is also written into the Windows system proxy:

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
  ProxyEnable = 1
  ProxyServer = 127.0.0.1:10810
```

**The `"proxyPort": "127.0.0.1:10808"` in the application's own settings has nothing to do with the system proxy**; they are two independent configurations.

**Rules for choosing a port**:

| Purpose | Which port | Reason |
|---|---|---|
| Clients that support socks5 (browser / main process / renderer) | 10808 | it is what the application settings configure |
| **npm / prebuild-install / @electron/get** | **10810** | these support an HTTP proxy only and do not recognize socks5 |

`prebuild-install` uses `tunnel-agent` internally, so passing `socks5://` fails outright (see `npm-dependencies`).

---

## 3. Self-check

After changing proxy-related code, run the project's own proxy regression script (if one exists) — in a real Electron environment,
asserting on `resolveProxy`'s return value and actual connectivity, not on "the code looks right".

```powershell
npx electron scripts/proxy-check.js
```

If the project has no such script yet, **ask the user first whether one may be created**; do not improvise one on the spot —
a hand-rolled probe script is more likely to produce a wrong conclusion (see `verification-discipline`).

---

## Self-check list

- [ ] Does newly written outbound code pass an agent manually (after takeover that is dead code and should be deleted)?
- [ ] Is it `fetch` or `net.fetch`? Has `globalThis.fetch` been taken over?
- [ ] Do requests that "connect to the proxy itself" use a dedicated direct agent rather than `agent: false`?
- [ ] Has `<-loopback>` been added to `proxyBypassRules` by mistake? Are all loopback services listed?
- [ ] Before injecting a proxy into ffmpeg, did you confirm the current proxy is HTTP rather than SOCKS5?
- [ ] When choosing a port, does this tool support socks5 (if not, use 10810)?
- [ ] Have you run the project's own proxy regression script?
