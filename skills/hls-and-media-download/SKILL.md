---
name: hls-and-media-download
description: 播放或下载 HLS 流时的硬事实与排障法。核心事实是分片 4xx 时崩掉的是播放器而非源站——hls.js 对 4xx 一次都不重试且直接判死、唯一能优雅跳过的路径只在直播流生效、无参数 startLoad 会重撞同一段、VOD 下超过 2 秒的空洞不会自动跳过；ffmpeg 则默认就会跳坏分片但退出码仍是 0。另含"分层探测"定位到底是源站坏了还是我们写错了、-progress 解析与 out_time_ms 的微秒陷阱、percent 为 null 的正确处理、以及取消下载要杀干净子进程与半成品文件。播放 HLS/m3u8 报错或卡住时、看到分片 404/403 时、要判断"是源站资源坏了还是播放器代码有问题"时、或要做流媒体下载进度与取消时读。
---

# HLS 播放与媒体下载

**核心事实：分片 404 时，崩掉的是播放器，不是源站。**
源站只是「这个文件没有」，而 hls.js 会把它升级成致命错误并停掉整个视频。

- 出网与代理见 `proxy-and-networking`
- 主进程模块边界见 `electron-main-constraints`
- 探测脚本自身的纪律见 `verification-discipline`

---

## 一、第一步：分层探测，先分清是谁的错

**不要一看到 404 就改代码，也不要一口咬定「源站问题」。**
按这条链一层层走，每层记下状态码 —— 断在哪一层，问题就在那一层。

```
① 播放页 HTML          → 页面里那个 .m3u8 的真实地址（往往和你手上的不一样）
② master 清单          → 变体列表
③ variant 清单         → 分片列表 + EXT-X-KEY
④ 单个分片             → 200 还是 404
```

> **不要假设 m3u8 与页面同域，也不要假设变体与清单同域。** 逐层打印实际地址 ——
> 一条链路跨三四个域名是常态，只看报错 URL 会以为只有一台机器。

### 判据表：区分「源站坏了」与「我们写错了」

| 现象 | 结论 |
|---|---|
| 带各种 Referer 测都是同一个码 | **不是防盗链**（防盗链会因 Referer 变化） |
| 分片 404，但同域根路径 403 | 服务器活着、在按规则拒绝；404 是「这个文件真没有」 |
| 同一份清单里**另一台主机**的分片是 200 | 问题锁定在坏的那台存储节点，不是清单也不是我们 |
| 同一条重复测三轮结果一致 | 不是网络抖动，是**稳定的缺失** |
| 站点自己的播放器也放不了 | 站点自己踩同一个坑，不是我们集成错了 |
| 清单里混着多个日期目录 | 清单由多次转码拼接，**散落缺失**的高危信号 |

### 全量测，别抽样下结论

**「要不要给用户设个上限」这类决定必须基于全量数据。**
并发测全部段（限流 10~12 条）也就一两分钟，不要省这一步。

**还要看分布，不只看比例**：同样 96.9% 缺失，
「每 10 段坏 3 段」（散落）和「连续坏几百段」（整片没了）是完全不同的两件事。
打印一张状态图最直观：

```
状态图（. = 可用, X = 坏）
   0 .......XX..X.XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
 100 XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

---

## 二、hls.js 的四条硬事实（1.7.3，读源码 + 实测）

### 事实 1：对 4xx **一次都不重试**

`node_modules/hls.js/src/utils/error-helper.ts`：

```js
export function retryForHttpStatus(httpStatus) {
  // Do not retry on status 4xx, status 0 (CORS error), or undefined
  return offlineHttpStatus(httpStatus) ||
    (!!httpStatus && (httpStatus < 400 || httpStatus > 499));
}
```

`shouldRetry()` 里是 `retryCount < maxNumRetry && (retryForHttpStatus(...) || isTimeout)`
—— 4xx 让第二个条件恒假，所以**配多少 `maxNumRetry` 都没用**。
（这其实是对的：源站说文件不存在，重试永远不会成功。）

### 事实 2：唯一能优雅跳过的路径**只在直播流生效**

`src/controller/base-stream-controller.ts` 里 `treatAsGap(frag)` 是「把这段当空洞跳过」，
但它的前置条件是：

```js
if (!retry && noAlternate && isMediaFragment(frag) && live &&
    frag.sn < levelDetails.endSN && !isUnusableKeyError(data)) {
  this.treatAsGap(frag);
}
```

**`live` 为真才行。** VOD 清单带 `#EXT-X-PLAYLIST-TYPE:VOD` + `#EXT-X-ENDLIST`，
走不到这里 —— 于是直接落到下一分支，最终 `error-controller.ts` 里 `data.fatal = true`。

### 事实 3：`startLoad()` 无参数 = **从当前位置重来**，会再撞同一个坏分片

```js
startLoad(startPosition = -1, skipSeekToStartPosition) { ... }
```

不传参数时它用 `lastCurrentTime`，也就是**回到同一段**。
所以「重试三次 `hls.startLoad()` 后放弃」这种写法是无效的：三次都在撞同一段。

**要跳过就必须传位置**：`hls.startLoad(frag.start + frag.duration, true)`。

### 事实 4：VOD 下超过 2 秒的空洞**不会自动跳**

`src/controller/gap-controller.ts`：

```js
export const MAX_START_GAP_JUMP = 2.0;
// ...
const maxStartGapJump = isLive ? levelDetails.targetduration * 2 : MAX_START_GAP_JUMP;
```

所以**光调 `startLoad(pos)` 不够** —— 缓冲区会留下一个洞，而播放头还在洞前面，
VOD 下 gap-controller 不会帮你跨过去，画面就卡在洞口转圈。
**必须同时把播放头挪过去**：

```ts
video.currentTime = resumeAt;
hls.startLoad(resumeAt, true);
```

### 附：`fragmentTracker` **没有**暴露在 Hls 实例上

`hls.ts` 里是 `const fragmentTracker = new FragmentTracker(this)`（局部变量），
再 `coreComponents.push(fragmentTracker)`。
所以**不能** `hls.fragmentTracker.addAsGap(...)`。想手动标记空洞，
只能走上面的「挪播放头 + startLoad(pos)」。

### 落地写法

```ts
hls.on(Hls.Events.ERROR, (_, data) => {
  const httpCode = data.response?.code;
  const frag = data.frag;
  // 必须在致命判断【之前】拦下：4xx 不会重试，会直接 fatal
  if (frag && typeof httpCode === 'number' && httpCode >= 400 && httpCode < 500) {
    skipped += 1;
    const resumeAt = frag.start + frag.duration;
    try {
      if (Number.isFinite(resumeAt)) {
        video.currentTime = resumeAt;      // 跨过空洞
        hls.startLoad(resumeAt, true);     // 从坏段之后继续
      } else {
        hls.startLoad();
      }
    } catch { hls.startLoad(); }
    setMediaWarning(`第 ${frag.sn} 段已失效（HTTP ${httpCode}），已跳过`);
    return;                                 // 不进致命分支，不 destroyHls
  }
  if (!data.fatal) return;
  // ... 原有 NETWORK_ERROR / MEDIA_ERROR 处理
});
```

**`data.frag.sn` 是清单里的序号**，可以直接给用户看；`frag.start` / `frag.duration` 是秒。
`Hls.ErrorDetails.FRAG_LOAD_ERROR` 也可用，但**按 `response.code` 判断更直接**
（同一个 404 可能以 `fragLoadError` 或别的 details 到达）。

---

## 三、ffmpeg 下载：它**默认就会跳**坏分片

**这是最容易搞错的一点。** 真实坏流下（ffmpeg 6.1.1）：

```
[hls @ ...] HTTP error 404 Not Found
[hls @ ...] Failed to open segment 15 of playlist 0
[hls @ ...] Segment 15 of playlist 0 failed too many times, skipping
[hls @ ...] Opening '.../segment.ts' for reading     ← 继续下一个
EXIT=0
```

**跳过它本来就做，退出码还是 0。** 所以：

- **不要**去加什么「跳过参数」（`-seg_max_retry 0` 也照样跳，加了没意义）
- 缺的是**让用户知道少了东西** —— 否则一份缺几百段的残片会被当成「下载完成」

### 数它的跳过次数：跨 chunk 匹配要两个缓冲

```js
const SKIP_MARK = 'failed too many times, skipping';
let stderrTail = '';    // 只为失败时报错取末尾几行，封顶防内存膨胀
let stderrCarry = '';   // 只为跨 chunk 拼接
let skipped = 0;

ffmpeg.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  stderrTail = (stderrTail + text).slice(-8000);
  const combined = stderrCarry + text;
  const countIn = (s) => s.split(SKIP_MARK).length - 1;
  skipped += countIn(combined) - countIn(stderrCarry);  // 减去已数过的
  stderrCarry = combined.slice(-(SKIP_MARK.length * 2));
});
```

**为什么不能只用一个缓冲**：拿 `stderrTail` 兼做拼接的话，截断会把已经数过的匹配挤出去，
下一轮又数一遍（或漏数）。两个缓冲各司其职 —— 逐字符喂入 7 条标记仍准确得到 7。

### stderr 不能无限累积

ffmpeg 每个分片都打进度行，长片下 stderr 能到几十 MB。
**只为最后取末尾三行报错而全程攒着，是纯粹的内存浪费** —— 封顶 8KB 足够。

---

## 四、ffmpeg 的真实进度：`-progress pipe:1`

```bash
ffmpeg -y ... -progress pipe:1 -i <url> -c copy out.mp4
```

输出是**机器可解析的 key=value 行**，每块以 `progress=continue|end` 收尾：

```
bitrate=  -0.0kbits/s
total_size=262192
out_time_ms=2948933          ← 注意单位是【微秒】，ffmpeg 的历史命名遗留
out_time=00:00:02.948933
speed=1.26x
progress=continue
```

### 三个必须知道的点

1. **`out_time_ms` 是微秒不是毫秒。** 除以 `1e6` 得秒。
2. **总时长 `Duration:` 在 stderr，进度在 stdout，两者不同步。**
   要在 stderr 里正则抓一次存下来：`/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/`
3. **要等一块结束（`progress=`）再算百分比。** 半块数据（有 `out_time_ms`
   没 `total_size`）会算出跳变的百分比。

```js
if (key === 'progress') sawBlockEnd = true;
// ...
if (!sawBlockEnd) return;
const percent = totalSeconds > 0 && processedSeconds > 0
  ? Math.min(100, Math.round(processedSeconds / totalSeconds * 100))
  : null;   // ← 拿不到就 null，不编造百分比
```

**`stdout` 不能再 `ignore`** —— 原来 `stdio: ['ignore','ignore','pipe']`
把 stdout 丢掉了，进度行也就没了。

### 验证结果（可复现）

真实流跑 20 秒：识别总时长 2210.88 秒、9 帧进度、8 帧有百分比、百分比单调不减。

---

## 五、进度反馈：`percent: null` 是特性，不是缺陷

直链文件没有 `Content-Length`、ffmpeg 还没打印 `Duration` 时，
**如实返回 `null` 并显示不定态扫动条**，而不是拿一个假百分比骗人。

```tsx
{progress?.percent != null ? (
  <div style={{ width: `${progress.percent}%` }} />
) : (
  <div className="indeterminate h-full w-1/3" />   // 来回扫动
)}
```

---

## 六、取消下载：子进程和请求都要能杀

- **ffmpeg 是独立进程**，`child.kill()` 即停，但它**不会清理半成品文件**，得自己删
- **HTTP 直链**要 `request.destroy()`
- **半成品一律删掉**：留着会让用户以为「下过了」，实际是坏的
- **取消不算失败**：不要在界面上弹红色错误（用户自己点的）
- 用 **Map 按 url 记账**而不是单个变量 —— 单变量会让后一条把前一条顶掉，
  前一条就再也取消不了

---

## 自查清单

- [ ] 报错先分层探测过吗（页面 → master → variant → 分片）？
- [ ] 判断「源站问题」之前，有没有对照过**同一清单里的另一台主机**？
- [ ] 有没有用**全量**（而非抽样）数据支撑「要不要设上限」这类决定？
- [ ] 看的是**比例**还是**分布**（散落缺失 vs 连续整片缺失）？
- [ ] 跳过分片时有没有**同时挪播放头**（VOD 下 MAX_START_GAP_JUMP = 2s）？
- [ ] 拦截逻辑是不是放在**致命判断之前**？
- [ ] ffmpeg 跳过次数有没有如实告诉用户（退出码 0 会掩盖缺失）？
- [ ] 进度拿不到总长时，是不是如实显示不定态而不是假百分比？
- [ ] 取消后有没有删掉半成品文件？记账用的是 Map 还是单变量？
