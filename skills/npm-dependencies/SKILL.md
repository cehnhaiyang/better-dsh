---
name: npm-dependencies
description: Triage order and durable fixes when npm cannot install, a native module fails to compile, or a binary artifact is missing. Covers how to separate the primary cause from the noise in one failure output, the most commonly misunderstood boundary that the Taobao mirror mirrors only the npm registry and not GitHub Releases, which environment variables prebuild-install actually honors and that it does not support socks5, why the proxy belongs in the user-level .npmrc rather than the project, how npm 11's allowScripts gate is approved and which scripts must be refused, and the artifact checklist to verify after every install. Read when npm install/update/ci exits with an error, a native module will not install, npm reports allowScripts is not covered, or the install finished but the thing will not run.
---

# npm Dependency Installation: Triage Order and Durable Fixes

- For how to write proxy code and which port to pick see `proxy-and-networking`
- For how to prove "it is installed" rather than merely "the exit code was 0" see `verification-discipline`

---

## Step one: separate the primary cause from the noise

A failed `npm install` output is full of irrelevant information. **Locate the real failure point first**
(the package that `npm error path` points at in the error), and do not mistake noise for the cause:

| Output | Is it the cause? |
|---|---|
| `npm error path node_modules/<pkg>` + `command failed` | **Yes**, this is the failure point |
| `prebuild-install warn install Request timed out` | **Yes**, the prebuilt package was not downloaded |
| `prebuild ERR! build TypeError: ...` | **Yes**, the fallback to source compilation crashed too |
| `npm warn cleanup Failed to remove ... EBUSY/EPERM` | No, noise from cleaning the directory after failure |
| A long run of `npm warn deprecated prebuild/cmake-js/npmlog/gauge/tar@2.2.2` | No, old packages the **source-compilation fallback path** pulls in temporarily |

**How to tell**: when the deprecated list contains build-toolchain old packages such as `cmake-js`, `npmlog`, `gauge`, `tar@2.2.2`,
it means the install has already fallen into the "compile from source" fallback branch, not the normal install path.

---

## Step two: the mirror's boundary (the most commonly misunderstood point)

**The Taobao mirror mirrors only the npm registry, not GitHub Releases. These are two independent channels.**

What `prebuild-install` needs to download is a `.tar.gz` prebuilt attachment hosted on **GitHub Releases**,
not an npm package. Therefore:

- `registry=https://registry.npmmirror.com` has **no effect whatsoever** on it
- It reads `env.npm_config_download` (`--download` / `-d`) and **does not look at `registry` at all**
- `ELECTRON_MIRROR` is specific to `@electron/get` and has no effect on it either

Moreover npmmirror's binary mirror usually does **not** carry these niche packages:

```
https://registry.npmmirror.com/-/binary/<pkg>/   -> 404
https://cdn.npmmirror.com/binaries/<pkg>/        -> 404
```

Conclusion: **this class of package can only reach GitHub through the proxy**; do not count on switching mirrors.

---

## Step three: `prebuild-install` honors only these environment variables for the proxy

From the source `rc.js`:

```js
proxy: env.npm_config_proxy || env.http_proxy || env.HTTP_PROXY,
'https-proxy': env.npm_config_https_proxy || env.https_proxy || env.HTTPS_PROXY,
```

npm passes `.npmrc` configuration to lifecycle scripts as `npm_config_*`,
so **writing it into `.npmrc` makes it visible to it**:

```json
{"proxy":"http://127.0.0.1:10810","https":"http://127.0.0.1:10810","noproxy":"..."}
```

**It supports HTTP proxies only, not SOCKS5** (it uses `tunnel-agent` internally).
**Use the HTTP port** (10810 on this machine; for the port split see `proxy-and-networking` pitfall 5).

### Where it lands: user level, not project level

As the user explicitly requires, the proxy configuration goes in **`C:\Users\q1505\.npmrc`** (effective for all projects),
and the project must **not** contain an `.npmrc`:

```ini
registry=https://registry.npmmirror.com

proxy=http://127.0.0.1:10810
https-proxy=http://127.0.0.1:10810

# The mirror and local addresses bypass the proxy (a direct domestic connection is faster; going through the proxy is slower)
noproxy=registry.npmmirror.com,cdn.npmmirror.com,localhost,127.0.0.1
```

**`noproxy` cannot be omitted** — without it the mirror traffic also goes through the proxy, which is slower.

Verify that it took effect:

```powershell
npm config get proxy                              # -> http://127.0.0.1:10810
npm config ls -l | Select-String 'config from'    # see which layers were loaded
```

---

## Step four: npm 11's install-script gate (allowScripts)

**From npm 11.17, install scripts do not run by default**; you only get a warning:

```
npm warn allow-scripts 7 packages have install scripts not yet covered by allowScripts
```

**Approval state lands in the `allowScripts` field of `package.json`** (project root), not in `.npmrc`.

```powershell
npm approve-scripts --allow-scripts-pending   # list what is pending
npm approve-scripts <pkg> [<pkg> ...]         # approve
npm deny-scripts <pkg>                        # explicitly refuse
```

The result looks like this:

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

### Pitfall: `ip-set`'s script is `npx only-allow pnpm`

```
ip-set@3.0.0 (preinstall: npx only-allow pnpm)
```

**Approving it makes the whole install fail again** (this project uses npm). You must explicitly `deny-scripts ip-set`.

**General rule**: read the script contents before approving; anything with a package-manager check in `preinstall` must be refused.
Do not reach for `--all` to save effort.

### Once the gate blocks a script, it does not re-run automatically

`npm install` will report `up to date` without re-running the script. To actually execute a blocked script:

```powershell
npm rebuild <pkg> --foreground-scripts
```

---

## Verification checklist (always check after installing)

```powershell
npm approve-scripts --allow-scripts-pending   # expect: No packages with unreviewed install scripts.
npm ls --depth=0                              # expect: top-level deps match package.json, no UNMET
```

Confirm each key artifact exists:

| Package | Artifact |
|---|---|
| `electron` | `node_modules/electron/dist/electron.exe` + `path.txt` + `dist/version` |
| `ffmpeg-static` | `node_modules/ffmpeg-static/ffmpeg.exe` |
| `node-datachannel` | `node_modules/node-datachannel/build/Release/node_datachannel.node` |
| `bufferutil` / `utf-8-validate` / `utp-native` | their respective `prebuilds/` directory |
| `electron-winstaller` | the `vendor/` directory |

That the binary actually runs (**safe**: no window, no Chromium; for the technique see `electron-main-constraints`):

```powershell
$env:ELECTRON_RUN_AS_NODE=1
node_modules\electron\dist\electron.exe -e "console.log(process.versions.node)"
```

**And check that the binary version matches the version declared by the package** — a mismatch means the install script never ran and an old binary was left behind,
in which case any conclusion "based on that runtime's capabilities" is wrong:

```powershell
Get-Content node_modules\electron\dist\version
node -e "console.log(require('./node_modules/electron/package.json').version)"
```

---

## Things not to do

- **Do not delete a binary and re-download it just to verify.** A successful `npm rebuild` does not prove the proxy was used —
  when the file already exists it may simply skip. To prove the proxy works, what matters is whether the **first install** succeeds,
  not a later rebuild. Deleting files as an experiment is a destructive operation, and **you must ask the user first**.
- **Do not run npm or network commands without a timeout**; long tasks go to the background.
- **Do not re-probe things the user already told you** (ports and the like).
- **Do not delete the `allowScripts` field from `package.json`.** After deletion `npm install` blocks the scripts again,
  the binaries for `electron` / `ffmpeg-static` / `node-datachannel` are never generated,
  and the symptom is "it installed but it will not run".

---

## Self-check list

- [ ] Did you locate the real failure point (which package `npm error path` points at)?
- [ ] Did you mistake a deprecated warning from the source-compilation fallback for the cause?
- [ ] Are you hoping a mirror switch will fix a GitHub Releases download (it will not)?
- [ ] Is the proxy in the user-level `.npmrc`? Is it the HTTP port? Is `noproxy` written?
- [ ] Is `allow-scripts-pending` empty? Did you refuse the scripts carrying a package-manager check?
- [ ] Did you re-run the blocked scripts with `npm rebuild <pkg> --foreground-scripts`?
- [ ] Do the key artifacts (`electron.exe` / `ffmpeg.exe` / `.node`) actually exist?
- [ ] Does the binary version match what `package.json` declares?
- [ ] Did you delete files just to verify? (That is destructive — ask first.)
