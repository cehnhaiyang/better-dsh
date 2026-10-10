---
name: npm-dependencies
description: npm 装不上、原生模块编译失败、二进制产物缺失时的排查顺序与持久修复。含如何从一次失败输出里分清主因与噪音、淘宝镜像只镜像 registry 不镜像 GitHub Releases 这条最容易误解的边界、prebuild-install 只认哪几个环境变量且不支持 socks5、代理该写进用户级 .npmrc 而不是项目里、npm 11 的 allowScripts 门禁如何审批与哪些脚本必须拒绝、以及装完必查的产物清单。npm install/update/ci 报错退出、原生模块装不上、npm 提示 allowScripts 未覆盖、或装完了却跑不起来时读。
---

# npm 依赖安装：排查顺序与持久修复

- 代理代码怎么写、端口怎么选见 `proxy-and-networking`
- 怎么证明「装好了」而不只是「退出码是 0」见 `verification-discipline`

---

## 第一步：分清主因和噪音

一次失败的 `npm install` 输出里有大量无关信息。**先定位真正的失败点**
（报错里 `npm error path` 指向的那个包），不要把噪音当原因：

| 输出 | 是不是原因 |
|---|---|
| `npm error path node_modules/<pkg>` + `command failed` | **是**，这是失败点 |
| `prebuild-install warn install Request timed out` | **是**，预编译包没下到 |
| `prebuild ERR! build TypeError: ...` | **是**，回退源码编译也崩了 |
| `npm warn cleanup Failed to remove ... EBUSY/EPERM` | 否，失败后清理目录的噪音 |
| 一大串 `npm warn deprecated prebuild/cmake-js/npmlog/gauge/tar@2.2.2` | 否，**源码编译回退路径**临时拉的老包 |

**判断方法**：deprecated 列表里出现 `cmake-js`、`npmlog`、`gauge`、`tar@2.2.2`
这类构建工具链老包 —— 说明它已经掉进「从源码编译」的回退分支，不是正常安装路径。

---

## 第二步：镜像的边界（最容易误解的一点）

**淘宝镜像只镜像 npm registry，不镜像 GitHub Releases。这是两条独立通道。**

`prebuild-install` 要下载的是挂在 **GitHub Releases** 上的 `.tar.gz` 预编译附件，
不是 npm 包。所以：

- `registry=https://registry.npmmirror.com` 对它**毫无作用**
- 它读的是 `env.npm_config_download`（`--download` / `-d`），**根本不看 `registry`**
- `ELECTRON_MIRROR` 是 `@electron/get` 专用的，对它也没有任何作用

而且 npmmirror 的二进制镜像里往往**没有**这些小众包：

```
https://registry.npmmirror.com/-/binary/<pkg>/   → 404
https://cdn.npmmirror.com/binaries/<pkg>/        → 404
```

结论：**这类包只能靠代理走 GitHub**，不能指望换镜像。

---

## 第三步：`prebuild-install` 的代理只认这几个环境变量

源码 `rc.js`：

```js
proxy: env.npm_config_proxy || env.http_proxy || env.HTTP_PROXY,
'https-proxy': env.npm_config_https_proxy || env.https_proxy || env.HTTPS_PROXY,
```

npm 会把 `.npmrc` 的配置以 `npm_config_*` 传给生命周期脚本，
所以**写进 `.npmrc` 就能被它读到**：

```json
{"proxy":"http://127.0.0.1:10810","https":"http://127.0.0.1:10810","noproxy":"..."}
```

**只支持 HTTP 代理，不支持 SOCKS5**（内部用 `tunnel-agent`）。
**端口用 HTTP 那个口**（本机是 10810；端口分工见 `proxy-and-networking` 坑 5）。

### 落盘位置：用户级，不是项目级

按用户明确要求，代理配置写在 **`C:\Users\q1505\.npmrc`**（对所有项目生效），
项目里**不**放 `.npmrc`：

```ini
registry=https://registry.npmmirror.com

proxy=http://127.0.0.1:10810
https-proxy=http://127.0.0.1:10810

# 镜像和本机地址不走代理（国内直连更快，绕代理反而慢）
noproxy=registry.npmmirror.com,cdn.npmmirror.com,localhost,127.0.0.1
```

**`noproxy` 不能省** —— 不写的话镜像流量也绕代理，反而更慢。

验证是否生效：

```powershell
npm config get proxy                              # → http://127.0.0.1:10810
npm config ls -l | Select-String 'config from'    # 看加载了哪几层
```

---

## 第四步：npm 11 的 install 脚本门禁（allowScripts）

**npm 11.17 起，install 脚本默认不执行**，只给一条 warn：

```
npm warn allow-scripts 7 packages have install scripts not yet covered by allowScripts
```

**批准状态落在 `package.json` 的 `allowScripts` 字段**（项目根），不是 `.npmrc`。

```powershell
npm approve-scripts --allow-scripts-pending   # 列出待审
npm approve-scripts <pkg> [<pkg> ...]         # 批准
npm deny-scripts <pkg>                        # 显式拒绝
```

结果长这样：

```json
"allowScripts": {
    "bufferutil@4.1.0": true,
    "electron-winstaller@5.4.0": true,
    "ffmpeg-static@5.3.0": true,
    "node-datachannel@0.32.3": true,
    "utf-8-validate@6.0.6": true,
    "utp-native@2.5.3": true,
    "ip-set": false
}
```

### 陷阱：`ip-set` 的脚本是 `npx only-allow pnpm`

```
ip-set@3.0.0 (preinstall: npx only-allow pnpm)
```

**批准它会让整个安装再次失败**（项目用的是 npm）。必须显式 `deny-scripts ip-set`。

**通用规则**：批准前先看清楚脚本内容，`preinstall` 里带包管理器校验的一律拒绝。
不要图省事用 `--all`。

### 门禁拦下后，脚本不会自动补跑

`npm install` 会显示 `up to date` 而不重跑脚本。要让被拦下的脚本真正执行：

```powershell
npm rebuild <pkg> --foreground-scripts
```

---

## 验证清单（装完必查）

```powershell
npm approve-scripts --allow-scripts-pending   # 期望：No packages with unreviewed install scripts.
npm ls --depth=0                              # 期望：顶层依赖与 package.json 一致，无 UNMET
```

逐个确认关键产物存在：

| 包 | 产物 |
|---|---|
| `electron` | `node_modules/electron/dist/electron.exe` + `path.txt` + `dist/version` |
| `ffmpeg-static` | `node_modules/ffmpeg-static/ffmpeg.exe` |
| `node-datachannel` | `node_modules/node-datachannel/build/Release/node_datachannel.node` |
| `bufferutil` / `utf-8-validate` / `utp-native` | 各自的 `prebuilds/` 目录 |
| `electron-winstaller` | `vendor/` 目录 |

二进制真的能跑（**安全**：不弹窗、不起 Chromium，姿势见 `electron-main-constraints`）：

```powershell
$env:ELECTRON_RUN_AS_NODE=1
node_modules\electron\dist\electron.exe -e "console.log(process.versions.node)"
```

**并且核对二进制版本与包声明版本一致** —— 不一致说明 install 脚本没跑成、留的是旧二进制，
此时任何「基于该运行时能力」的结论都是错的：

```powershell
Get-Content node_modules\electron\dist\version
node -e "console.log(require('./node_modules/electron/package.json').version)"
```

---

## 不要做的事

- **不要为了验证而删掉二进制再重下。** `npm rebuild` 成功 ≠ 走了代理 ——
  文件已存在时它可能直接跳过。要证明代理生效，看的是**第一次安装**能否成功，
  不是事后重建。删文件做实验属破坏性操作，**必须先问用户**。
- **不要无超时地跑 npm 或网络命令**，长任务放后台。
- **不要重复探测用户已经告诉你的东西**（端口等）。
- **不要删 `package.json` 里的 `allowScripts` 字段。** 删掉后 `npm install` 会重新拦截脚本，
  `electron` / `ffmpeg-static` / `node-datachannel` 的二进制都不会生成，
  表现为「装完了但跑不起来」。

---

## 自查清单

- [ ] 定位到真正的失败点了吗（`npm error path` 指向哪个包）？
- [ ] 有没有把源码编译回退路径的老包 deprecated 警告当成原因？
- [ ] 是不是在指望换镜像解决 GitHub Releases 的下载（那没用）？
- [ ] 代理写进用户级 `.npmrc` 了吗？用的是 HTTP 端口吗？`noproxy` 写了吗？
- [ ] `allow-scripts-pending` 清空了吗？带包管理器校验的脚本拒绝了吗？
- [ ] 被拦下的脚本用 `npm rebuild <pkg> --foreground-scripts` 补跑了吗？
- [ ] 关键产物（`electron.exe` / `ffmpeg.exe` / `.node`）都实际存在吗？
- [ ] 二进制版本与 `package.json` 声明一致吗？
- [ ] 有没有为了验证而删文件？（那是破坏性操作，先问）
