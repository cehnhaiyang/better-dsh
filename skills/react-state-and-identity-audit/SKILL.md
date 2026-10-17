---
name: react-state-and-identity-audit
description: Seven high-frequency defect patterns and their detection techniques when auditing React state and data identity — keys/identifiers that are not unique so two records collapse into one, the same predicate written in several places that then drift, an async result written back into a stale context, a shared boolean clobbered by concurrent operations, comments that contradict the code, unreachable branches and dead code nobody uses, and memo silently defeated by "a new reference every render". Each pattern gives its criterion, the fix, and a reproducible detection script. Read when asked to "audit/fix every problem in a module", when auditing a hook or panel state with list rendering and persistence round-trips, when self-checking a feature you just wrote, or when the UI shows something different from what actually happens.
---

# React State and Data Identity Audit

**Purpose**: a **checklist of defect patterns** for actively hunting bugs rather than waiting for them to surface.

Repeated audit rounds over the browser pipeline of one Electron + React application found 20+ real bugs,
and classifying them afterwards showed they **land in these seven patterns over and over**.

- For verification techniques (mutation testing, extraction and evaluation) see `verification-discipline`
- For encoding and tooling pitfalls see `safe-source-file-editing`

---

## Pattern A: a key / identifier that is not unique -> two records collapse into one

**The most insidious kind**: the code does not error, no test fails, it merely **shows one fewer row**.

### Criterion

Is the key of a list / Map / reduce **actually unique**?

```js
// bad: the key omits domain — yet Chrome's cookie primary key is name + domain + path
cookiePathIndex = (c) => !c.path || c.path === '/' ? c.name : `${c.name} (${c.path})`

// Visiting https://sub.example.com/ makes cookies.get return both
//   sid@sub.example.com  (HOST-ONLY)
//   sid@.example.com     (PARENT-DOM)
// after reduce: { "sid": "PARENT-DOM" }   <- shows 1 row, should be 2
```

### Three knock-on consequences

| Consequence | Explanation |
|---|---|
| One row missing in the UI | the user does not know there were two |
| Writing back hits the wrong object | `find(c => c.name === key)` always matches the first |
| **Attributes get contaminated** | `setCookie` replaces the whole record -> copies the first one's `httpOnly` / expiry onto the second |

### Fix: a collision-aware key, not blindly adding fields

```js
// Compute the briefest key first, and add distinguishing information only when a real collision occurs —
// otherwise the UI is smeared with noise
export const buildCookieKeys = (cookies) => {
    const brief = cookies.map((c) => !c.path || c.path === '/' ? c.name : `${c.name} (${c.path})`);
    const counts = new Map();
    for (const k of brief) counts.set(k, (counts.get(k) || 0) + 1);
    return brief.map((k, i) => counts.get(k) > 1 && cookies[i].domain
        ? `${k} @${cookies[i].domain}` : k);
};
```

Pair it with `buildCookieData` / `findCookieByKey`, **shared by the panel and the Agent**.

### Detection technique

```js
// Build two records that are "business-wise different, key-wise identical" and inspect reduce / find
const cookies = [
  { name:'sid', value:'A', domain:'sub.example.com', path:'/' },
  { name:'sid', value:'B', domain:'.example.com',   path:'/' },
];
const data = cookies.reduce((a,c)=>({...a,[key(c)]:c.value}), {});
console.log(Object.keys(data).length);   // should be 2
```

### Variant: deduping by "value" throws away "location"

```js
// bad: the same token often lives in local / session / cookie at once (that is what a login state looks like)
if (!found.some((f) => f.token === token)) found.push({ token, from, area, key });
// -> only the first scanned location is reported, and the model thinks fixing one place is enough
```

**Criterion**: if the purpose of deduping is "avoid duplicate entries", dedupe by **location**, not by value.
The same value in different locations is **two pieces of information that must be handled separately**.

---

## Pattern B: the same predicate written in several places -> drift

### Criterion

Search for how many times one semantic judgment appears:

```powershell
# e.g. judging "does this result belong to the current page"
Select-String -Path hooks\*.ts,components\*.tsx -Pattern 'pageUrl ===|!.*pageUrl'
```

Among three implementations, the "clear current" one **is missing the `!item.pageUrl` arm**:

```
Rows shown after clicking "only current page" : a, b
Rows left after clicking "clear current"      : b, c
Still in the list after clearing              : b      <- the button looks like it did nothing
```

### Fix

Extract a **single implementation** (put it in `utils/`, because it is cross-component and unit-testable) and share it in all three places.
If one copy sits **somewhere that cannot import** (such as a template string in an injected script),
write a **cross-verification test** comparing the two conclusions on the same batch of inputs.

### Cross-process variant

The main process (CJS) cannot import the renderer (TS) -> constants become **derived copies**.
A copy drifting **does not error**; it just makes the same input yield different conclusions on two paths:

| Drift | Consequence |
|---|---|
| One extension is video in the main process but stream in utils | filtering misclassifies it; `type !== 'stream'` makes it **skip the transcode check** |
| The UA literal exists in two copies | three UA values contradict -> the Cloudflare challenge always fails |

**Fix**: add a consistency assertion to the static self-check — **compare only the keys both sides have**,
and make the error **print the concrete difference**, otherwise seeing `FAIL` tells you nothing about where.

---

## Pattern C: a stale result written back into a new context

**When an async operation returns, the context it departed from may no longer exist.**

### Criterion

After every `await`, **before writing state**, is there a check that "I am still the same me as when I started"?

```js
// bad: an AI endpoint takes over ten seconds, and the user can easily switch pages meanwhile
const extracted = await extractMediaLinks(content, ...);
addLinks(extracted.map((item) => ({ ...item, pageUrl: targetUrl })));  // the OLD page URL enters the list!
```

### Fix: two criteria, chosen by what drives the operation

```js
// (1) driven by a URL change, with rounds -> use a runId
const isCurrentRun = (runId) => runId === undefined || latestRunRef.current === runId;

// (2) not URL-driven, no rounds -> compare "is the page I departed from still the current page"
const stillOnPage = () => (activeTabRef.current?.url || '') === targetUrl;
if (!stillOnPage()) return;   // the result belongs to a previous page, discard it
```

**The cost of choosing the wrong criterion**: forcing a runId onto case (2) makes it permanently true (no round is advancing).

### Same family: an index misaligned after filtering

```js
// bad: activeIndex indexes the array as persisted, but reading it back filters out blank pages
const tabs = saved.tabs.filter(t => t.url).slice(0, MAX);
const activeIndex = Math.min(saved.activeIndex, tabs.length - 1);
// [blank, A, B] while viewing A (index 1) -> filtered to [A, B] -> index 1 -> lands on B
```

**Fix**: **map the indices while filtering**, rather than applying the old index after filtering.

### Same family: `slice(0, MAX)` keeps the oldest

Entries are **appended** in discovery / bookmark order, so the newest is at the end -> `slice(0, MAX)` freezes the on-disk copy
at the earliest batch forever, after which **nothing you do gets persisted**.

```js
// bad: once 300 entries accumulate, disk holds the startup batch forever
saveJSON(KEY, items.slice(0, MAX));
// good: keep the newest
saveJSON(KEY, items.slice(-MAX));
```

**Same family: `findIndex` after a `slice`**

```js
// bad: 25 tabs while viewing the 25th -> stores index=24, but only 20 are saved -> out of range
const activeIndex = Math.max(0, tabs.findIndex(t => t.id === activeTabId));
saveJSON(KEY, { tabs: tabs.slice(0, MAX), activeIndex });
// good: search within the batch actually being saved
const kept = tabs.slice(0, MAX);
const found = kept.findIndex(t => t.id === activeTabId);
```

> **Meta-rule**: after fixing one bug, ask "does the same pattern exist elsewhere".
> Finding that `slice(0, MAX)` keeps the oldest -> search the whole repo for the same pattern -> **found 3 more** (bookmarks, sniffer, tabs).

---

## Pattern D: a shared boolean clobbered by concurrent operations

### Criterion

Is the `isXxx` boolean state written by **two or more independent operations**?

```js
// bad: scan and analyzeWithAi share one isAnalyzing
setIsAnalyzing(true);   // scan starts
setIsAnalyzing(false);  // scan ends — but the AI request is still in flight
```

Timeline:

```
analyzeWithAi(A) starts : isAnalyzing = true
scan(B, run1) starts    : isAnalyzing = true
scan(B, run1) ends      : isAnalyzing = false   <- the spinner stops here
=> the UI shows "not analyzing" and the button becomes clickable again; the user thinks nothing happened
   and clicks again -> two concurrent rounds
```

### Fix: a counter plus a `trackOp` wrapper

```js
const [pendingOps, setPendingOps] = useState(0);
const isAnalyzing = pendingOps > 0;

const trackOp = useCallback(async (fn) => {
    setPendingOps((n) => n + 1);
    try { return await fn(); }
    finally { setPendingOps((n) => Math.max(0, n - 1)); }   // the lower bound is mandatory
}, []);
```

**Three points**:

1. Return the count in `finally`, covering success / failure / early `return`
2. Clamp with `Math.max(0, n - 1)` — otherwise early returns accumulate it negative and it stays `true` forever
3. Do **not** decide when to return the count by round (`if (isCurrentRun(runId)) setX(false)`) —
   a stale round holds its own count too, and missing one spins forever

### Variant: a skip guard overloaded with retry policy -> refetch loop

A dedup guard in an effect answers one question: "is this the same work as last time?"
Adding terms like `&& imageUrl && !loadError` ("and we have a result, and it didn't fail") makes the guard
answer a **second** question — retry policy — and inverts it:

```tsx
// bad: after one failure loadError is true -> the guard is permanently false ->
// every dependency change refires the request; with an object-identity dep
// (a record from a Map rebuilt every tick) that is one request per tick, forever
if (currentHash === lastHashRef.current && imageUrl && !loadError) return;
```

Two compounding symptoms: the refetch loop itself, and a `setLoadError(false)` at the top of the effect
erasing the error UI the moment it renders, so the user sees "request -> flash -> request".

**Fix**: the guard answers only "has the work changed" (`if (currentHash === lastHashRef.current) return;`).
Explicit retry is a user action that invalidates the ref and re-triggers the effect through a nonce dependency
(`const [retryNonce, setRetryNonce] = useState(0)` in the dep array), so the load logic exists **exactly once** —
never a second hand-copied loader in the retry handler that silently drops the stale-result check.

---

## Pattern E: comments that contradict the code

**When a comment says something different from what the code does, people (and AI) reason from the comment and reach a wrong conclusion.**

| The comment claims | The code actually |
|---|---|
| "only X and the status type are exported publicly" | it also exports two pure functions |
| a constant is commented "fully loaded uses 66% of the budget" | the actual value makes usage reach **220%** |
| "Chrome's cookie primary key is name + domain + path" | the implementation uses name + path only (see pattern A) |
| "filter out segments of that kind" | the predicate is **never true** for that kind (see pattern F) |
| "content stays mounted (collapsing is only display:none)" | the code returns early, so collapsing **unmounts** it and scroll position is lost |

### Technique: check whether the identifiers mentioned in comments still exist

```js
const inCode = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
for (const id of mentions) {
  if (!new RegExp(`(?<![\\w$])${id}(?![\\w$])`).test(inCode)) console.log('possibly stale:', id);
}
```

**Beware false positives**: abbreviations like `IPC`, `HTML`, `UTF`, `MIDI` get treated as identifiers,
and symbols referenced across directories also produce false positives. **Verify each one; do not edit straight from the scan output.**

### A rule for yourself

**When a change makes a comment false, fix that comment in the same change.**

When you write absolute wording like "always / never / will not", **immediately go find the corresponding line in the code**.
If you cannot find it, the comment is lying.

```powershell
Select-String -Path components/*.tsx -Pattern 'always|never|just|will not'
```

### Anti-pattern: leaving a historical narrative of "what used to be here"

After deleting a block of code, writing a comment explaining "there used to be an XX button here, removed because ..." —
**that is noise added for whoever reads the code**: they do not need to know what used to be there.

**Criterion**: a comment should explain "why it is like this now", not "it was not like this before".
The only exception is recording a **trap that can still recur** (such as "do not change back to conditional rendering, it loses state") —
that prevents a future error rather than narrating history.

---

## Pattern F: unreachable / unused dead code

### Three subclasses

| Subclass | Criterion | Example |
|---|---|---|
| **Unreachable branch** | the condition is never true at the call site | `ext === 'ts'` is never true for HLS segments (`ext` is `'mp2t'`) -> the checks inside are dead -> **dozens of segments all enter the list** |
| **Class / constant nobody uses** | the definition exists, zero references repo-wide | an animation class name plus its `@keyframes`; three sibling constants left as declarations only |
| **Mechanism with no entry point** | no caller anywhere along the chain | a set of navigation functions, about 53 lines, zero calls across three commits |

### How to find an unreachable branch

**Check whether the condition's value domain can actually be hit**:

```js
// step 1 runs first: contentType.startsWith('video/') -> detectedType='video', ext='mp2t'
// step 2 only runs when !detectedType -> ext stays 'mp2t'
// step 3 tests ext === 'ts' -> 'mp2t' !== 'ts' -> never entered
```

**Technique**: replicate the decision logic, feed it **real-world inputs**, and see whether the branch is reachable:

```js
for (const [ct, path] of [['video/mp2t','/hls/seg001.ts'], ['','/hls/seg001.ts']]) {
  const r = detect(ct, path);
  console.log(`ct=${ct} -> type=${r.detectedType} ext=${r.ext}`);
}
```

### The harm of dead code is not merely redundancy

- **It masks a broken mechanism**: an unreachable branch makes the code "look guarded" when it is not
- **It misleads the next reader**: the existence of a constant makes people think "changing it changes that part"
- **It exposes a dangerous API**: exporting the "wrong way" as a usable entry point, with a comment plainly saying it clears state on every render —
  **delete it and there is no second option left**

### Subclass four: deleting one UI special case drags out a whole dead prop chain

After deleting the UI special case that "decides which button to show by domain", the props that special case used
**lose their only consumer**, yet the compiler **does not error**
(TS's prop types allow a parent to pass a value the child never uses) —
so it becomes an **idling pipe**: the parent computes and passes it, the child receives it, nobody uses it.

**The knock-on list**:

| What died | Why |
|---|---|
| one callback prop (through two component layers plus a top-level argument) | that button was its only use |
| another callback prop (through two component layers plus a top-level argument) | that banner was its only use |
| imports of several icons / predicate functions | they became dead with the code |
| a ~75-line handler at the top level | its two call sites were exactly the two deleted entry points |

**Technique**: after deleting UI, **count references once** for every prop / import that was involved:

```powershell
@'
const fs = require('fs');
const src = fs.readFileSync('D:/proj/components/Panel.tsx', 'utf8');
const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const n of ['SomeIcon','OtherIcon','isSpecialSite','onOpenThing']) {
  const c = (noComments.match(new RegExp('(?<![\\w$])' + n + '(?![\\w$])', 'g')) || []).length;
  console.log(n.padEnd(24) + c + (c <= 1 ? '  <-- only the import line remains, dead code' : ''));
}
'@ | node -
```

**Criterion**: **reference count = 1 and that one occurrence is the import / type declaration** -> dead code.

**Use the compiler for the final check**; it is more reliable than the eye:

```powershell
npx tsc --noEmit --noUnusedLocals --noUnusedParameters 2>&1 |
  Select-String -Pattern 'Panel|App\.tsx'
```

> A default `tsc --noEmit` **does not report** unused locals / parameters,
> so "the build is green" does not prove there is no dead code. Turn both switches on and check once.
> Note: running these switches project-wide produces pre-existing warnings (audio panel, parsers, etc.),
> so **look only at the files you changed** and do not go fix other people's.

**Establish dependency ownership before deleting an entry point**: the **siblings** of those props may still be alive —
if a handler is also the props of another panel, it **must be kept**.
The criterion is "besides this dead chain, who else uses it".

### Subclass five: pure-UI site special cases

**Criterion**: this code changes **appearance or entry points** only because "the current site is X", and does not affect data correctness.

**The two typical spots (deletable)**:

- the address bar switching button labels and colors by domain plus a path keyword
- the "this site's pages ... please use the gallery" banner at the top of the sniffer panel

**But among the same batch of site-predicate call sites, two others must be kept** — they are **not UI**:

| Keep | Why |
|---|---|
| the site predicate in sniffer filtering | it is a **filter rule**: deleting it floods the sniffer list with covers / segments |
| the site-predicate utility function itself | it is also the switch for HLS request signing: deleting it makes that class of video **403 across the board** |
| the main process's sniffer exclusion-suffix table | the main process is the actual interception point for sniffing, and it is checked for agreement by the static self-check |

**Lesson**: when the user says "delete the special detection for some site",
**first classify by "does it change appearance or data"**, list the items and consequences for the user to confirm,
and **do not delete the whole batch**. The call sites of one predicate function can belong to both classes.

---

## Pattern G: memoization silently defeated by "a new reference every render"

**It does not error and does not affect functionality; it just makes `React.memo` pointless** —
so nobody notices until the list grows long enough to stutter.

### Criterion: do the dependencies of `useMemo` / `React.memo` contain something **rebuilt every render**?

**Case one: the whole actions object is a dependency.**

```tsx
// Pulling them out one by one: the actions object is a new reference each render, so depending on it
// invalidates every memo below
const { downloadHit, saveFile, setNotice, setError } = actions;

const onDeleteTask = useCallback((task) => {
  if (window.confirm(msg)) void actions.cancelTask(task.id);   // bad: uses actions again
}, [actions]);                                                  // bad: and depends on it too
```

Some hook returns a **bare object literal** (not `useMemo`),
so `actions` is a new reference every render -> `onDeleteTask` is rebuilt every render ->
the prop passed to `React.memo(TaskRow)` (a list-row component) changes every render -> **memo is entirely ineffective**.

**Fix**: `const { ..., cancelTask } = actions;` then `[cancelTask]`.

**Case two: the JSX element array is rebuilt every render.**

```tsx
// bad: dragging the floating ball changes position every frame -> the whole component re-renders ->
//      this array is rebuilt every frame -> the 300-row list inside is rebuilt every frame
const panels = [
  { key: 'sniff', node: <SniffPanel ... /> },
  { key: 'tasks', node: <TaskPanel /> },
];
```

**Fix**: memoize the elements themselves; when the reference is unchanged React skips the entire subtree
(**regardless of whether it is `hidden`**):

```tsx
const sniffNode = useMemo(() => <SniffPanel ... />, [sniffer, onPlay, onAiAnalyze, currentUrl]);
const taskNode = useMemo(() => <TaskPanel />, []);   // takes no props -> genuinely one-shot
```

### Variant: inline `style` silently overrides a transition on the class

```tsx
// Before: transition: 'all 320ms ...' incidentally covered transform
// Rewritten as an explicit property list, transform was missed
style={{ transition: 'left 320ms, top 320ms, width 320ms' }}
className="transition-transform hover:scale-105"   // bad: never takes effect
```

**An inline `transition` overrides `transition-*` on the class.**
When expanding `all` into explicit properties, **you must list the properties the class uses too** (here `transform`),
otherwise the hover scale degrades from "animated" to "instant".

### Detection technique

```js
// 1. Find the source of the "rebuilt every render" object: is the object that hook returns a useMemo?
//    The criterion must land on that specific object, not the whole return:
//      one hook   -> bare object literal, actions is a new reference each render  <- this is the culprit
//      another    -> return useMemo(...), actions is stable
//      a third    -> the outer return is a literal, but the inner methods are themselves useMemo, stable
const s = fs.readFileSync('hooks/useSearch.ts','utf8');
console.log(/return useMemo/.test(s) ? 'useMemo (stable reference)' : 'bare object literal (new reference every render)');

// 2. Find large objects in useCallback dependencies
//    List the dependency arrays one by one and scan for a whole actions / state / props
```

> **Meta-rule**: when adding `React.memo` to a component,
> **you must simultaneously check that every prop it receives has a stable reference**.
> Adding memo without fixing the props is the same as not adding it — and is harder to notice, because the code "looks already optimized".

---

## General audit order

For a task like "audit every problem in a module", this order is the most efficient:

1. **Map the data flow**: what data, where it is stored (state / localStorage / main process), who reads and writes it
2. **Check key uniqueness** (pattern A) — the most insidious, so check it first
3. **Search for duplicated predicates** (pattern B) — one semantic judgment appearing more than once is a risk
4. **After every `await`, ask "is the context still there"** (pattern C)
5. **For every boolean state, ask "who writes it"** (pattern D)
6. **Verify the identifiers mentioned in comments** (pattern E)
7. **Find unreachable branches and zero-reference exports** (pattern F)
8. **Check whether every memo's dependencies have stable references** (pattern G)

---

## One meta-rule

> **After fixing one bug, ask "does the same pattern exist elsewhere".**

Almost all the payoff comes from this step:

- Found `slice(0, MAX)` keeping the oldest -> searched the repo for the same pattern -> **found 3 more** (bookmarks, sniffer, tabs)
- Found a cookie key missing domain -> the same defect in `tokens` elsewhere was **worse** (two sources with identical fields)
- Found `analyzeWithAi` had no stale protection -> compared against `scan`, which has 6 guards -> confirmed it was an omission, not a design

---

## Self-check list

- [ ] Is every list / Map key genuinely unique (build two records "business-different, key-identical" and check)?
- [ ] How many times does one semantic judgment appear repo-wide? More than once means extract a single implementation
- [ ] Before every `await` writes state, is there a check that "I am still the same me as when I started"?
- [ ] After filtering / truncating, is the index computed **within the filtered batch**?
- [ ] How many writers does each `isXxx` boolean have? Can they clobber each other under concurrency?
- [ ] Does any skip/dedup guard also encode error or result state (`&& hasResult && !error`), making it permanently false after one failure?
- [ ] Do the things mentioned in comments still exist in the code? Does the absolute wording have a corresponding implementation?
- [ ] Are there always-false branches, zero-reference exports, mechanisms with no entry point?
- [ ] Does every prop of every `React.memo` have a stable reference?
