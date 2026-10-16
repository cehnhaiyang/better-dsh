---
name: verification-discipline
description: Read before concluding "it is broken" or "it is fine". Makes the verification conclusion itself trustworthy: the complete mutation-testing procedure and its three disciplines, which classes of mutant to build, checking why a mutant went red before believing it, verifying newly written stateful or threshold-bearing code as if it were product code, validating parsing logic against real external tools and invariants, and the discipline of probe scripts themselves.
---

# Verification Discipline

> **"All tests green" does not equal "the assertions are effective".**
> A script coarser than the code under test produces only noise that looks like evidence.

---

## 1. Mutation testing: proving an assertion is not empty

A wrongly written assertion (checking the declaration but not the usage, the predicate but not the call site) is permanently true,
making you believe you verified something. **Mutation testing is the only means of proving an assertion can fail.**

Method: deliberately break the product code (simulating a real bug), run the tests, confirm they go **red**, then restore.

```powershell
# 1. First confirm the baseline is green
npm run test 2>&1 | Select-String 'all passed|passed \d+ items'
# 2. Back up -> break -> run tests -> restore
# 3. After restoring, run the baseline once more to confirm it is green again
```

### Three disciplines that must hold

#### 1. The baseline must be green first

When the baseline itself fails, "the mutant went red" carries no information.
**Without a green baseline, mutation results are untrustworthy.**

#### 2. The mutant must compile or load

A compile failure caused by the mutation gets recorded by the script as "the mutant was caught" —
that is a false positive. After mutating, confirm it at least runs (syntax check, type check).

#### 3. The anchor must match exactly once

Doing string replacement in PowerShell has two traps: an anchor that misses leading whitespace -> matches 0 times, so the mutation was never written;
backticks and `$` inside the anchor get eaten by the parser -> same result.

**Do mutation with a Node script and write the anchor verbatim:**

```js
const fs = require('fs');
const p = 'D:/proj/src/someModule.ts';
const orig = fs.readFileSync(p, 'utf8');
fs.writeFileSync(p + '.bak', orig, 'utf8');

const anchor = "        if (!sess || seen.has(sess)) return;";
if (!orig.includes(anchor)) { console.log('anchor not found'); process.exit(2); }
fs.writeFileSync(p, orig.replace(anchor, "        if (!sess) return;"), 'utf8');
```

`process.exit(2)` separates "the anchor did not match" from "the test failed" —
otherwise both get misread as "the mutant was caught".

When you need to pass a regex or backticks, pipe a here-string into node rather than using `node -e "..."`:

```powershell
@'
const fs = require('fs');
const p = 'D:/proj/src/someModule.ts';
let s = fs.readFileSync(p, 'utf8');
const needle = 'reasoning: keepReasoning(liveReasoning),';
const i = s.lastIndexOf(needle);
if (i < 0) { console.log('ANCHOR-MISS'); process.exit(2); }
s = s.slice(0, i) + s.slice(i + needle.length);
fs.writeFileSync(p, s, 'utf8');
'@ | node -
```

See `safe-source-file-editing` for details.

### Which classes of mutant to build

| Type | Example | What it verifies |
|---|---|---|
| **Revert to the pre-fix form** | `slice(-MAX)` back to `slice(0, MAX)` | that the new test really locks that bug down |
| **Negate** | `!inputFocused` -> `inputFocused` | that a wrong predicate direction gets caught |
| **Delete a guard** | remove `if (sameRules(current, next)) return ...` | that the branch is not decorative |
| **Loosen the predicate** | `!== 1` changed to `if (false)` | guards against **over-fixing** |
| **Delete the bookkeeping or reporting** | remove `has()` / `add()` but keep the declaration | guards against **empty assertions** |
| **Make a core predicate always false** | `const isBusy = () => !!head();` -> `() => false` | guards against **a predicate never actually being called** |

The last three are the most valuable: **against over-fixing**, **against empty assertions**, **against an uncalled predicate**.

"Delete has/add but keep the declaration" is exactly how an empty assertion is discovered.

**"Make the core predicate always false" is how a false guarantee is discovered.** A predicate function read in four places
that decides "should user input be blocked" may have **no test calling it directly** —
the tests only grepped the source for that line (`/const isBusy = \(\) => !!head\(\);/`),
so turning it permanently false left every test green.

**Rule: every predicate function read from multiple places must have a test that calls it directly and covers every state.**

```js
eq('does not block when empty', mod.isBusy(), false);
seed({ ... });
eq('blocks when populated', mod.isBusy(), true);
```

### When a mutant goes red, first look at why it went red

Red has two causes with completely different meanings:

- An assertion failed — the mutant was genuinely caught
- The anchor or regex did not match — **equivalent to not having verified anything**

A static assertion must be **sensitive to semantics only, not to writing order or whitespace**:

```js
// bad: sensitive to argument order, so a legitimate refactor (reordering) produces a false alarm
const call = src.match(/messages:\s*([A-Za-z_$][\w$]*)\s*,\s*\n\s*reasoningEffort/);

// good: cut out the whole segment first, then look for the target inside it
const start = src.indexOf('await chat({');
const call = src.slice(start, src.indexOf('});', start));
const m = call.match(/messages:\s*([A-Za-z_$][\w$]*)/);
assert(m[1] === 'transcript', `must be transcript, actually ${m[1]}`);
```

The cost of an order-sensitive assertion is paid by the next person doing a legitimate refactor — they will edit the test instead of reading the code.

### When a mutant survives, first decide whether it is an "equivalent mutant"

**Survival does not equal a hole in the tests.** There are two entirely different causes:

| Cause | Criterion | Action |
|---|---|---|
| The tests do not cover it | with the mutant installed, **some test goes red** but that test does not check this | add an assertion |
| **Equivalent mutant** | with the mutant installed, **running every test is still green**, and no caller depends on that difference | the mutation does not change behavior, so it is not a hole |

**How to tell them apart: install the mutation again and run every test file (not just the ones you think are relevant).**

```js
// Run the full set, not just the target file
const files = fs.readdirSync('test').filter(f => f.endsWith('.test.mjs'));
const red = files.filter(f => spawnSync('node', ['test/' + f]).status !== 0);
console.log(red.length ? 'went red: ' + red.join(', ') : '-> equivalent mutant (no caller depends on the difference)');
```

Real case: changing `step()`'s return value from "did this step do something" back to "is anything left in the queue"
left the target test green. Running everything — **all 22 files green** — confirmed an equivalent mutant
(the rewrite had already removed the blast radius of that ambiguity, and no caller depends on it any more).

**But an equivalent mutant may still warrant an assertion**:

> "No caller depends on it" is not "the contract may be vague".

That return value is part of a **public contract**. If someone later adds a caller that happens to depend on the old semantics,
it will fail silently. So **the contract itself deserves a direct assertion**, independent of "does anyone depend on it today":

```js
const results = [];
while (q.length) results.push(mod.step());
ok('each fired item returns true (including the last)', results.every(v => v === true));
eq('only when the queue was empty and nothing fired, false', mod.step(), false);
```

**Order**: decide equivalence first (run everything), then choose between adding a test and adding a contract assertion — do not add an assertion the moment you see survival,
because that freezes a difference that does not exist into a test requirement.

### Cleanup

The mutation script and the `.bak` backup must be deleted once used. Announce before creating them per `user-collaboration-preferences`.
Putting the backup **in the same directory as the modified file** is easier to troubleshoot than the system temp directory, but delete it cleanly either way.

---

## 2. Newly written code must also be verified as if it were product code

**Every newly written function that holds state or has a time or count threshold should be run once through a small harness fed with real input.
Green compile + green tests + green build do not prove the logic is right.**

A typical failure: a throttle function internally reads `progress.currentBytes`, while the object the caller passes names that field
`receivedBytes`; at the same time it passes `minBytes = 0`, making the test `Math.abs(0 - 0) >= 0` — **always true**.
The throttle is entirely ineffective and every chunk is emitted. None of the three "greens" caught it:
`minBytes: number` accepting `0` is type-legal, no test covers that function, and the build does not look at semantics.

How to catch it — **extract the function from the product source; do not copy the logic** (a copy means testing your own duplicate):

```js
const src = fs.readFileSync('electron/main.js', 'utf8');
const start = src.indexOf('function throttleProgress');
const end = src.indexOf('\n}\n', start) + 3;
const throttleProgress = new Function(src.slice(start, end) + '; return throttleProgress;')();

// Simulate a real flood: 10 chunks in the same tick
const got = [];
const push = throttleProgress((p) => got.push(p.receivedBytes), 250, 0, (p) => Number(p?.receivedBytes) || 0);
for (let i = 1; i <= 10; i++) push({ receivedBytes: i * 1000, status: 'downloading' });
console.log(got.length);   // expect 1 (merged into one)
```

The same class that must be verified: throttling and debouncing, counters and accumulators, cross-chunk string matching, regex parsing,
anything with a `Math.abs(...) >= threshold` test.

### Cross-chunk matching needs two buffers

A form like `skipped += countIn(combined) - countIn(carry)` must be verified by feeding it **character by character**.
Using one buffer for both stitching and truncation double-counts or misses.

---

## 3. Validate parsing logic against real external tools

For code that parses the output of an external process or a third party, do not write it from documentation, and do not conclude from one success.
Run the real process, print the parse result, and check **invariants**:

```js
// Applies to progress, timestamps, sequence numbers
const pct = frames.map(f => f.percent).filter(x => x !== null);
console.log('percentage monotonically non-decreasing:', pct.every((v, i) => i === 0 || v >= pct[i - 1]) ? 'yes' : 'no <- problem');
```

**An invariant like "monotonically non-decreasing" is the cheapest correctness criterion** — far faster than checking values frame by frame, and better at catching jumps.

---

## 4. Use the product code itself, not a rewritten duplicate

**A criterion must reuse the product code.** To judge "is this a challenge page", call the product's own predicate function;
to judge "did this request go through the proxy", use the product's own agent.

A criterion you rewrite yourself is usually coarser than the code under test, yet you use its output to deny the product.
A typical misjudgment: asserting "the site returned a Cloudflare challenge page" from a single keyword feature —
while Cloudflare injects the same script tag into **every** page it proxies, not just challenge pages.
The product code uses **AND** logic (the script feature **and** the text feature), and that combination is the correct one.

### Before concluding, prove the probe itself is trustworthy

Before declaring "X is broken", ask:

- Is my criterion the same one the product uses?
- Is there a **control group** that can prove my probe distinguishes good from bad?

Had that run included a control site "also proxied by CF but confirmed working", it would immediately have shown both sites judged as challenge pages —
the criterion was plainly wrong.

### Extract functions from the product code and evaluate them

**Top-level consts are outside the extracted region and must be injected explicitly:**

```js
const factory = new Function(
    'require', 'http', 'https', 'net', 'tls',
    `${block}\nreturn { setProxy, getProxy };`
);
return factory(require, require('http'), require('https'), require('net'), require('tls'));
```

Locate the region by a marker, and `throw` when it is not found — **never return empty silently**:

```js
const grab = (marker) => {
    const start = src.indexOf(marker);
    if (start < 0) throw new Error(`${marker} not found in the source`);
    const rest = src.slice(start);
    const nextIdx = rest.slice(1).search(/\n(async )?function /);
    return nextIdx < 0 ? rest : rest.slice(0, nextIdx + 1);
};
```

### Discipline of the probe script itself

- Every step needs a hard timeout (`Promise.race` or a socket timeout).
- Keep concurrency in the single digits; set timeouts short (9-12 seconds) and **report "timeout" explicitly** rather than a vague failure.
- Output item by item; do not fire dozens of concurrent connections and blow up the proxy or the peer — that manufactures a batch of `ECONNRESET` you caused yourself.
- Once a tunnel is established, if the peer never responds the socket is never handed to the request, so the request's own timeout never starts.
  **The handshake itself must carry a timeout.**

### Do not destroy the scene in order to verify

Deleting files, moving files, changing configuration, installing or removing dependencies — **even with a backup, even if restorable, even in a temp directory** — ask first.

**Look for a non-destructive evidence path first.** To judge whether a rebuild step really downloaded something,
read that tool's source to see how it decides on download and cache, or read the verbose output of `--foreground-scripts`;
"delete it and try again" is the last resort.

**An unchanged timestamp does not mean the proxy was used.** A rebuild reporting success only means the exit code was 0.
**"A later rebuild succeeded" and "the first install succeeded" are two different things**; do not pass the former off as the latter.

---

## 4.5 Without a shell, verification can only stop at the "reconcile" level

**When the environment provides no arbitrary command execution, the meaning of "verify" must be downgraded, and the report must state which level it was downgraded to.**

The feasible level is called **reconcile**: read the implementation line by line and confirm that every construct you wrote down
has a corresponding consumer in the implementation. It is far better than "written from memory", but it is **not the same as having executed**.

The infeasible level is **execute**: run the parser, run the tests, look at real output.

Rules:

- **The report must use an accurate verb.** "Reconciled line by line against the implementation; not executed" is acceptable;
  "verified" is not. A vague "looks fine" is the worst — it makes the reader believe there is evidence.
- **Do not take a detour just to produce "verified".** For example, copying the logic under test into a scratch script and running it yourself:
  once that copy diverges from the product code, the conclusion is worse than no conclusion (see section 4).
- **Do not pass off an unrelated green as evidence.** A passing type check or a fully green repository test suite
  does not prove that **a data file no test reads** is correct.
- If the user wants actual execution, put "what they need to do" into the report as an action item,
  rather than implying you already did it.

---

## 5. The safe way to run in an Electron environment

Verify main-process Node capabilities with `ELECTRON_RUN_AS_NODE=1` — **no window, no Chromium**:

```powershell
$env:ELECTRON_RUN_AS_NODE=1
node_modules\electron\dist\electron.exe -e "console.log(process.versions.node)"
```

**Never launch a GUI window just to verify** — it pops a window onto the user's screen.
When a real Electron environment is needed, use a script the project already has and the user has accepted; do not create one on the spot.

Before running, confirm the binary version matches the package declaration: the binary in `node_modules/electron/dist/`
**may not match the version declared in `package.json`** (when the install script did not run, the old one is left behind),
in which case **any runtime-capability assertion based on it is wrong**. For the command see `electron-main-constraints`.

---

## General principle

> When unsure, run the product's own path first (the project's built-in check script),
> rather than improvising something "close enough".

---

## Self-check list

- [ ] Before mutation testing, was the baseline confirmed green?
- [ ] Can every mutant compile or load?
- [ ] When a mutant went red, did you read "assertion failed" or "anchor did not match"?
- [ ] Is the assertion sensitive to writing order (would a legitimate refactor produce a false alarm)?
- [ ] Have newly written stateful, threshold-bearing functions been fed real input?
- [ ] Without a shell, does the report say "reconciled" or a vague "verified"?
- [ ] Before declaring "it is broken", is your criterion the same one the product uses? Is there a control group?
- [ ] Does every step of the probe script have a hard timeout? Is concurrency controlled?
- [ ] Did you perform a destructive operation just to verify? Did you ask the user?
