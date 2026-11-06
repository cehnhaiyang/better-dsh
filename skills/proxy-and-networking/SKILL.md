---
name: proxy-and-networking
description: How to correctly configure the proxy on this machine, where the local proxy exposes two ports with different protocols — 10808 is SOCKS5-only (vcore.exe) and 10810 is HTTP-only (Whale.exe) — so the one rule that matters is matching the port to what each tool can speak. git, npm, pnpm, prebuild-install, @electron/get and ffmpeg only speak HTTP and must take 10810; socks5-capable clients such as curl, browsers and SSH tunnels take 10808. Covers the verified configuration for git, npm, user environment variables, SSH via connect.exe over 10808, and the Windows system proxy, the exact probe commands that re-derive which port speaks which protocol, the real end-to-end checks with the reverse control that proves the proxy is actually doing the work, and the failure signatures of a port/protocol mismatch. Read before configuring any tool to use the proxy, when a download times out on a direct connection, when npm or prebuild-install cannot fetch a binary, or when a proxy config looks right but does not work.
---

# Local Proxy — Ports and Configuration

A direct connection to github.com measurably **times out after 12 seconds**, so the proxy is not optional.
The local proxy is provided by `Whale.exe`, and it opens **two ports with different protocols**.
That single fact is the root of every proxy problem on this machine.

---

## 1. The two ports

| Port | Process | Protocol | `curl -x` to github |
|---|---|---|---|
| **10808** | `vcore.exe` | **SOCKS5 only** | `socks5://` -> 200; `http://` -> `Proxy CONNECT aborted` |
| **10810** | `Whale.exe` | **HTTP only** | `http://` -> 200; `socks5://` -> timeout |

Both are child processes of `Whale.exe`.
**10808 is not "the other HTTP port", and 10810 is not "the other SOCKS5 port"** — they are mutually incompatible.

Confirm the ports are listening before configuring anything, otherwise every later diagnosis is wasted:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 10808,10810 |
  ForEach-Object { $p=Get-Process -Id $_.OwningProcess -EA SilentlyContinue
                   "{0}  pid={1}  {2}" -f $_.LocalPort,$_.OwningProcess,$p.ProcessName }
```

Which port speaks which protocol is the premise for everything below.
Re-measure it after changing machines or upgrading Whale — **trust these four probes, not documentation**:

```powershell
curl.exe -sS -o NUL -w "%{http_code}`n" -x http://127.0.0.1:10808    --max-time 15 https://github.com
curl.exe -sS -o NUL -w "%{http_code}`n" -x socks5h://127.0.0.1:10808 --max-time 15 https://github.com
curl.exe -sS -o NUL -w "%{http_code}`n" -x http://127.0.0.1:10810    --max-time 15 https://github.com
curl.exe -sS -o NUL -w "%{http_code}`n" -x socks5h://127.0.0.1:10810 --max-time 15 https://github.com
```

### Failure signatures — read the error, do not guess

| Symptom | Meaning |
|---|---|
| `Proxy CONNECT aborted`, returned **immediately** | an HTTP proxy was pointed at the SOCKS5 port — **wrong port** |
| times out after 15s with no response | SOCKS5 pointed at the HTTP port, or the proxy process is not running |
| direct connection times out but the proxy returns 200 | normal; the proxy is doing its job |

---

## 2. The one rule for picking a port

**What decides the port is whether the tool can speak SOCKS5 at all.**

| Tool | Port | Why |
|---|---|---|
| git, npm, pnpm, prebuild-install, `@electron/get`, ffmpeg | **10810** | they accept an HTTP proxy only |
| curl (`socks5h://`), browsers, SSH tunnels | **10808** | they speak socks5 |
| any program reading the `HTTPS_PROXY` environment variable | 10810 | only one value fits there; use the universal one |

`prebuild-install` uses `tunnel-agent` internally, so handing it `socks5://` fails outright — **worse than not proxying at all**.

---

## 3. Configuration per tool

### 3.1 git (global)

```powershell
git config --global http.proxy  'http://127.0.0.1:10810'
git config --global https.proxy 'http://127.0.0.1:10810'
```

This covers `https://` remotes only (a libcurl CONNECT tunnel). `git@github.com:` goes over SSH — see 3.4.

> git **also reads** the `HTTPS_PROXY` environment variable (libcurl behaviour), so once 3.3 is in place the proxy is configured twice. Redundant but harmless; `http.proxy` is the authoritative value.

To switch to socks5 instead (measured working, and `socks5h` resolves DNS on the proxy side which survives poisoned local DNS):

```powershell
git config --global http.proxy 'socks5h://127.0.0.1:10808'
```

### 3.2 npm / pnpm (`~/.npmrc`)

```ini
registry=https://registry.npmmirror.com
proxy=http://127.0.0.1:10810
https-proxy=http://127.0.0.1:10810
noproxy=registry.npmmirror.com,localhost,127.0.0.1,::1
```

Three points:

- **Both `proxy` and `https-proxy` must be 10810.** This file once carried `proxy=http://127.0.0.1:10808`, pointing an HTTP proxy at the SOCKS5 port; every download through it failed with `Proxy CONNECT aborted`.
- **`noproxy` keeps the Taobao mirror on a direct connection.** It is reachable domestically (measured 0.86s direct versus 1.57s through the proxy), and it keeps npm working if the proxy process dies.
- npm reads nothing but `~/.npmrc`, so confirm with `npm config get proxy` rather than by looking at the file.

### 3.3 User environment variables (`HKCU\Environment`)

These cover curl, pip, Go, Node, and anything else that reads the environment:

```powershell
$P  = 'http://127.0.0.1:10810'
$NO = 'localhost,127.0.0.1,::1,0.0.0.0,*.local,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,api.deepseek.com'
foreach($n in 'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'){
    [Environment]::SetEnvironmentVariable($n, $P, 'User')
}
foreach($n in 'NO_PROXY','no_proxy'){
    [Environment]::SetEnvironmentVariable($n, $NO, 'User')
}
```

- **Write both cases.** Some programs read only the upper-case form, some only lower-case, and Node reads only lower-case.
- **`NO_PROXY` is comma-separated** and accepts CIDR ranges. Do not copy Chromium's `proxyBypassRules` syntax into it — that is a different, semicolon-separated mechanism.
- **`api.deepseek.com` is excluded deliberately.** It is directly reachable (measured 401, i.e. connected), and listing it keeps the AI gateway from depending on the proxy process being alive — quitting Whale must not take the model calls with it.
- **`127.0.0.1` must be in `NO_PROXY`**, or local services (dev servers, local gateways, DSH's own `127.0.0.1:3080`) get pushed into the proxy.

Broadcast once afterwards so newly launched programs pick the values up without a re-login:

```powershell
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class EnvBc {
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
  public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);
}
'@
$r=[UIntPtr]::Zero
[EnvBc]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
```

**Terminals already open do not update** — an inherited environment block never refreshes. An empty `$env:HTTPS_PROXY` there does not mean the variable is unset; open a new terminal. git and npm read config files and are unaffected either way.

### 3.4 SSH (`~/.ssh/config`)

`git@github.com:` goes over SSH and has nothing to do with `http.proxy`; it needs its own configuration.
Use `connect.exe` from Git for Windows to tunnel through SOCKS5:

```
# 10808 is socks5 — connect.exe's -S means socks5, while -H would mean http
Host github.com
    HostName github.com
    User git
    Port 22
    ProxyCommand "C:/Program Files/Git/mingw64/bin/connect.exe" -S 127.0.0.1:10808 %h %p

Host ssh.github.com
    HostName ssh.github.com
    User git
    Port 443
    ProxyCommand "C:/Program Files/Git/mingw64/bin/connect.exe" -S 127.0.0.1:10808 %h %p
```

- When port 22 is blocked, `ProxyCommand` makes **the proxy side** open port 22, so whether the local machine blocks it is irrelevant. `ssh.github.com` on 443 is the fallback for networks that only allow 443.
- Use forward slashes in the path, and quote the whole thing when it contains spaces.
- Confirm the binary exists with `Test-Path 'C:\Program Files\Git\mingw64\bin\connect.exe'`.

### 3.5 Windows system proxy (WinINET)

```powershell
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' |
  Select-Object ProxyEnable,ProxyServer
# ProxyEnable = 1, ProxyServer = 127.0.0.1:10810
```

Browsers and Electron sessions use this. It points at **10810 (HTTP)** because the Chromium stack speaks both and HTTP is the more universal choice. Whale maintains this entry itself; normally do not touch it.

`netsh winhttp show proxy` is a **separate** mechanism (machine-wide WinHTTP) and reporting `Direct access` there is normal — it does not affect the browser proxy above.

---

## 4. Verification

Correctness is judged by real requests, never by reading config files.
**Always include the reverse control** — test the direct connection too, otherwise nothing proves the proxy is doing the work:

```powershell
$env:GIT_TERMINAL_PROMPT='0'

# positive
git ls-remote --heads https://github.com/<owner>/<repo>.git
git clone --depth 1 https://github.com/<owner>/<repo>.git "$env:TEMP\p-test"
npm view react version --registry=https://registry.npmjs.org

# reverse control — direct must fail, proxy must return 200
curl.exe -sS -o NUL -w "direct -> %{http_code}`n" --max-time 8  --noproxy '*'            https://github.com
curl.exe -sS -o NUL -w "proxy  -> %{http_code}`n" --max-time 15 -x http://127.0.0.1:10810 https://github.com
```

Measured baseline (2026-11, useful for telling "slower" apart from "not proxied"):

| Check | Result |
|---|---|
| `git ls-remote` | exit 0, 1.5s |
| `git clone` of a real repository | exit 0, 3.3s, 140 files |
| `npm view react` (npmjs.org, through the proxy) | exit 0, 1.6s |
| `npm view react` (Taobao mirror, direct) | exit 0, 0.9s |
| direct connection to github | times out |
| `-x http://127.0.0.1:10810` | 200 |

**Read SSH results carefully.** `ssh -T git@github.com` returning `Permission denied (publickey)` after about 3 seconds means the **transport is working and authentication is the only thing failing** — i.e. the proxy is fine. Hanging for fifteen seconds before `Connection timed out` is what an ineffective proxy looks like.

To verify the environment variables actually landed, read them from a **fresh process** — the current process shows the inherited block and will mislead you:

```powershell
$out = Join-Path $env:TEMP 'envprobe.txt'
$act = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c (set HTTP_PROXY & set HTTPS_PROXY & set NO_PROXY) > `"$out`""
$pr  = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'env-probe' -Action $act -Principal $pr -Force | Out-Null
Start-ScheduledTask 'env-probe'; Start-Sleep 2; Get-Content $out
Unregister-ScheduledTask 'env-probe' -Confirm:$false
```

---

## 5. Pitfalls

- **Using 10808 as an HTTP proxy** is the most frequent mistake on this machine; npm's `proxy` was once written exactly that way. The symptom is `Proxy CONNECT aborted` returned **immediately** rather than timing out — seeing it means fix the port, nothing else.
- **`HTTPS_PROXY` holds an `http://` value** despite its name. It means "reach https through an HTTP proxy", not "an HTTPS proxy". `http://127.0.0.1:10810` is correct; writing `https://` there breaks it.
- **`socks5h` differs from `socks5` only in where DNS resolves.** The `h` variant resolves on the proxy side, which still works when local DNS is poisoned; plain `socks5` resolves locally and sends only the IP. git and curl support `h`, many tools do not — which is why the default is the HTTP port 10810.
- **When Whale is not running, neither port listens** and every proxy setting fails together. Check `Get-NetTCPConnection` before suspecting the configuration.
- **Proxy configuration lives in three layers, and changing one does not update the others** — application config (`~/.gitconfig`, `~/.npmrc`), environment variables, and the system proxy. Inspect all three when troubleshooting.

---

## Self-check list

- [ ] Are 10808 and 10810 listening? Is `Whale.exe` running?
- [ ] Can this tool speak SOCKS5? If not, use **10810**.
- [ ] Does the scheme you wrote (`http://` or `socks5://`) match the protocol of the target port?
- [ ] Does `NO_PROXY` contain `localhost` / `127.0.0.1` / `::1`, in comma-separated form?
- [ ] Are **both** channels configured for git — the HTTPS remote and the SSH remote?
- [ ] Did the verification include the reverse control (`--noproxy '*'` must fail)?
- [ ] Were the environment variables verified in a **fresh process** rather than the current terminal?
