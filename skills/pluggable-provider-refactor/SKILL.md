---
name: pluggable-provider-refactor
description: Method and criteria for refactoring a "single-site specialized module" into a "generic engine + pluggable providers". Covers where the specialization hides, how to split ownership between generic orchestration and site specialization, the socket contract and registry, cross-site normalization (size/time/seeders/magnet encoding), unknown-value sentinels and the comparator trap, fault tolerance so one site's failure does not sink the whole, offline test fixtures, one parser serving several sites, and a replaceable transport layer. Read when converting a module that supports only one data source or site into one that supports many, or when the user says "stop specializing for one website; make the website a socket plugged into a generic engine".
---

# Single-Site Specialization -> Generic Engine + Sockets

**Applies to**: adding a data source, removing site specialization, reworking multi-source aggregation.
**Does not apply to**: pure UI changes, small fixes inside a single site.

- For when a verification conclusion counts as trustworthy see `verification-discipline`
- For naming rules see `user-collaboration-preferences`

---

## 1. Where the specialization hides

**It is written into every name, not just into the logic.** Let `<site>` stand for the specialized source:

| Name | Problem |
|---|---|
| `<site>Service.js` | module name = site name |
| `search<Site>()` | function name = site name |
| `use<Site>` | hook name = site name |
| `<Site>Item` / `<Site>SearchOptions` | type name = site name |
| `CATEGORY_OPTIONS` | that site's category codes, yet exported as a generic constant |
| `<site>-search` / `api.<site>` | IPC channel and namespace = site name |

**The first step of the refactor is to change these names.**
The cost of keeping the old names: the next person adding a site will assume "this can only search that one site".

**Criterion**: read the names once and ask "if I add a second source, does this name become a lie?"

---

## 2. The real lesion: generic orchestration and site specialization are tangled together

```js
async function search<Site>({ site, q, category, sort, pages }) {
    for (let p = 1; p <= pageCount; p++) {          // <- generic: pagination
        const url = buildSearchUrl(site, {...});     // <- specialized: build the URL
        const html = await httpGetText(url, ...);    // <- generic: fetch bytes
        const items = parseList(html, dlHost);       // <- specialized: parse
        if (items.length === 0) break;               // <- generic: termination condition
        await sleep(800);                            // <- generic: rate limiting
    }
    // dedupe, filter, fill fields                      // <- all generic
}
```

Adding a second site can only mean writing another `searchXxx`, copying pagination, dedupe and rate limiting all over again.

**Splitting ownership**:

| Content | Where it goes |
|---|---|
| Site address, category code table | provider |
| `buildSearchUrl` (build the URL) | provider |
| `parse` (HTML -> items) | provider |
| Pagination, rate limiting, termination condition | **engine** |
| Dedupe, filter, fill fields | **engine** |
| Fetching bytes | transport layer |
| Writing to disk, allowlist validation | stays in the main process |

**Specialization does not disappear; it is quarantined.** Someone has to know the site's URL format; what changes is where that lives —
in a pure-function plugin that does exactly two things (`buildSearchUrl` + `parse`).

---

## 3. The socket contract

```ts
export interface SiteProvider {
    descriptor: SiteDescriptor;              // id / label / homepage / adult / kinds
    buildSearchUrl(query: string): string;   // keyword -> search address
    parse(body: string, ctx: ParseContext): ProviderHit[];
    headers?: Record<string, string>;
}
```

**Three key constraints**:

1. **`buildSearchUrl` and `parse` must be pure functions** — they issue no requests and read no global state.
   That is what makes offline testing against saved real response snapshots possible.
2. **The provider does not fill in `site` / `siteLabel`** — the engine stamps those from the registry.
   Otherwise the same site name is written in two places and will drift.
3. **`parse` must be fault-tolerant** — when the site is redesigned or returns an error page it returns an empty array rather than throwing.
   One site failing to parse must not fail the whole fan-out.

### The registry: the only action needed to add a site

```ts
const PROVIDERS: SiteProvider[] = [providerA, providerB, ...];
```

"Add a site" = write one `providers/<name>.ts` + add one entry to the array.
**The engine, the UI and the main process need no change.** The UI's site-selection buttons render by iterating the registry, so a new site appears automatically.

---

## 4. Normalization: the precondition for cross-site sorting

Each site's field formats differ completely and must be normalized in place inside the provider:

| | Site A | Site B | Site C |
|---|---|---|---|
| size | `"183567938"` (bytes) | `"1.8 GB"` | `"6.6 GiB"` |
| time | epoch seconds | epoch seconds | `"2026-09-12 15:45"` |
| seeders | `"0"` string | absent | number |

Unify into `sizeBytes: number` / `publishedAt: epoch ms`, with unknown always `-1`.

**Why it is mandatory**: sorting by strings like `"1.8 GB"` and `"709.4 MiB"` is meaningless
(lexicographically `"1.8 GB" > "709.4 MiB"`, while the reality is the opposite).

### Unknown values use -1, not 0

`0` means "it really is zero"; `-1` means "the site did not publish it" — **two different pieces of information**.

- When sorting, `-1` goes last and must not be treated as the smallest value
- When filtering (e.g. "seeders >= 5") **unknown values must be kept**,
  otherwise sites that do not publish seeder counts are filtered out wholesale

```js
hits.filter((h) => h.seeders === UNKNOWN || h.seeders >= minSeeders);
```

### Magnet encoding must be unified

Different sources use different btih encodings: some are **32-character base32**, others **40-character hex**.
Without unifying to hex there is no way to dedupe across sites.

**Whether dedupe actually works is judged by whether the three numbers "sum of both sites - after dedupe = size of intersection" line up**,
not by whether a `Set` appears in the code.

### Sentinel values in a comparator: `-Infinity` produces `NaN`

If the sentinel chosen for "unknown" is `-Infinity` and the comparator subtracts (`a - b`):

```js
-Infinity - (-Infinity)   // -> NaN
```

**When a comparator returns `NaN` the sort behavior is undefined** (different engines give different results, and nothing errors).

```js
// bad: -Infinity to sort unknown last; two unknown values subtract to NaN
// good: a finite sentinel, and export a single comparator for every call site to reuse
const UNKNOWN_RANK = -Number.MAX_SAFE_INTEGER;
export function compareBy(sort) { /* ... */ }
```

**General rule**: for any design that "represents unknown or missing with one special value",
check whether it can enter an **arithmetic operation**. If so, replace it with a finite value, or compare for equality first inside the comparator.

---

## 5. Fault tolerance: one site's failure must not sink the whole

```js
const settled = await Promise.allSettled(
    providers.map((p) => searchOneSite(p, q, transport, timeoutMs))
);
```

A failed site is reported with an `error` inside `sites[]`, and the remaining results are returned as usual.

**Why this field is mandatory**: given only one merged list, the user cannot distinguish
"this resource does not exist" from "one of the sites is down". The UI must show "N sites succeeded / M failed" with expandable detail.

Inside `searchOneSite` every failure becomes a status and **nothing is thrown**:
URL construction failure, request failure and parse exceptions each record a different `error` message.
Among them, "parse failed (the site structure may have changed)" must be reported separately —
silently returning an empty result is misread as "this site does not have that resource".

---

## 6. Offline test fixtures (the highest-value step)

Capture one real response into a snapshot; the test reads the snapshot directly and never goes online:

```js
const parseFixture = (provider, file, query) =>
    provider.parse(fixture(file), { url: provider.buildSearchUrl(query), query });
```

**Value**: when a site redesign breaks the parser, the test fails immediately instead of waiting for a user to search and get an empty result.

**Two real bugs this caught** (impossible to find while hand-writing fake HTML):

1. The `alt` attribute appeared **before** `class`, while the regex assumed the opposite order — both arrangements must be accepted
2. A field name contained a **slash** (`Date/time submitted`);
   written into a regex literal it terminates the match early, so it must be escaped as `Date\/time`

---

## 7. One parser serving several sites

**The precondition is doing one thing first: confirm the two sites run the same software.**

Many sites are **different instances of the same program** (the same forum / blog / resource-site software,
differing only in domain and skin), with field-for-field identical HTML structure. In that case do not write two providers;
use a factory function taking different configuration to produce two instances:

```ts
export function createProvider(cfg: SiteConfig): SiteProvider { /* one body of parsing logic */ }

export const providerA = createProvider({ id:'a', base:'https://a.example', ... });
export const providerB = createProvider({ id:'b', base:'https://b.example',
    downloadBase:'https://dl.b.example',   // <- the direct-link domain may differ from the page domain
    adult:true, ... });
```

**The differences are usually only three, all in configuration**:

1. The domain
2. Relative vs absolute addresses
3. **The direct-link domain may differ from the page domain** (the page sits on one domain while the download link points at another)

> **Criterion**: before adding the second site, capture both sites' real responses and diff them once.
> Identical structure -> factory function; different structure -> honestly write a second provider.
> **Do not merge merely because they "look like the same program"** —
> that yields a parser littered with `if (site === ...)`.

**Testing note**: do not assert `p1.parse === p2.parse` — the factory returns a new object each time, so the references differ.
Assert instead that "the same HTML given to both yields identical parsed field structure".

---

## 8. The transport layer must be replaceable

```ts
export interface Transport {
    get(req: TransportRequest): Promise<TransportResponse>;
}
```

**Two practical benefits**:

1. Tests inject a fake implementation and run the whole fan-out flow offline (including failure injection)
2. If some site later needs to pass a Cloudflare challenge (requiring a `BrowserWindow` + CDP),
   only one implementation changes; the engine and every provider stay untouched

**Two cautions for renderer-side fetch**:

- The `referrer` option accepts same-origin addresses only; passing a cross-origin one throws `TypeError` outright (which takes down every site at once)
- `Referer` is a forbidden header for fetch; placing it in `headers` is silently dropped

---

## 9. Verification checklist

| Item | Means |
|---|---|
| Each provider parses correctly | offline test against real snapshots |
| Engine fan-out / fault tolerance / dedupe / sorting | fake transport with injected failures |
| End-to-end usable | run once against the real sites, printing per-site counts and timing |
| Cross-site dedupe actually works | compare "sum of both sites" against "after dedupe", and verify the intersection number lines up |

**The total time of a concurrent fan-out is roughly that of the slowest site, not the sum of all sites.**

---

## Self-check list

- [ ] Do module names / function names / type names / IPC channels still contain a site name?
- [ ] Have pagination, rate limiting, dedupe and field-filling — all generic — been lifted entirely into the engine?
- [ ] Are `buildSearchUrl` and `parse` pure functions (no network, no globals)?
- [ ] Does the provider redundantly fill in `site` / `siteLabel` (the engine should stamp those)?
- [ ] Are unknown values `-1` or `0`? Does filtering drop sites that do not publish that field?
- [ ] Can a sentinel value enter a comparator's subtraction and produce `NaN`?
- [ ] Is the magnet encoding unified to hex? Does "sum - after dedupe = intersection" line up?
- [ ] Before merging two sites, did you diff their real response structure?
- [ ] When one site fails, can the user distinguish "no such resource" from "that site is down"?
- [ ] Do the parser tests use real snapshots, or hand-written fake HTML?
