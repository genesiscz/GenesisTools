# tools ts

> **What is in this TypeScript file, what is written twice, and where does the startup time of an entry point go?**

Four command groups. `skeleton` prints a file's API. `duplicates` finds code written more than
once. `refactors` ranks what to change. `imports` answers the startup-cost question.

`skeleton`, `duplicates` and `refactors` take `--format text|md|json|json-compact|toon`, with
`--md`, `--json`, `--json-compact` and `--toon` as shorthands. Asking for two different formats is
a usage error. `imports` keeps its own `--json` and does not take `--format`.

Measured 2026-09-22 with Anthropic's tokenizer on `skeleton src/utils`: `--json` 643k tokens,
`--json-compact` 428k, `--toon` 433k. TOON is built from the object rows, so it is a table with
the keys named once; pick it when a reader wants field names, `--json-compact` when a parser does.

🛑 **`--json` changed meaning on 2026-09-22.** It used to be the columnar form; that is now
`--json-compact`. `--json` is the readable object form. A script that reads `cols` and positional
rows must move to `--json-compact`.

---

## `tools ts skeleton <paths...>`

Prints one line per declaration, so you can read a file's API without its bodies.

```
skeleton src/utils/tokens.ts (3 decls · 62% of 76 lines)
- L9-L11       export function estimateTokens(text: string): number
- L19-L30      export function countTokens(text: string): number
```

A path may be a file or a directory. Directories are walked recursively, skipping `node_modules`,
`dist`, `build`, `coverage`, dot-directories, `*.d.ts` and test files (`--tests` includes tests).

| Flag | Effect |
|------|--------|
| `--exported` | Only exported top-level declarations |
| `--top-level` | Skip class, interface and namespace members |
| `--types` | Print the full declaration of every type the signatures name, following imports, tsconfig `paths` aliases, `extends` bases and `typeof` aliases, two levels deep |
| `--include-names` | Add `name` and `kind` as their own fields, instead of leaving the name inside the signature |
| `--include-hash` | Add a fingerprint of each declaration, with its own name blanked out, so a renamed copy fingerprints the same |
| `--include-locals` | Also collect declarations inside function bodies, flagged `local` |
| `--function-context <n>` | Print the first N lines of each body under its signature |
| `--tests` | Include `*.test.ts` / `*.spec.ts` |
| `--ignore <substring>` | Skip any path containing this; repeatable |
| `--exact-tokens` | Count tokens with `@anthropic-ai/tokenizer` instead of the chars-per-token estimate |

**The `--include-*` flags are off by default because they cost payload, not because they are rare.**
Measured 2026-09-22 on a sibling repo's 20,102 symbols: `--include-names` adds 24.9% of the bytes and
`--include-hash` adds 17.0%. Turn them on when a machine is the reader; leave them off when a
person is.

---

## `tools ts duplicates <paths...>`   (alias `dupes`)

The same code written more than once, whether or not the copies share a name.

```
▪ `requireToken` · 5 copies · 8 lines · identical · 32 lines would go
    src/gitlab/commands/analyze-project.ts:35-42 ← keep this one
    src/gitlab/commands/analyze-user.ts:37-44
    …
    → export `requireToken` from src/gitlab/commands/analyze-project.ts; import it in 4 files
```

Two declarations are compared on their bodies, with comments stripped and each declaration's own
name blanked out. That blanking is what makes a renamed copy visible: a sibling repo's `walkFiles` and
`walk` are the same six lines under two names. Exact matches group on a fingerprint; near matches
group by MinHash banding, then a verified Jaccard against the group's representative.

| Flag | Effect |
|------|--------|
| `--min-lines <n>` | Ignore declarations shorter than this (default 3) |
| `--similarity <ratio>` | How alike two bodies must be, 0 to 1 (default 0.8) |
| `--kinds <list>` | Restrict to some declaration kinds |
| `--locals` | Also compare declarations inside function bodies |
| `--recommend` | Pick the copy to keep and write the edit that removes the others |
| `--include-patterns` | Show the groups suppressed as a deliberate repeated shape |
| `--include-same-file` | Show groups whose copies all live in one file |
| `--include-name-collisions` | Also list same-name declarations whose code differs |

### What it suppresses, and why

Three shapes are repetition somebody meant, and all three are hidden by default:

- **A method the whole family implements.** Four or more `method` copies under one directory. The
  fix is a base class, which is a design decision, not the import this report would recommend.
- **A numbered family.** Sibling files whose names differ only by digits: `40302.e2e.ts` beside
  `40303.e2e.ts`, one per test case or per migration.
- **Parallel implementations with their own names.** Four across a subtree, or three inside one
  directory, each copy separately named.

🛑 Directory alone is never enough. `requireToken` is copied five times inside one directory and is
a real defect; `waitForVisible` is implemented by 50 page objects under one directory and is not.
What separates them is the declaration's shape and whether the copies were given their own names.

---

## `tools ts refactors <paths...>`

Ranked recommendations, each with the sites and the edit. `--include <list>` selects the analysers,
`--include all` runs every one, `--include help` lists them.

| Analyser | Finds | Default |
|----------|-------|---------|
| `duplicates` | The same code written more than once | on |
| `shadowed` | A local helper whose name is already exported from a shared module | on |
| `long-functions` | A function long enough or nested deep enough to lose the thread | on |
| `param-bloat` | A long positional parameter list, especially with same-typed neighbours | on |
| `god-files` | A file holding far more declarations than the rest of the tree | off |
| `unused-exports` | An exported name that nothing in the scanned paths imports | off |

`shadowed` is the one that answers "why do we keep rewriting this?". It indexes every export of a
**shared** module (`utils`, `lib`, `shared`, `common`, `core`, `helpers`), then reports a private
declaration of that name in a file that does not import it.

🛑 It gates on the declaration's SHAPE, not its body. Measured 2026-09-22 on a sibling repo: the
canonical `git` and its private copies score 7% to 9% on bodies, and two unrelated `renderMarkdown`
functions score 2%. One body threshold cannot separate those. On signatures — return type weighted
0.6, parameter types 0.4 — the same pairs score 0.8 to 1.0 against 0.0 to 0.13.

| Flag | Effect |
|------|--------|
| `--include <list>` | Analysers, comma-separated, or `all`, or `help` |
| `--min-lines <n>` | Ignore declarations shorter than this (default 3) |
| `--max-function-lines <n>` | Budget for `long-functions` (default 60) |
| `--max-params <n>` | Budget for `param-bloat` (default 4) |
| `--max-declarations <n>` | Budget for `god-files` (default 40) |
| `--limit <n>` | Show at most this many recommendations (default 40) |

**The header is the honesty check.** `(12 decls · 36% of 527 lines)` means 64% of that file is not
represented. A skeleton lists declarations, so a file built from chained expression statements or
long function bodies will show a low percentage. Below 60% the figure turns yellow. Read the file
when you need a body, a string literal, a comment, control flow or a nested closure.

---

> **Where does the startup time of a TypeScript entry point go, and why?**

`tools ts imports analyze <entry>` prints the import tree of a file with a measured cost per module, then explains each slow module: a native addon, a top-level await, work at module scope, a barrel that drags in more than the caller uses, or an import cycle. Three companion commands turn the same measurement into actions: which imports to make lazy, which barrels to bypass, which cycles to break.

It exists because the question "why does `import("@genesiscz/utils/fs/watcher")` cost 19 ms" used to take a hand-written `performance.now()` script, and that script was wrong the first time because the module cache hid half the cost.

---

## Commands

| Command | Description |
|---------|-------------|
| `skeleton <paths...>` | Every declaration with its signature and line span |
| `duplicates <paths...>` | The same code written more than once, with the copy to keep |
| `refactors <paths...>` | Ranked refactor recommendations across six analysers |
| `imports analyze <entry>` | Import tree with self and total time per module, heaviest-modules table, and a "Why" paragraph per slow module |
| `imports lazy <entry>` | Static imports whose bindings are only used inside functions, ranked by the startup time `await import()` would save |
| `imports barrels <entry>` | `import { a } from "<barrel>"` sites where the barrel re-exports far more than `a` needs, priced in real ms |
| `imports cycles <entry>` | Import cycles on the startup path, with the edges that close them |

`<entry>` is a `.ts` file, a directory (its `index.ts`, or every top-level source file when there is none), or a `tsconfig.json` (its directory). Test files and `.d.ts` files never count as entries.

## Quick start

```bash
tools ts imports analyze src/utils/fs/watcher.ts
tools ts imports analyze src/notify/index.ts --include-dynamic   # dynamic import() targets too
tools ts imports analyze src/claude/index.ts --depth 3 --top 25 --runs 2
tools ts imports lazy src/notify/index.ts --min-ms 1
tools ts imports barrels src/claude/index.ts
tools ts imports cycles src/utils/logger.ts
tools ts imports analyze src/du/index.ts --json > /tmp/du-imports.json
```

## How the numbers are made

Nothing here is estimated from file size. Every number is a measurement in a fresh `bun` process.

1. **Static graph.** The entry is parsed with ast-grep; every runtime import edge is followed and resolved with `Bun.resolveSync`, so tsconfig `paths` (`@genesiscz/utils/*`, `@app/*`) resolve exactly as they do at runtime. `import type` and `import { type X }` are dropped, because Bun erases them. Module-scope `await import()` is a load-time edge and is always followed. Deferred `import()` inside a function is recorded but not followed unless `--include-dynamic` is set. A package under `node_modules` is one leaf node: its self time is the whole package, which is the number you can act on. `--walk-packages` parses inside packages too.

2. **Self time.** One worker process (`lib/measure-worker.ts`, deliberately free of repo imports) imports every module in the graph **children first**. Because each module's static children are already in the module cache when it is imported, the time `await import(module)` takes is that module's own evaluation and nothing else. This is the same module-cache behaviour that makes a naive script double count, turned into the measurement.

3. **Total time.** The sum of self time over everything statically reachable from a module, deduplicated. It is what a fresh process pays to import that module first.

4. **Cold import.** A separate process imports only the entry. The header prints it next to the sum of self times so the two can be compared: they should agree within a few ms.

5. **Runs.** Each mode runs `--runs` times (default 3) and the minimum per module is kept. Startup cost is a floor, so the minimum is the estimate least polluted by whatever else the machine was doing.

Things the measurement is honest about:

- **Import cycles.** The whole cycle evaluates when its first member is imported, so that member's self time is the cycle's and the others read near zero. Cycle members carry a `⇄` mark, and the "Why" section names which member paid.
- **A module that calls `process.exit()` while being imported** (a CLI entrypoint that parses argv at module scope) is reported as `exits-on-import`; the worker catches the exit, records the time, and keeps going.
- **A module that never resolves** (a top-level await on a prompt, say) is given up on after its own deadline — a third of `--timeout` in children-first mode, the full `--timeout` for a cold import of the entry — and reported as a `hang` row. The worker then exits; remaining plan lines run in a fresh process so a hung evaluation cannot pollute later self times. `--timeout` stays as the backstop for a module that blocks the event loop synchronously, and everything measured before a kill survives, because the worker appends one line per module as it goes.
- **The worker runs an entrypoint with `--help` in argv**, not with an empty one. Commander runs its DEFAULT action for an empty argv, and a default action that opens a prompt never returns: `tools ai` used to have both of its workers killed at 60 s for exactly that, and the table was then built from a partial results file with nothing on screen saying so. `--help` is also the argv that loads every subcommand tree, which is what a cost analysis of an entrypoint wants.
- **A partial run says so.** When a worker is killed, or a planned module comes back with no sample, a warning is printed ABOVE the table naming how many of the plan are missing; `--json` is always an array of sessions and every command carries `timedOut`, `planned` and `unmeasured`.
- **A package's self time depends on what is already warm.** `@parcel/watcher` measures about 4.5 ms in the children-first plan, where `node:fs` and friends are already loaded, and about 7.5 ms imported alone in an empty process. Both are real; the tool reports the marginal one.

## Reading `analyze`

```
  cold import 20.6 ms   sum of self 19.1 ms   modules 24 (3 packages)   runs 3, min kept
  Import tree (children sorted by total, hottest first)
src/utils/fs/watcher.ts  total   19.1 ms  self   0.27 ms
└─ src/utils/logger.ts ⇄  total   18.8 ms  self   0.00 ms
   ├─ src/utils/logger/out.ts ⇄  total   18.8 ms  self   0.00 ms
   │  ├─ pkg:@clack/prompts  total   7.41 ms  self   7.41 ms
   │  └─ src/utils/cli/result.ts  total   5.12 ms  self   0.09 ms
   │     └─ src/utils/json.ts  total   5.03 ms  self   0.20 ms
   ...
```

- `total` is what importing that module first would cost; `self` is its own evaluation. A module with large total and tiny self is a conduit; look at its children.
- A subtree already printed is collapsed into one dim `(shared, shown above: …)` line per parent.
- Rows below `--min-ms` (default 0.5) are hidden and counted.
- The **heaviest modules** table ranks by self time; `WHY` is the first finding.
- The **Why** section lists findings with `file:line` anchors for modules whose self time is at least 1 ms, plus any module with a medium or high finding:
  - `native addon`: a `.node` file, a `napi`/`binary`/`gypfile` manifest, per-platform binary dependencies, or `bun:ffi` / `dlopen` in the source.
  - `top-level await`: every importer waits for it.
  - `module-scope work`: calls and constructions that run at evaluation time, classified (database open, child process, file system, timer, process hook, network, constructor call). Collection literals, path joins, colour wrappers and scoped loggers are filtered out as noise.
  - `barrel`: mostly `export … from` lines; a caller pays for every target however few names it uses.
  - `pulls N modules`: a large subtree.
  - `carries an import cycle` / `in an import cycle`.
- **Dynamic imports** found on the way are listed at the end; `--include-dynamic` walks and measures them, marked `(lazy)` in the tree.

## `lazy`: what would a dynamic import save?

For every static import on the startup path, the parser checks whether any imported binding is referenced at module scope of the importer (a top-level expression, a re-export, a class static block). If none is, turning the import into `await import()` at the use site keeps the importer's own module scope identical. The saving is the self time of every module that is on the startup path through that one edge and through nothing else (modules another path also reaches are not counted). A caveat names module-scope hooks, timers or assignments in the target that would run later than they do today.

## `barrels`: what does an unused re-export cost?

For `import { a, b } from "<barrel>"`, the names are traced to the re-export targets that supply them (`export { a } from`, or `export * from` resolved through the target's own exports). Every other target is waste. The ms figure is the self time of modules that leave the startup path if the importer reached the used targets directly, so it is a real saving, never a gross. Namespace imports (`import * as`) use everything and are skipped.

## `cycles`

Tarjan's strongly connected components over load-time edges (static, require, module-scope `await import()`). A cycle is where "X is not a function" at import time comes from: whichever member evaluates first sees the others' exports as `undefined` until they finish. Deferred `import()` is not an edge here, even with `--include-dynamic`; it never cycles at load time.

## Options

| Option | Commands | Meaning |
|--------|----------|---------|
| `--json` | all | Machine-readable result on stdout (nothing else goes there) |
| `--runs <n>` | all | Fresh processes per mode, minimum kept (default 3) |
| `--timeout <seconds>` | all | Kill a worker after this long; partial results survive (default 60) |
| `--min-ms <ms>` | all | Hide rows below this (default 0.5) |
| `--walk-packages` | all | Parse inside `node_modules` instead of one leaf per package |
| `--include-dynamic` | all | Follow and measure dynamic `import()` targets, marked lazy |
| `--depth <n>` | analyze | Tree depth (default 4) |
| `--top <n>` | analyze | Rows in the heaviest table and paragraphs in Why (default 15) |

Profiling of the tool itself: `PROFILE=ts tools ts imports analyze …` prints graph build, each worker run and attribution timings through the shared profiler.

## Layout

```
src/ts/
├── index.ts                 commander entry (`tools ts`)
├── commands/
│   ├── options.ts           the --format and scan flags every subcommand shares
│   ├── imports.ts  skeleton.ts  duplicates.ts  refactors.ts
└── lib/
    ├── collect.ts           walk paths to source files, honouring --tests and --ignore
    ├── load.ts              one read of every file, shared by skeleton/duplicates/refactors
    ├── format.ts            resolve --format and emit text / md / json / json-compact / toon
    ├── skeleton.ts          declarations, fingerprints, body context, local declarations
    ├── signature.ts         parameter types, return type, signature-shape similarity
    ├── duplicates.ts        shingles, MinHash banding, clustering, pattern suppression
    ├── refactors/           one file per analyser, plus the registry
    ├── parse.ts             ast-grep: imports with names, re-exports, module-scope work, scope uses
    ├── graph.ts             resolve + walk, post-order, reachability
    ├── measure-worker.ts    the process that imports and times; no repo imports on purpose
    ├── measure.ts           spawns the worker per run/mode, keeps the minimum
    ├── analyze.ts           graph + measure + totals + attribution → AnalysisResult
    ├── attribute.ts         why a module is slow (native, await, side effects, barrel, subtree, cycle)
    ├── barrels.ts  lazy.ts  cycles.ts
    └── render.ts            terminal output (box tables from @genesiscz/utils/table)
```

## Limits

- Bun only: the worker uses `Bun.resolveSync` and `bun run`, and the numbers are Bun's transpile-plus-evaluate cost, not Node's.
- Self time for a package is marginal cost with the rest of the graph warm (see above).
- `require()` inside a function body is treated as dynamic; `require()` at module scope as a static edge.
- Module-scope side effect detection is syntactic. It sees `new Database("x")` at top level; it does not see a `Database` constructed inside a function that a top-level statement calls.
- Barrel tracing follows `export * from` six levels deep and stops there.
- `duplicates` and `refactors` are syntactic. They compare declarations as text and shape; they do
  not resolve types, so two helpers with the same signature over different types read as alike.
- `unused-exports` cannot see a consumer outside the scanned paths, a name reached through
  `export *`, or a name reached by a string key. It is evidence, never a verdict.
