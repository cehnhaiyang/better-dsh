---
name: testing-ts-source-without-runtime
description: How to actually execute and test TypeScript source in a Node harness that has no TypeScript runtime — importing .ts directly with type stripping, converting Windows paths to file:// URLs, why the harness's node action accepts only .js paths and the wrapper that runs an .mjs test anyway, the "require is not defined in ES module scope" trap under "type":"module", why regex-based type stripping corrupts extracted code (a (?: group becomes (:, breaking every regex inside), why @ts-nocheck hides undeclared-variable errors (TS2304) until runtime, and how to detect them by compiling a copy with the directive stripped.
whenToUse: Read when you need to run or unit-test a .ts file from Node, when a test harness refuses a path or reports bucket-of-errors from a source-text extractor, when a "test the real implementation, not a copy" helper misbehaves on code containing regex literals, or when a file that type-checks clean throws ReferenceError at runtime.
---

# Running and Testing TypeScript Source in a Node Harness

## 1. Prefer importing the real file

- Node 22.6+ strips types with `--experimental-strip-types`; Node 23 and later do it natively. Under those versions `await import('./src/x.ts')` runs the **real** implementation, with no extraction and no copy that can drift from it.
- On Windows, a bare path is not a URL. `await import('D:\\proj\\src\\x.ts')` fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME` / `Only URLs with a scheme in: file, data, and node are supported by the default ESM loader … Received protocol 'd:'`. Always convert:

```js
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(join(ROOT, 'src', 'x.ts')).href);
```

- Cache-bust when the same file is imported twice in one process with different content: append `'?v=' + Date.now()` to the href.
- A `.ts` file whose module graph pulls in the DOM cannot be imported this way. Restructure the pure part into its own file rather than reaching for §3.

## 2. Getting a script to run at all in this harness

- The `js` tool's `node` action takes **comma-separated `.js` paths only**. A `.mjs` path is rejected with `不是 .js 脚本` ("not a .js script"). To run an existing `.mjs` test file, write a one-line `.js` wrapper that spawns node on it:

```js
import { spawnSync } from 'node:child_process';
const r = spawnSync(process.execPath, ['test/some.test.mjs'], { encoding: 'utf8' });
process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
process.exit(r.status === null ? 1 : r.status);
```

  Deleting such a wrapper is part of finishing (see `execution-and-collaboration-protocol` §9).
- Passing a **directory** to the `node` action runs every `.js` beneath it, skipping `node_modules` and dot-directories.
- With `"type": "module"` in `package.json`, every `.js` is an ES module: `require` throws `ReferenceError: require is not defined in ES module scope`. Use `import`, or name the file `.cjs`.
- `spawnSync(cmd, args, { shell: true })` logs `DEP0190` (args are concatenated unescaped). Acceptable for a fixed test-runner wrapper; never interpolate untrusted input into it.

## 3. If you must extract code from source text

Extraction — pulling a function out of a `.ts` file by bracket matching and rebuilding it in `new Function(...)` — is a last resort for files that cannot be imported (DOM deps, side effects at module scope). It buys "test the real source" but costs a class of silent corruption.

- **Type annotations cannot survive.** `new Function` has no type stripper: `let seal: SoupSeal | null = null;` throws `SyntaxError: Unexpected token ':'`. The extractor must strip annotations, or the extracted source must be written without them.
- **Regex-based type stripping corrupts regex literals.** A rule like `/\?\s*:/g → ':'` (meant to turn optional-property `x?: T` into `x: T`) also rewrites a non-capturing group `(?:` into `(:`. Every regex inside the extracted function then breaks or matches something else. Symptom: the extracted function throws `SyntaxError: Invalid regular expression` at an unexpected place, or silently behaves differently from the real one.
- **The same hazard applies to comment strippers and brace counters** that do not recognise regex literals: a `/` that starts a regex is treated as the start of a comment (or a division), and everything after it is swallowed or mis-nested. A robust scanner needs the preceding-significant-character heuristic: `/` after `( , = : [ ! & | ? { } ; + - * % < > ~ ^` or `return` starts a regex literal, otherwise it is division.
- **Therefore**: never extract from code containing regex literals when §1 is available. When extraction is unavoidable, assert on the extracted function's behaviour against a known-good value rather than trusting the transform.

## 4. `@ts-nocheck` hides runtime-fatal errors

- `// @ts-nocheck` at the top of a file suppresses **all** diagnostics for that file, including `TS2304` (undeclared identifier). A mistyped variable name therefore ships and only throws `ReferenceError` when that line finally runs — often on a rarely-taken path (a load-from-save branch, an error handler).
- Detection: copy the file, strip the directive, run `tsc --noEmit`, and filter the output for `TS2304` and `TS2451` (duplicate declaration in one scope — the other shape a half-completed refactor leaves behind). Do not edit the original; write the copy, compile, delete.
- Treat `TS2304`/`TS2451` as a **separate, stricter** gate from the normal build: the file's own `@ts-nocheck` will keep the normal build green forever.
