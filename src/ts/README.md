# tools ts

> **Where does the startup time of a TypeScript entry point go, and why?**

`tools ts imports analyze <entry>` prints the import tree of a file with a measured cost per module, then explains each slow module: a native addon, a top-level await, work at module scope, a barrel that drags in more than the caller uses, or an import cycle. Three companion commands turn the same measurement into actions: which imports to make lazy, which barrels to bypass, which cycles to break.

It exists because the question "why does `import("@genesiscz/utils/fs/watcher")` cost 19 ms" used to take a hand-written `performance.now()` script, and that script was wrong the first time because the module cache hid half the cost.

---

## Commands

| Command | Description |
|---------|-------------|
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

1. **Static graph.** The entry is parsed with ast-grep; every runtime import edge is followed and resolved with `Bun.resolveSync`, so tsconfig `paths` (`@genesiscz/utils/*`, `@app/*`) resolve exactly as they do at runtime. `import type` and `import { type X }` are dropped, because Bun erases them. Dynamic `import()` edges are recorded but not followed unless `--include-dynamic` is set. A package under `node_modules` is one leaf node: its self time is the whole package, which is the number you can act on. `--walk-packages` parses inside packages too.

2. **Self time.** One worker process (`lib/measure-worker.ts`, deliberately free of repo imports) imports every module in the graph **children first**. Because each module's static children are already in the module cache when it is imported, the time `await import(module)` takes is that module's own evaluation and nothing else. This is the same module-cache behaviour that makes a naive script double count, turned into the measurement.

3. **Total time.** The sum of self time over everything statically reachable from a module, deduplicated. It is what a fresh process pays to import that module first.

4. **Cold import.** A separate process imports only the entry. The header prints it next to the sum of self times so the two can be compared: they should agree within a few ms.

5. **Runs.** Each mode runs `--runs` times (default 3) and the minimum per module is kept. Startup cost is a floor, so the minimum is the estimate least polluted by whatever else the machine was doing.

Things the measurement is honest about:

- **Import cycles.** The whole cycle evaluates when its first member is imported, so that member's self time is the cycle's and the others read near zero. Cycle members carry a `⇄` mark, and the "Why" section names which member paid.
- **A module that calls `process.exit()` while being imported** (a CLI entrypoint that parses argv at module scope) is reported as `exits-on-import`; the worker catches the exit, records the time, and keeps going.
- **A module that never resolves** (a top-level await on a prompt, say) is given up on after its own deadline, a third of `--timeout`, and reported as a `hang` row. The run continues, so one bad module costs one deadline instead of the whole measurement. `--timeout` stays as the backstop for a module that blocks the event loop synchronously, and everything measured before a kill survives, because the worker appends one line per module as it goes.
- **The worker runs an entrypoint with `--help` in argv**, not with an empty one. Commander runs its DEFAULT action for an empty argv, and a default action that opens a prompt never returns: `tools ai` used to have both of its workers killed at 60 s for exactly that, and the table was then built from a partial results file with nothing on screen saying so. `--help` is also the argv that loads every subcommand tree, which is what a cost analysis of an entrypoint wants.
- **A partial run says so.** When a worker is killed, or a planned module comes back with no sample, a warning is printed ABOVE the table naming how many of the plan are missing; `--json` carries `timedOut`, `planned` and `unmeasured`.
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

Tarjan's strongly connected components over the startup edges. A cycle is where "X is not a function" at import time comes from: whichever member evaluates first sees the others' exports as `undefined` until they finish. Dynamic imports are not edges here; they never cycle at load time.

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
├── commands/imports.ts      the four subcommands, thin: parse flags, call lib, render
└── lib/
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
