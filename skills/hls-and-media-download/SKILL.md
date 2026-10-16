---
name: hls-and-media-download
description: Hard facts and troubleshooting method for playing or downloading HLS streams. The core fact is that when a segment 4xx's, it is the player that breaks, not the origin — hls.js never retries 4xx and fails the whole video, the only graceful skip path exists for live streams only, a no-argument startLoad re-hits the same segment, and under VOD a gap longer than 2 seconds is not skipped automatically; ffmpeg on the other hand skips bad segments by default yet still exits 0. Also covers layered probing to decide whether the origin is broken or our code is, -progress parsing and the out_time_ms microsecond trap, correct handling of a null percent, and cancelling a download by killing both child process and request and deleting the partial file. Read when playing HLS/m3u8 errors out or stalls, when you see segment 404/403, when you must judge "is the origin's asset broken or is our player code wrong", or when building stream download progress and cancellation.
---

# HLS Playback and Media Download

**Core fact: when a segment 404s, it is the player that breaks, not the origin.**
The origin merely means "this file does not exist", but hls.js upgrades that into a fatal error and stops the whole video.

- For outbound networking and proxies see `proxy-and-networking`
- For main-process module boundaries see `electron-main-constraints`
- For discipline of probe scripts themselves see `verification-discipline`

---

## 1. Step one: layered probing — first establish whose fault it is

**Do not start editing code the moment you see a 404, and do not flatly declare "it's the origin's problem".**
Walk this chain layer by layer and record the status code at each layer — whichever layer it breaks at is where the problem is.

```
(1) Playback page HTML   -> the real address of that .m3u8 in the page (often not the one you have)
(2) master playlist      -> variant list
(3) variant playlist     -> segment list + EXT-X-KEY
(4) a single segment     -> 200 or 404
```

> **Do not assume the m3u8 shares a domain with the page, and do not assume variants share a domain with the playlist.** Print the actual address at each layer —
> a single chain spanning three or four domains is normal; looking only at the failing URL makes you think there is just one machine.

### Decision table: telling "the origin is broken" from "our code is wrong"

| Symptom | Conclusion |
|---|---|
| The same code comes back with every kind of Referer | **Not hotlink protection** (hotlink protection would vary with Referer) |
| Segment 404, but the same domain's root path gives 403 | The server is alive and refusing by rule; the 404 means "this file really is absent" |
| Segments from **another host** in the same playlist are 200 | The problem is locked to the bad storage node, not the playlist and not us |
| Repeating the same request three rounds gives identical results | Not network jitter, but a **stable absence** |
| The site's own player cannot play it either | The site hits the same pit; our integration is not the error |
| The playlist mixes several date directories | The playlist was stitched from multiple transcodes — a high-risk signal for **scattered absence** |

### Measure everything; do not conclude from a sample

**Decisions like "should we impose a limit on the user" must rest on complete data.**
Concurrency-testing every segment (throttled to 10-12 at a time) takes only a minute or two; do not skip this step.

**Also look at the distribution, not just the ratio**: the same 96.9% missing,
"3 bad out of every 10" (scattered) and "hundreds bad in a row" (a whole stretch gone) are two entirely different things.
Printing a status map is the most direct way:

```
Status map (. = usable, X = bad)
   0 .......XX..X.XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
 100 XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

---

## 2. Four hard facts about hls.js (1.7.3, from source plus measurement)

### Fact 1: it does **not retry 4xx even once**

`node_modules/hls.js/src/utils/error-helper.ts`:

```js
export function retryForHttpStatus(httpStatus) {
  // Do not retry on status 4xx, status 0 (CORS error), or undefined
  return offlineHttpStatus(httpStatus) ||
    (!!httpStatus && (httpStatus < 400 || httpStatus > 499));
}
```

Inside `shouldRetry()` it is `retryCount < maxNumRetry && (retryForHttpStatus(...) || isTimeout)`
— 4xx makes the second condition permanently false, so **no value of `maxNumRetry` helps**.
(This is in fact correct: the origin said the file does not exist, so retrying would never succeed.)

### Fact 2: the only graceful skip path **works for live streams only**

In `src/controller/base-stream-controller.ts`, `treatAsGap(frag)` means "treat this segment as a hole and skip it",
but its precondition is:

```js
if (!retry && noAlternate && isMediaFragment(frag) && live &&
    frag.sn < levelDetails.endSN && !isUnusableKeyError(data)) {
  this.treatAsGap(frag);
}
```

**`live` must be true.** A VOD playlist carrying `#EXT-X-PLAYLIST-TYPE:VOD` + `#EXT-X-ENDLIST`
never reaches this point — so it falls straight to the next branch and ends up at `data.fatal = true` in `error-controller.ts`.

### Fact 3: `startLoad()` with no arguments = **restart from the current position**, hitting the same bad segment again

```js
startLoad(startPosition = -1, skipSeekToStartPosition) { ... }
```

With no arguments it uses `lastCurrentTime`, i.e. **back to the same segment**.
So "retry `hls.startLoad()` three times then give up" is useless: all three hit the same segment.

**To skip you must pass a position**: `hls.startLoad(frag.start + frag.duration, true)`.

### Fact 4: under VOD a gap longer than 2 seconds is **not skipped automatically**

`src/controller/gap-controller.ts`:

```js
export const MAX_START_GAP_JUMP = 2.0;
// ...
const maxStartGapJump = isLive ? levelDetails.targetduration * 2 : MAX_START_GAP_JUMP;
```

So **merely calling `startLoad(pos)` is not enough** — the buffer keeps a hole, the playhead sits before the hole,
and under VOD gap-controller will not carry you across it, so the picture spins at the edge of the hole.
**You must move the playhead at the same time**:

```ts
video.currentTime = resumeAt;
hls.startLoad(resumeAt, true);
```

### Aside: `fragmentTracker` is **not** exposed on the Hls instance

In `hls.ts` it is `const fragmentTracker = new FragmentTracker(this)` (a local variable),
then `coreComponents.push(fragmentTracker)`.
So you **cannot** call `hls.fragmentTracker.addAsGap(...)`. To mark a hole manually,
the only route is the "move the playhead + startLoad(pos)" above.

### The concrete implementation

```ts
hls.on(Hls.Events.ERROR, (_, data) => {
  const httpCode = data.response?.code;
  const frag = data.frag;
  // Must intercept BEFORE the fatal check: 4xx is never retried and goes straight to fatal
  if (frag && typeof httpCode === 'number' && httpCode >= 400 && httpCode < 500) {
    skipped += 1;
    const resumeAt = frag.start + frag.duration;
    try {
      if (Number.isFinite(resumeAt)) {
        video.currentTime = resumeAt;      // cross the hole
        hls.startLoad(resumeAt, true);     // continue after the bad segment
      } else {
        hls.startLoad();
      }
    } catch { hls.startLoad(); }
    setMediaWarning(`Segment ${frag.sn} is dead (HTTP ${httpCode}), skipped`);
    return;                                 // do not enter the fatal branch, do not destroyHls
  }
  if (!data.fatal) return;
  // ... existing NETWORK_ERROR / MEDIA_ERROR handling
});
```

**`data.frag.sn` is the index from the playlist** and can be shown to the user directly; `frag.start` / `frag.duration` are in seconds.
`Hls.ErrorDetails.FRAG_LOAD_ERROR` also works, but **judging by `response.code` is more direct**
(the same 404 can arrive as `fragLoadError` or as some other details).

---

## 3. ffmpeg download: it **skips bad segments by default**

**This is the easiest point to get wrong.** On a genuinely broken stream (ffmpeg 6.1.1):

```
[hls @ ...] HTTP error 404 Not Found
[hls @ ...] Failed to open segment 15 of playlist 0
[hls @ ...] Segment 15 of playlist 0 failed too many times, skipping
[hls @ ...] Opening '.../segment.ts' for reading     <- continues to the next
EXIT=0
```

**Skipping is already what it does, and the exit code is still 0.** Therefore:

- Do **not** add any "skip parameter" (`-seg_max_retry 0` skips just the same; adding it is pointless)
- What is missing is **letting the user know something was lost** — otherwise a fragment missing hundreds of segments is treated as "download complete"

### Counting its skips: matching across chunks needs two buffers

```js
const SKIP_MARK = 'failed too many times, skipping';
let stderrTail = '';    // only to take the last few lines when reporting a failure, capped to prevent unbounded memory
let stderrCarry = '';   // only to stitch across chunks
let skipped = 0;

ffmpeg.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  stderrTail = (stderrTail + text).slice(-8000);
  const combined = stderrCarry + text;
  const countIn = (s) => s.split(SKIP_MARK).length - 1;
  skipped += countIn(combined) - countIn(stderrCarry);  // subtract what was already counted
  stderrCarry = combined.slice(-(SKIP_MARK.length * 2));
});
```

**Why one buffer is not enough**: if `stderrTail` doubles as the stitching buffer, truncation pushes out matches already counted,
so the next round counts them again (or misses some). The two buffers each do one job — feeding seven markers in character by character still yields exactly 7.

### stderr must not accumulate without bound

ffmpeg prints a progress line per segment; on a long video stderr can reach tens of MB.
**Holding all of it just to take the last three lines for an error message is pure memory waste** — a cap of 8KB is plenty.

---

## 4. ffmpeg's real progress: `-progress pipe:1`

```bash
ffmpeg -y ... -progress pipe:1 -i <url> -c copy out.mp4
```

The output is **machine-parseable key=value lines**, each block terminated by `progress=continue|end`:

```
bitrate=  -0.0kbits/s
total_size=262192
out_time_ms=2948933          <- note the unit is MICROseconds, a historical ffmpeg naming leftover
out_time=00:00:02.948933
speed=1.26x
progress=continue
```

### Three things you must know

1. **`out_time_ms` is microseconds, not milliseconds.** Divide by `1e6` for seconds.
2. **Total duration `Duration:` is on stderr while progress is on stdout; the two are not synchronized.**
   Capture it once from stderr with a regex: `/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/`
3. **Wait for a block to end (`progress=`) before computing a percentage.** Half a block (with `out_time_ms`
   but no `total_size`) yields a jumping percentage.

```js
if (key === 'progress') sawBlockEnd = true;
// ...
if (!sawBlockEnd) return;
const percent = totalSeconds > 0 && processedSeconds > 0
  ? Math.min(100, Math.round(processedSeconds / totalSeconds * 100))
  : null;   // <- null when unavailable; never invent a percentage
```

**`stdout` must no longer be `ignore`** — the old `stdio: ['ignore','ignore','pipe']`
threw stdout away, and the progress lines went with it.

### Verified result (reproducible)

A real stream run for 20 seconds: total duration recognized as 2210.88 seconds, 9 progress frames, 8 frames with a percentage, the percentage monotonically non-decreasing.

---

## 5. Progress feedback: `percent: null` is a feature, not a defect

When a direct-link file has no `Content-Length`, or ffmpeg has not yet printed `Duration`,
**return `null` truthfully and show an indeterminate sweeping bar**, rather than deceiving the user with a fake percentage.

```tsx
{progress?.percent != null ? (
  <div style={{ width: `${progress.percent}%` }} />
) : (
  <div className="indeterminate h-full w-1/3" />   // sweeps back and forth
)}
```

---

## 6. Cancelling a download: both the child process and the request must die

- **ffmpeg is a separate process**; `child.kill()` stops it, but it **does not clean up the partial file** — you must delete it yourself
- An **HTTP direct link** needs `request.destroy()`
- **Always delete the partial file**: leaving it makes the user think "I already downloaded that" when in fact it is broken
- **Cancellation is not a failure**: do not pop a red error in the UI (the user clicked it themselves)
- Track by url in a **Map rather than a single variable** — a single variable lets a later entry displace an earlier one,
  after which the earlier one can never be cancelled

---

## Self-check list

- [ ] On an error, did you probe layer by layer first (page -> master -> variant -> segment)?
- [ ] Before concluding "it's the origin", did you compare against **another host in the same playlist**?
- [ ] Did you back a decision like "should we impose a limit" with **complete** data rather than a sample?
- [ ] Did you look at the **ratio** or the **distribution** (scattered absence vs a contiguous whole stretch missing)?
- [ ] When skipping a segment, did you **also move the playhead** (under VOD, MAX_START_GAP_JUMP = 2s)?
- [ ] Is the interception logic placed **before the fatal check**?
- [ ] Did you truthfully tell the user how many segments ffmpeg skipped (exit code 0 masks the loss)?
- [ ] When the total duration is unavailable, do you show an indeterminate state instead of a fake percentage?
- [ ] After cancelling, did you delete the partial file? Is the bookkeeping a Map or a single variable?
