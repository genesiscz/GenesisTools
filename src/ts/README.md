# tools ts

TypeScript analysis for people and agents who need numbers instead of guesses. It prints a file's API without its
bodies, finds code written twice and ranks what to refactor, measures where an entry point's startup time and CPU
time go, measures what type-checking a program costs, and maps a deployed minified position back to its source line.

Nine command groups answer nine questions:

- `skeleton`: what is in this file or folder?
- `duplicates`: what is written more than once?
- `refactors`: what should I change first?
- `areas`: which folders import which, and which import each other?
- `depth`: which modules are shallow, with an interface as big as their code?
- `imports`: where does the startup time of an entry point go, and why? (`imports startup` asks it for many entry
  points at once.)
- `profile`: where does the CPU time of a whole run go, function by function?
- `program`: why does type-checking need gigabytes, and which code makes the checker work hardest?
- `sourcemaps`: which source line is `chunk.js:95812`, when the deployment publishes no maps?

## Quick start

`tools ts` ships with GenesisTools: run `bun install && ./install.sh` once in the checkout and `tools` is on your
`PATH`. Paths are relative to the current folder, and the examples use paths of the GenesisTools checkout; every
command works on any other TypeScript project too. Nothing is tied to one repository: no root, alias table or folder
name is built in. The scanned paths and the current folder decide the areas, and imports resolve through Bun's
resolver, which reads the nearest `tsconfig.json` `paths`.

```bash
# The public API of a folder: one line per exported declaration, no bodies
tools ts skeleton src/utils --exported --top-level

# Ranked refactor recommendations (duplicates, shadowed helpers, long functions, long parameter lists)
tools ts refactors src

# The import graph between folders, and the folders that import each other
tools ts areas src --split src/utils

# The import tree of an entry point, with measured self and total time per module
tools ts imports analyze src/notify/index.ts

# A CPU profile of a tool run: hot functions and the repository's own call tree
tools ts profile ai --runs 3 -- usage sessions --json

# Heap and time to parse, bind and check ./tsconfig.json
tools ts program cost

# A deployed minified position to its source line, with a local build folder as the maps
tools ts sourcemaps resolve https://app.example.com/static/js/710.f9e49e56.chunk.js:95812 \
    --deployed https://app.example.com/ \
    --build ./web/build
```

## Commands

| Command | What it answers |
|---|---|
| `skeleton <paths...>` | Every declaration with its signature and line span |
| `duplicates <paths...>` (alias `dupes`) | The same code written more than once, with the copy to keep |
| `refactors <paths...>` | Ranked recommendations from six analysers |
| `areas <paths...>` | Static import graph between areas: size, fan-in, fan-out, mutual pairs, forbidden directions, Mermaid |
| `depth <paths...>` | Shallow and deep modules: interface size against code, pass-through exports, importers |
| `imports analyze <entry>` | Import tree with self and total time per module, and why a slow one is slow |
| `imports lazy <entry>` | Static imports safe to turn into `await import()`, ranked by the time saved |
| `imports barrels <entry>` | Barrel imports whose unused re-exports cost real milliseconds |
| `imports cycles <entry>` | Import cycles on the startup path, with the edges that close them |
| `imports startup [entries...]` | Cold import cost of many entries in one table, then the heavy modules two or more of them pay for |
| `profile <entry> [-- args...]` | CPU profile of a whole run, optionally of every thread |
| `program cost [tsconfig]` | Heap after each check phase, time, files, the checker's counts |
| `program files [tsconfig]` | Each file's check, ranked by what it created |
| `program own <files...>` | One file's own check cost: the before and after instrument for an edit |
| `program closure [tsconfig]` | What a tsconfig of one folder would hold, and why a package is in |
| `program sites [tsconfig]` | The costliest calls and type references, grouped by what they call |
| `program trace [tsconfig]` | `tsc --generateTrace` hot spots with their source lines |
| `sourcemaps resolve <positions...>` | A deployed `<url>:<offset>` or `<url>:<line>:<col>` to its source line |
| `sourcemaps fetch [base-url]` | Snapshot a deployment's JS and CSS, and preflight every published `.map` |
| `sourcemaps env [base-url]` | The env values a deployment inlined, as `--env` flags for a build |
| `sourcemaps build` | Build a commit with your build command and keep the output and maps |
| `sourcemaps rank` | How much of the deployed code each local build contains |
| `sourcemaps find-commit` | The commit a deployment was built from |
| `sourcemaps check` | How often `resolve` is right on this deployment |
| `sourcemaps carry` | A source map for every deployed chunk, for DevTools |
| `sourcemaps cache list\|prune --project <name>` | What the cache holds, and pruning it (prune: or `--all`) |

`tools ts --readme` prints this file. `-v, --verbose` turns on verbose logging for every command.

### Output formats (`skeleton`, `duplicates`, `refactors`, `areas`, `depth`, `imports startup`)

These six take `--format text|md|json|json-compact|toon`, with `--md`, `--json`, `--json-compact` and `--toon` as
shorthands. Asking for two different formats is a usage error (`Pick one output format; got md and json`);
repeating the same one (`--format json --json`) is fine. The other groups (the other `imports` subcommands,
`profile`, `program`, `sourcemaps`) take only `--json` and do not take `--format`.

| Format | For |
|---|---|
| `text` (default) | A person in a terminal |
| `--md` | A pull request or a note |
| `--json` | Readable JSON, one named key per field |
| `--json-compact` | A parser: the field names once in `cols`, then positional rows |
| `--toon` | An agent that wants field names: tables with the keys named once |

Measured 2026-09-22 with Anthropic's tokenizer on `skeleton src/utils`: `--json` 643k tokens, `--json-compact` 428k,
`--toon` 433k. TOON is built from the object rows, so it is a table with the keys named once. Built from the
positional rows it cost 493k, 15% more than `--json-compact`. Pick TOON when a reader wants field names,
`--json-compact` when a parser does.

🛑 **`--json` changed meaning on 2026-09-22.** It used to be the columnar form; that is now `--json-compact`.
`--json` is the readable object form. A script that reads `cols` and positional rows must move to `--json-compact`.

### Which files the static commands read

`skeleton`, `duplicates`, `refactors`, `areas` and `depth` share the same input rules:

- A path is a file, a directory or a quoted glob. A directory is walked recursively.
- A file that you name directly is always read, whatever its extension: also a `*.d.ts` file, and also a test file
  without `--tests`. A `.js` file named this way is parsed as JavaScript.
- The next three filters apply when a directory is walked and when a quoted glob expands:
  - Only `.ts`, `.tsx`, `.mts` and `.cts` files are read. `*.d.ts` files are not read.
  - The walk skips `node_modules`, `dist`, `build`, `coverage`, `.next`, `.git` and every other dot-directory.
  - Test files (`*.test.ts`, `*.spec.ts`, also with `.tsx`, `.mts`, `.cts`) are skipped unless you pass `--tests`.
- `--ignore <substring>` skips any path that contains the substring below the path you named. It never matches the
  folders above it, so `tools ts skeleton src --ignore test` run inside `~/Projects/test-app` does not skip every
  file. The named path itself is matched as the current folder shows it, so `--ignore .gen.` still skips
  `src/x.gen.ts` named directly. Repeatable.
- A quoted glob (`'src/utils/repos*.ts'`) expands to its source files (since 2026-10-21). A path that exists as
  typed is never read as a pattern.
- A path that does not exist or holds no source prints `No TypeScript source found` and the command exits 1.

---

### `tools ts skeleton <paths...>`

Prints one line per declaration, so you can read a file's API without its bodies.

```
skeleton src/utils/tokens.ts (3 decls · 62% of 76 lines)
- L9-L11       export function estimateTokens(text: string): number
- L19-L30      export function countTokens(text: string): number
```

| Flag | Effect |
|---|---|
| `--exported` | Only exported top-level declarations |
| `--top-level` | Skip class, interface and namespace members (only depth-0 declarations stay) |
| `--types` | Also print the declaration of every type the signatures name |
| `--include-names` | Add `name` and `kind` as their own fields |
| `--include-hash` | Add a fingerprint of each declaration, with its own name blanked out |
| `--include-locals` | Also collect declarations inside function bodies, flagged `local` |
| `--function-context <n>` | Print the first N lines of each body under its signature |
| `--exact-tokens` | Count tokens with `@anthropic-ai/tokenizer` instead of the estimate |
| `--rank` | Order files by importance instead of by path; print rank and importer count |
| `--max-tokens <n>` | Keep the highest-ranked files that fit this token budget (implies `--rank`) |
| `--files-only` | Print only the ranked file list: rank, importers, declarations, path (implies `--rank`) |
| `--tests`, `--ignore <s>` | See "Which files the static commands read" |
| `--format` and shorthands | See "Output formats" |

- **`--types`** follows imports, tsconfig `paths` aliases, `extends` bases and `typeof` aliases, two levels deep.
  A type alias does not use up a level. A type declared in a package is named with its package, not opened.
- **`--include-hash`** blanks the declaration's own name, so a renamed copy fingerprints the same.
- **`--max-tokens`** measures the printed skeletons in the chosen format, with `--function-context` bodies and
  `--types` included. A high-rank file that does not fit is skipped, so smaller lower-rank files can still use the
  room. The files left out are named in the closing line and in `stats.omitted`, which the budget does not count.
- **The token count** is an estimate of 3.77 characters per token unless you pass `--exact-tokens`. Measured
  2026-09-19 with `@anthropic-ai/tokenizer`: 30,000 characters of this repository's TypeScript came to 7,959
  tokens. An earlier estimate of 2.54 came from a GPT-3 encoder that counts about 40% more tokens. The tokenizer
  package carries the Claude 1 and 2 vocabulary, so even `--exact-tokens` is the right family, not an exact figure;
  `tools ai tokens --method claude-api` is the exact route.
- **The closing line** (`● 8 file(s) · original 38,390 tokens · skeleton 520 tokens · 98.6% smaller`) goes to
  stderr, so stdout holds only the skeleton.

**The header is the honesty check.** `(12 decls · 36% of 527 lines)` means 64% of that file is not represented. A
skeleton lists declarations, so a file built from chained expression statements or long function bodies shows a low
percentage. Below 60% the figure turns yellow. Read the file when you need a body, a string literal, a comment,
control flow or a nested closure.

**Ranking (what `tools repo-map` used to do).** Rank is 0.5 importers + 0.2 size + 0.3 recency (the recency weight
halves every 14 days), each part scaled to 0..1. Importers are the scanned files that import a file, resolved the
way Bun resolves them, so tsconfig aliases like `@app/...` count. They are counted among the files you scanned, so
scan the whole tree (`tools ts skeleton src --files-only`) for a global ranking, not one folder.
`tools ts skeleton src --max-tokens 8000 --exported --top-level` is the old "map of the repo inside a budget". A
directory walk ranks TypeScript files only (the extensions above); a JavaScript file is read only when you name it
directly. `repo-map` also read JavaScript, Python, Go and Rust.

**The `--include-*` flags are off by default because they cost payload, not because they are rare.** Measured
2026-09-22 on a sibling repository's 20,102 symbols: `--include-names` adds 24.9% of the bytes and `--include-hash`
adds 17.0%. Turn them on when a machine is the reader; leave them off when a person is.

---

### `tools ts duplicates <paths...>` (alias `dupes`)

The same code written more than once, whether or not the copies share a name. The copy to keep and the edit (the
`←` and `→` lines below) appear only with `--recommend`:

```
$ tools ts duplicates src/gitlab --recommend
▪ `requireToken` · 5 copies · 8 lines · identical · 32 lines would go
    src/gitlab/commands/analyze-project.ts:35-42 ← keep this one
    src/gitlab/commands/analyze-user.ts:37-44
    …
    → export `requireToken` from src/gitlab/commands/analyze-project.ts; import it in 4 files
```

| Flag | Effect |
|---|---|
| `--min-lines <n>` | Ignore declarations shorter than this (default 3) |
| `--similarity <ratio>` | How alike two bodies must be, 0 to 1 (default 0.8) |
| `--kinds <list>` | Compare only these declaration kinds, comma-separated |
| `--locals` | Also compare declarations inside function bodies |
| `--recommend` | Pick the copy to keep and write the edit that removes the others |
| `--include-patterns` | Show the groups suppressed as a deliberate repeated shape |
| `--include-same-file` | Show groups whose copies all live in one file |
| `--include-name-collisions` | Also list same-name declarations whose code differs |
| `--limit <n>` | Show at most this many groups (default 40) |
| `--tests`, `--ignore <s>` | See "Which files the static commands read" |
| `--format` and shorthands | See "Output formats" |

The kinds are `function`, `method`, `constructor`, `getter`, `setter`, `field`, `class`, `interface`, `namespace`,
`type`, `enum`, `const`, `re-export`, `default` and `call`. An unknown kind is refused with the list.

**How it compares.** Two declarations are compared on their bodies, with comments stripped and each declaration's
own name blanked out. That blanking is what makes a renamed copy visible: a sibling repository's `walkFiles` and
`walk` are the same six lines under two names. Exact matches group on a fingerprint. Near matches group by MinHash
banding, then a verified Jaccard against the group's representative.

**What it suppresses, and why.** Three shapes are repetition somebody meant, and all three are hidden by default
(`--include-patterns` shows them):

- **A method the whole family implements.** Four or more `method` copies under one directory. The fix is a base
  class, which is a design decision, not the import this report would recommend.
- **A numbered family.** Sibling files whose names differ only by digits: `40302.e2e.ts` beside `40303.e2e.ts`,
  one per test case or per migration.
- **Parallel implementations with their own names.** Four across a subtree, or three inside one directory, each
  copy separately named.

🛑 Directory alone is never enough. `requireToken` is copied five times inside one directory and is a real defect;
`waitForVisible` is implemented by 50 page objects under one directory and is not. What separates them is the
declaration's shape and whether the copies were given their own names.

---

### `tools ts refactors <paths...>`

Ranked recommendations, each with its sites and the edit. A closing line on stderr counts the recommendations, the
high-severity ones, the lines that could go and the files scanned.

| Analyser | Finds | Default |
|---|---|---|
| `duplicates` | The same code written more than once | on |
| `shadowed` | A local helper whose name is already exported from a shared module | on |
| `long-functions` | A function or method longer than the line budget | on |
| `param-bloat` | A long positional parameter list, especially with same-typed neighbours | on |
| `god-files` | A file holding far more top-level declarations than the rest of the tree | off |
| `unused-exports` | An exported name that nothing in the scanned paths imports | off |

| Flag | Effect |
|---|---|
| `--include <list>` | Analysers, comma-separated, or `all`, or `help` to list them |
| `--min-lines <n>` | Ignore declarations shorter than this (default 3) |
| `--similarity <ratio>` | How alike two bodies must be for `duplicates`, 0 to 1 (default 0.8) |
| `--max-function-lines <n>` | Budget for `long-functions` (default 60) |
| `--max-params <n>` | Budget for `param-bloat` (default 4) |
| `--max-declarations <n>` | Budget for `god-files` (default 40) |
| `--locals` | Also consider declarations inside function bodies |
| `--include-patterns` | Keep the duplicate groups that look like a deliberate repeated shape |
| `--include-same-file` | Keep the duplicate groups whose copies all live in one file |
| `--limit <n>` | Show at most this many recommendations (default 40) |
| `--tests`, `--ignore <s>` | See "Which files the static commands read" |
| `--format` and shorthands | See "Output formats" |

**`shadowed`** is the one that answers "why do we keep rewriting this?". It indexes every export of a **shared**
module (a path with a `utils`, `util`, `lib`, `shared`, `common`, `core` or `helpers` folder), then reports a
private declaration of that name in a file that does not import it. Gating on the name alone flooded the report with
`main`, `run` and `log`, which every CLI entry point owns.

🛑 It gates on the declaration's SHAPE, not its body. Measured 2026-09-22 on a sibling repository: the canonical
`git` and its private copies score 7% to 9% on bodies, and two unrelated `renderMarkdown` functions score 2%. One
body threshold cannot separate those. On signatures (return type weighted 0.6, parameter types 0.4) the same pairs
score 0.8 to 1.0 against 0.0 to 0.13.

**`long-functions`** reports a function or method longer than `--max-function-lines`. Nesting does not report a
function by itself, but a function nested five or more levels deep, or longer than three times the budget, is
high severity.

**`param-bloat`** reports more positional parameters than `--max-params`. Two neighbours of the same type
(`(cwd: string, ref: string, path: string)`) let a caller swap them silently, so they raise the severity. The
recommended edit is one options object, with the first one or two required arguments kept positional.

**`god-files`** uses the greater of `--max-declarations` and the tree's own 90th percentile as the cut-off, so a
repository of large files does not report every file. Below ten files the budget alone is the bar.

**`unused-exports`** is off by default because it is the one analyser that reports something you must verify first.

---

### `tools ts areas <paths...>`

The static import graph between areas, for an architecture review. An area is the first folder under each scanned
path (`src/hub`, `src/question`); a file directly in a scanned path belongs to `<path>/(root)`.

```bash
tools ts areas src --split src/utils                         # src/utils/ai, src/utils/cli, src/utils/(root) ...
tools ts areas src --split src/utils --forbid "src/utils->src/" --json
tools ts areas src --split src/utils --mermaid --min-edges 20 > areas.mmd
```

Per area: files, lines (as `wc -l` counts them), fan-in and fan-out (distinct areas importing it and imported by
it), and the import sites in, out and inside. Then the **mutual pairs** (two areas importing each other, both counts),
the **cross-area edges** heaviest first, and one block per `--forbid` rule.

- **An edge is one import site**: an import or re-export statement, a side-effect import, a `require()` or an
  `import()`. It is resolved with Bun's resolver, so tsconfig `paths` aliases count the way the runtime resolves them.
  Packages and builtins are not edges.
- **Dynamic edges are counted and marked.** `import()` and a `require()` inside a function load lazily, so each edge
  and each mutual pair says how many of its sites are dynamic. In `--mermaid`, an edge whose every site is dynamic is
  dashed.
- **Type-only imports count** as static coupling and are reported apart (`typeOnly`), since nothing loads at run time.
- `--forbid "<from>-><to>"` (repeatable): an edge breaks the rule when its source area is inside `<from>` and its
  target inside `<to>`. "Inside" means the folder itself or one below it, whole names only: `src/utils` holds
  `src/utils/ai` but not `src/utilsX`, and a trailing `/` changes nothing. An edge that stays inside `<from>` is
  exempt, so `"src/utils->src"` lists every utils area importing a tool, with each site's `file:line`. When `<to>` is
  itself inside `<from>` (`"src/utils->src/utils/ai"`), the rule forbids exactly those edges and only the edges
  inside `<to>` are exempt. The command exits 1 when a rule is broken, so it can guard CI.

| Flag | Effect |
|---|---|
| `--split <dir>` | Group one level deeper inside this folder; repeatable, the deepest one wins; a folder that does not exist is a usage error |
| `--depth <n>` | Folder levels below a scanned path (or a `--split` folder) that make one area (default 1) |
| `--forbid <rule>` | A direction that must not exist; repeatable |
| `--limit <n>` | Rows per table in text and markdown (default 40); JSON always has every row |
| `--mermaid` | Print a Mermaid flowchart instead: mutual edges red, dynamic-only edges dashed (`--md` fences it) |
| `--min-edges <n>` | With `--mermaid`, draw only edges with at least this many sites (default 5) |
| `--tests`, `--ignore <s>` | See "Which files the static commands read" |
| `--format` and shorthands | See "Output formats" |

Checked on this repository on 2026-11-08 15:38 against the regex probe it replaces: `src/utils/agent-sessions` and
`src/utils/ai` import each other 88 and 40 times, and `src/hub` imports `src/question` 61 times, the same counts in
both. The probe put every import of a folder's `index.ts` (`@genesiscz/utils/env`) into `src/utils/(root)`; the
resolver puts it into `src/utils/env`, which is why the `(root)` edges are smaller here and some areas gained edges.

Cost, on the same day (2026-11-08 15:52, a Mac at load average 330 to 400): `areas src --split src/utils` over 6593
files took 6 to 7 s of wall time, most of it the ast-grep parse of every file; `depth src/utils` over 1737 files took
2 to 3 s.

---

### `tools ts depth <paths...>`

The shallow-module finder. A module is **deep** when much behaviour sits behind a small interface, and **shallow**
when the interface is nearly as big as the implementation. A module is a folder (`--by folder`, the default: the
first folder under each path, as in `areas`) or one file (`--by file`).

```bash
tools ts depth src/utils
tools ts depth src/utils --within src --json        # count importers from the whole of src
tools ts depth src/utils/ai --by file --limit 40
```

| Column | Meaning |
|---|---|
| `EXPORTS` | Exported names; a re-export statement counts one per name it lists, `export *` counts one, `export {}` none; `export { helper }` counts the declaration `helper` as if it were marked `export` |
| `IFACE` | **Characters** of every exported signature, whitespace collapsed, plus the non-private members of an exported class, interface, enum, namespace or object API |
| `CODE` | Characters of the module's text with comments removed and whitespace collapsed |
| `SHARE` | `IFACE / CODE`, at most 1: how much of the module a caller must read to use it |
| `RE-EXP` | Share of exports that pass through: `export … from`, or an imported binding listed in `export { … }` |
| `THIN` | Exported functions whose body is at most 3 lines, out of all exported functions: forwarders |
| `IMPORTERS` | Distinct files outside the module, and inside `--within`, that import it |
| `AREAS` | Distinct areas those importers sit in |

The ranking:

- `shallow = 0.6 × SHARE + 0.4 × (re-exports + thin exports) / exports`, from 0 to 1. Modules with fewer than
  `--min-exports` names (default 2) and modules whose every export is a type or an interface are left out: a types
  file holds no behaviour to hide, so it would top the list without telling you anything.
- `deep = code lines per export × log2(1 + importer files)`. The deep table lists the top `--deep` (default 10)
  modules with at least one importer: much behaviour behind few names, used widely.

| Flag | Effect |
|---|---|
| `--by folder\|file` | What one module is (default `folder`) |
| `--within <path>` | Where importers are counted; repeatable; the default is the scanned paths |
| `--split <dir>` | Group importers and folder modules one level deeper, as in `areas`; repeatable |
| `--min-exports <n>` | Names a module needs to be ranked shallow (default 2) |
| `--limit <n>` | Rows in the shallow table (default 25) |
| `--deep <n>` | Rows in the deep table (default 10) |
| `--tests`, `--ignore <s>` | See "Which files the static commands read" |
| `--format` and shorthands | See "Output formats" |

`--within` sets where importers are counted, so `depth src/utils` counts only importers inside `src/utils`. The JSON
forms carry every module under `modules`, beside the two ranked tables.

---

### `tools ts imports analyze|lazy|barrels|cycles <entry>`

`analyze` prints the import tree of a file with a measured cost per module, then explains each slow module: a
native addon, a top-level await, work at module scope, a barrel that drags in more than the caller uses, or an
import cycle. The three companion commands turn the same measurement into actions: which imports to make lazy, which
barrels to bypass, which cycles to break.

It exists because the question "why does `import("@genesiscz/utils/fs/watcher")` cost 19 ms" used to take a
hand-written `performance.now()` script, and that script was wrong the first time because the module cache hid half
the cost.

```bash
tools ts imports analyze src/utils/fs/watcher.ts
tools ts imports analyze src/notify/index.ts --include-dynamic   # dynamic import() targets too
tools ts imports analyze src/claude/index.ts --depth 3 --top 25 --runs 2
tools ts imports lazy src/notify/index.ts --min-ms 1
tools ts imports barrels src/claude/index.ts
tools ts imports cycles src/utils/logger.ts
tools ts imports analyze src/du/index.ts --json > /tmp/du-imports.json
tools ts imports startup --tools src --runs 2 --md              # every tool entry, one table
```

**`<entry>`** is one of:

- a source file (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.jsx`);
- a directory: its `index.ts`, `index.tsx`, `index.js` or `index.mjs`, or every top-level source file when it has
  none (with several entries, `imports analyze` then ends with a summary row per entry);
- a `tsconfig*.json`: its directory.

Test files and `.d.ts` files never count as entries. An entry that resolves to nothing prints `No entry found` and
exits 1.

| Option | Commands | Meaning |
|---|---|---|
| `--json` | analyze, lazy, barrels, cycles | Machine-readable result on stdout (nothing else goes there); `startup` takes the `--format` set instead |
| `--runs <n>` | all | Fresh processes per mode, minimum kept (default 3) |
| `--timeout <seconds>` | all | Kill a worker after this long; partial results survive (default 60) |
| `--min-ms <ms>` | analyze, lazy, barrels | Hide rows below this (default 0.5); `cycles` takes it, lists all |
| `--walk-packages` | all | Parse inside `node_modules` instead of one leaf per package |
| `--include-dynamic` | all | Follow and measure dynamic `import()` targets, marked lazy |
| `--depth <n>` | analyze | Tree depth (default 4) |
| `--top <n>` | analyze | Rows in the heaviest table and paragraphs in Why (default 15) |

#### How the numbers are made

Nothing here is estimated from file size. Every number is a measurement in a fresh `bun` process.

1. **Static graph.** The entry is parsed with ast-grep. Every runtime import edge is followed and resolved with
   `Bun.resolveSync`, so tsconfig `paths` (`@genesiscz/utils/*`, `@app/*`) resolve exactly as they do at runtime.
   `import type` and `import { type X }` are dropped, because Bun erases them. Module-scope `await import()` is a
   load-time edge and is always followed. Deferred `import()` inside a function is recorded but not followed unless
   `--include-dynamic` is set. A package under `node_modules` is one leaf node: its self time is the whole package,
   which is the number you can act on. `--walk-packages` parses inside packages too.
2. **Self time.** One worker process (`lib/measure-worker.ts`, deliberately free of repository imports) imports every
   module in the graph **children first**. Because each module's static children are already in the module cache
   when it is imported, the time `await import(module)` takes is that module's own evaluation and nothing else. This
   is the same module-cache behaviour that makes a naive script double count, turned into the measurement.
3. **Total time.** The sum of self time over everything statically reachable from a module, deduplicated. It is what
   a fresh process pays to import that module first.
4. **Cold import.** A separate process imports only the entry. The header prints it next to the sum of self times so
   the two can be compared: they should agree within a few ms.
5. **Runs.** Each mode runs `--runs` times (default 3) and the minimum per module is kept. Startup cost is a floor,
   so the minimum is the estimate least polluted by whatever else the machine was doing.

Things the measurement is honest about:

- **Import cycles.** The whole cycle evaluates when its first member is imported, so that member's self time is the
  cycle's and the others read near zero. Cycle members carry a `⇄` mark, and the "Why" section names which member
  paid.
- **A module that calls `process.exit()` while being imported** (a CLI entry point that parses argv at module scope)
  is reported as `exits-on-import`. The worker catches the exit, records the time, and keeps going.
- **A module that never resolves** (a top-level await on a prompt, say) is given up on after its own deadline and
  reported as a `hang` row. The deadline is a third of `--timeout` (at least 1 s) in children-first mode, and the
  full `--timeout` for a cold import of the entry. The worker then exits, and the remaining plan lines run in a fresh
  process, so a hung evaluation cannot pollute later self times. `--timeout` stays as the backstop for a module that
  blocks the event loop synchronously. Everything measured before a kill survives, because the worker appends one
  line per module as it goes.
- **The worker runs an entry point with `--help` in argv**, not with an empty one. Commander runs its DEFAULT action
  for an empty argv, and a default action that opens a prompt never returns: `tools ai` used to have both of its
  workers killed at 60 s for exactly that, and the table was then built from a partial results file with nothing on
  screen saying so. `--help` is also the argv that loads every subcommand tree, which is what a cost analysis of an
  entry point wants.
- **A partial run says so.** When a worker is killed, or a planned module comes back with no sample, a warning is
  printed ABOVE the table naming how many of the plan are missing. `--json` is always an array of sessions, and
  every command carries `timedOut`, `planned` and `unmeasured`.
- **A package's self time depends on what is already warm.** `@parcel/watcher` measures about 4.5 ms in the
  children-first plan, where `node:fs` and friends are already loaded, and about 7.5 ms imported alone in an empty
  process. Both are real; the tool reports the marginal one.

#### Reading `analyze`

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

- `total` is what importing that module first would cost; `self` is its own evaluation. A module with a large total
  and a tiny self is a conduit: look at its children.
- A subtree already printed is collapsed into one dim `(shared, shown above: …)` line per parent.
- Rows below `--min-ms` (default 0.5) are hidden and counted.
- The **heaviest modules** table ranks by self time; `WHY` is the first finding.
- The **Why** section lists findings with `file:line` anchors for modules whose self time is at least 1 ms, plus any
  module with a medium or high finding:
  - `native addon`: a `.node` file, a `napi`/`binary`/`gypfile` manifest, per-platform binary dependencies, or
    `bun:ffi` / `dlopen` in the source.
  - `top-level await`: every importer waits for it.
  - `module-scope work`: calls and constructions that run at evaluation time, classified (database open, child
    process, file system, timer, process hook, network, constructor call). Collection literals, path joins, colour
    wrappers and scoped loggers are filtered out as noise.
  - `barrel`: mostly `export … from` lines; a caller pays for every target however few names it uses.
  - `pulls N modules`: a large subtree.
  - `carries an import cycle` / `in an import cycle`.
- **Dynamic imports** found on the way are listed at the end; `--include-dynamic` walks and measures them, marked
  `(lazy)` in the tree.
- The last line suggests the matching `imports lazy` command.

#### `lazy`: what would a dynamic import save?

For every static import on the startup path, the parser checks whether any imported binding is referenced at module
scope of the importer (a top-level expression, a re-export, a class static block). If none is, turning the import
into `await import()` at the use site keeps the importer's own module scope identical. The saving is the self time of
every module that is on the startup path through that one edge and through nothing else (modules another path also
reaches are not counted). A caveat names module-scope hooks, timers or assignments in the target that would run later
than they do today.

#### `barrels`: what does an unused re-export cost?

For `import { a, b } from "<barrel>"`, the names are traced to the re-export targets that supply them
(`export { a } from`, or `export * from` resolved through the target's own exports). Every other target is waste. The
ms figure is the self time of modules that leave the startup path if the importer reached the used targets directly,
so it is a real saving, never a gross. Namespace imports (`import * as`) use everything and are skipped.

#### `cycles`

Tarjan's strongly connected components over load-time edges (static, `require`, module-scope `await import()`). A
cycle is where "X is not a function" at import time comes from: whichever member evaluates first sees the others'
exports as `undefined` until they finish. Deferred `import()` is not an edge here, even with `--include-dynamic`; it
never cycles at load time.

#### `startup`: which dependency taxes every tool?

`tools ts imports startup <entries...>` measures each entry the way `analyze` does and prints one row per entry:
the cold import, the module count, and the `--top` (default 3) heaviest modules by self time. An entry is a file or a
folder with an `index.ts` or `index.tsx`; `--tools <dir>` (repeatable) adds the index of every folder directly
inside `<dir>`.

The second table is the point: a module or package whose self time is at least `--min-ms` (default 20) in two or more
entries, with how many entries pay it, the summed and the largest ms, and which entries. A package is one row
(`pkg:<name>`) however many of its files are imported. That table shows a dependency whose cost leaks across many
tools; one fix to it pays back in each of them.

Entries are measured one after another by default, because parallel measurements slow each other down and inflate
every number; `--concurrency <n>` trades that accuracy for time. `--runs`, `--timeout`, `--walk-packages` and
`--include-dynamic` mean what they mean for `analyze`. An entry whose worker timed out is marked `partial`; an entry
in which a module threw, imported a missing file or never settled is marked `failed` with the module and its error,
since its fast cold time is only the time to the failure (an `exit` on `--help` is no failure). Failed and partial
entries sort first, and the command exits 1 when there is one.

---

### `tools ts profile <entry> [-- args...]`

Where does the CPU time of a command go, function by function, without adding a single timer? It runs the entry
under `bun --cpu-prof` (a sampling profiler built into Bun 1.3.13 and later), adds the samples up, and prints three
views, like `pprof top` and `pprof tree` do for Go:

- **Hot functions:** self and total time per function, natives included (`parse` is `JSON.parse`).
- **Repository functions:** only this checkout's code. "own" is the time with that function as the deepest
  repository frame, so it includes the library and native calls it makes but not the repository functions it calls.
- **Repository call tree:** stacks reduced to repository frames, with their share and milliseconds per run.

`<entry>` is any `.ts` or `.js` file of any project, resolved from the current folder, and the run happens in the
current folder, so the project's own `tsconfig.json`, `bunfig.toml` and relative paths apply. Frames under the
nearest folder holding `.git` count as repository code. A bare name is a GenesisTools shortcut: `ai` is
`src/ai/index.ts` of GenesisTools. A path that exists wins over a tool name. Put the entry's own arguments after
`--`; flags before `--` go to the profiler.

```bash
tools ts profile ai --runs 3 --threads -- usage sessions --json --hours 24 --min 10 --fresh --no-cache-write
tools ts profile src/ts/index.ts --focus collect -- skeleton src/utils
tools ts profile ai --bun /path/to/bun-1.3.13 -- usage sessions --json   # compare Bun versions
cd ~/Projects/app && tools ts profile src/index.ts -- build --help         # any other codebase
```

| Flag | Effect |
|---|---|
| `--runs <n>` | Runs to add together (default 1); CPU and wall are medians. Use 3 or more |
| `--interval <us>` | Sampling interval in microseconds (default 250, at least 50) |
| `--top <n>` | Rows per table (default 20) |
| `--depth <n>` | Call tree depth (default 8) |
| `--min-pct <n>` | Hide call tree nodes under this share (default 1) |
| `--focus <name>` | Show the call tree below functions whose name contains this |
| `--threads` | Also sample every thread of the first run with `/usr/bin/sample` (macOS) |
| `--bun <path>` | Bun binary to profile with (default: the one running this tool) |
| `--json` | The report as JSON |

**The header** prints the CPU of all threads (median), the wall time (median), the time sampled on the JavaScript
thread per run, and the waiting that was cut. `--threads` adds a table of what busy threads were doing, waits
removed.

🛑 **Profile milliseconds are sampled time on the JavaScript thread.** A native call that blocks (a `stat`, a file
read) counts in full, and work on other threads (Bun's I/O pool, the JIT, the garbage collector) does not count at
all. The header prints the process CPU of all threads next to it. Measured on 2026-10-12: a hand-run profile showed
`statSync` at 310 ms, which cost 25 ms of CPU; `--threads` then showed file opens on Bun's pool threads as 44% of
the busy samples, which the JavaScript profile could not show. Confirm a finding with CPU time before acting on it.

**Await gaps are cut (since 2026-10-12).** Bun records an `await` as one long gap between two samples, and a plain
sum bills it to the JavaScript frame on the stack: a function that awaited 500 ms looked like 700 ms of work in
Bun's own markdown report. A gap longer than eight sampling intervals (and at least 8 ms) counts as one interval of
work, and the rest is reported as "waiting, cut".

**Overhead and noise** (from the performance skill's profiling reference): +3.0% at 1000 µs, +4.4% at 250 µs and
+9.9% at 100 µs. Shares under 10% from fewer than 300 samples are noise, so use `--runs 3` or more.

The `.cpuprofile` files (`run-1.cpuprofile`, and `threads.txt` with `--threads`) stay in
`~/.genesis-tools/ts/profiles/<time>/` and open in speedscope.app or Chrome DevTools. `bun --cpu-prof-md` writes a
markdown summary of one run without this tool.

---

### `tools ts program cost|files|own|closure|sites|trace`

Why does type-checking this project need gigabytes, and which code makes the checker work hardest?

Each command checks a tsconfig's program with the project's OWN `typescript` (the copy beside this tool when the
project has none) in a separate `node` process, because V8's heap is the one `tsc` and a reviewer's
`ts.createProgram` use. `--runtime bun` checks under Bun instead (`bun --smol`, JavaScriptCore numbers). `--heap
<MiB>` limits the node process (for `trace`, the node process that runs `tsc`), so `cost --heap 3072` answers "does
it fit a 3 GiB reviewer" by passing or failing as out of memory. With `--runtime bun`, `--heap` is ignored: the
worker runs as `bun --smol` with no heap limit, so a `--runtime bun --heap 3072` run tests no limit. The tsconfig
argument is a file or a folder holding `tsconfig.json`, default `./tsconfig.json`.
Every command takes `--json`.

The default heap is 16384 MiB, not node's own default (about 4 GiB on a Mac), because the GenesisTools root program
exceeded that before 2026-10-25: a measurement must finish, and a limit is something you ask for on purpose.

The default worker requires Node.js 22.18 or newer with built-in TypeScript stripping enabled, because it runs the
worker's `.ts` source directly. On an older Node installation, pass `--runtime bun` to `cost`, `files`, `own`,
`closure` or `sites`. `trace` runs the project's JavaScript `tsc` entry point (`typescript/lib/tsc.js`, which must
resolve from the tsconfig's folder) and only requires a Node version supported by that project's TypeScript.

- **`cost`:** the heap after a full collection at each phase (parse, bind, check), the time, the files and bytes
  (declaration packages apart), the checker's types, instantiations and symbols, and the diagnostics.
- **`files`:** each file checked in program order with what its check created, ranked `--by instantiations` (or
  `types`, `symbols`, `ms`). `--folders` sums per folder. The first file to touch a shared library type pays for it,
  so read a ranking, not exact ownership.
- **`own <files...>`:** one file's own work, in a smaller program: the target files plus the tsconfig's own `.d.ts`
  files, and what they import. Everything in it except the targets is checked first, then each target. This is the
  before and after instrument for an edit: run it, change the file, run it again. Its scope is not the full program:
  another root file's `declare global` or module augmentation is missing unless a target imports that file, so the
  diagnostics and the numbers can differ from `files` (which checks the whole program).
- **`closure`:** what a tsconfig of only one folder would hold (files, bytes, the other folders and packages it
  pulls in), the declaration packages by size with the project files that import them, and `--why <needle>`, the
  shortest import chain from a project file to the first file whose path contains the needle. It also lists packages
  whose declarations are in the program from more than one installed copy (a nested `node_modules`), with the bytes
  deduplicating would save. `--no-ambient` leaves out the project's root `.d.ts` files, for a folder tsconfig that
  does not include them. No checking, so it is quick.
- **`sites`:** finds the next costly code shape without reading code. During the first check of each file, every
  call, `new`, JSX element and type reference is resolved on its own, and what it created is grouped by what it calls
  or references (`name @ declaring file`). A high MEDIAN over many sites is a shape that costs at every use; one
  large site with a low median is the first use of a library type. A call is measured after its callee and before
  its arguments, so an argument's work counts for the call that receives it (measured the other way, an argument's
  contextual type resolves the outer call and the argument takes the blame). `--by median --min-sites 3` finds
  repeated shapes, `--project-only` keeps keys declared in the project, `--key <text>` lists the single sites.
- **`trace`:** runs `tsc --generateTrace` (or reads `--dir <folder>`) and lists the slowest files and the slowest
  single check events with their source line. Nested events overlap: a statement's time includes its expressions.
  A trace it ran stays in `~/.genesis-tools/ts/traces/<time>/`; a stopped or failed run removes its partial trace.

| Flag | Commands | Meaning |
|---|---|---|
| `--runtime <node\|bun>` | all but trace | Where the check runs (default `node`) |
| `--heap <MiB>` | all | Heap limit of the node process (default 16384); ignored with `--runtime bun` |
| `--timeout <s>` | all | Stop the check after this many seconds (default 900) |
| `--json` | all | The result as JSON |
| `--top <n>` | files, closure, sites, trace | Rows per table (default 30) |
| `--by <key>` | files | `instantiations` (default), `types`, `symbols`, `ms` |
| `--by <key>` | sites | `instantiations` (default), `median`, `types`, `ms`, `sites` |
| `--folders` | files | Sum per folder instead of per file |
| `--tsconfig <path>` | own | The project's tsconfig (default `./tsconfig.json`) |
| `--why <needle>` | closure | The import chain to the first file whose path contains this |
| `--no-ambient` | closure | Leave out the project's root `.d.ts` files |
| `--min-sites <n>` | sites | Only groups with at least this many sites (default 1) |
| `--key <text>` | sites | List the single sites whose key contains this, costliest first |
| `--project-only` | sites | Only keys declared in the project |
| `--dir <path>` | trace | Read an existing `--generateTrace` folder instead of running tsc |
| `--min-ms <n>` | trace | Smallest single check event to list (default 50) |

```bash
tools ts program cost                              # heap per phase of ./tsconfig.json
tools ts program cost --heap 3072                  # passes or fails like a reviewer with a 3 GiB heap
tools ts program files --folders                   # which folders create the most work
tools ts program own src/artifact/runtime/kit/chartjs.tsx
tools ts program closure --why stripe              # why a package is in the program
tools ts program sites --by median --min-sites 3   # shapes that cost at every use
tools ts program sites --key callLLMStructured     # the single sites of one group
tools ts program trace --min-ms 100
```

What it found in GenesisTools on 2026-10-25 (root program, TypeScript 6.0, 9,995 files, 4.4 GiB retained heap), each
fix type-only, measured with `own` before and after:

- `new Chart(canvas, config)` inferred Chart's type parameters over a union of every chart type: 1,084 ms and 250k
  symbols for one expression. `new Chart<ChartType>(…)`: 12 ms.
- Icon and link props typed `React.ElementType` (a union of every HTML tag) made each JSX use cost about 175k
  instantiations, 220 to 250 ms per file. `React.ComponentType<…>`: 4 to 38 ms.
- TypeScript 6 adds no `@types` package to the global scope unless `types` names it (an import still loads its own
  package's types), so Bun's globals reached the program only through one file that imports `bun`; a program of
  fewer files reported "Cannot find name 'Bun'".
- A program of one folder needs 0.9 to 1.5 GB, against 4.1 GiB for the whole root.
- `sites` on the commit before those fixes ranked them without help: the `ElementType` icons at places 2 and 6 to 11
  (86k to 160k instantiations each), `new Chart` at 12 (1,260 ms), `generateText` at 15, `Parameters<typeof …>` at
  34.

---

### `tools ts sourcemaps`

Which source line is `https://app.example.com/static/js/710.f9e49e56.chunk.js:95812`, when the deployment publishes
no maps?

A Long Animation Frame entry (`sourceURL` + `sourceCharPosition`) or a stack frame points into a minified chunk. When
the `.map` files are deployed, the answer is one lookup. Often they are not: they went to an error monitor and were
deleted from the image. Then the only maps are the ones a local build produces, and a local build never matches byte
for byte (a monitoring snippet injected before minification renames every identifier; build-time values are
inlined).

The resolvers run in order and stop at the first answer:

1. **deployed-map** (exact): the file's own `sourceMappingURL`, fetched once per deployment by `fetch` (the
   preflight).
2. **debug-id** (exact, optional): the file's debug id (`//# debugId=` or Sentry's `sentry-dbid-<uuid>`) looked up in
   maps kept from an earlier run, a `--maps-dir`, or Sentry's artifact lookup.
3. **local-build** (aligned or approximate): identifiers are collapsed in the deployed and the local chunk, a code
   window around the position must occur exactly once in the local chunk, the code before and after must agree, and
   the local `.map` answers. A build of another commit still resolves unchanged modules, and the result says how much
   of the chunk differs. With `--deployed-commit` the line is moved through `git diff` to the deployed commit's
   version of the file. Measured with a second build as the deployment: 96 to 99.5% right line, 100% after
   translation on Vite.

GenesisTools knows nothing about the project. The caller passes the deployed base URL (or `--deployed-dir`), and
either finished build folders (`--build <dir>`) or a checkout, commit and THEIR build command
(`--repo --commit --build-cmd --output`). In a terminal without either, `resolve` asks which one. Without
`--deployed`, `resolve` takes the origin of the first position.

| Command | What it does |
|---|---|
| `resolve <url>:<offset>...` | Each position (or `<url>:<line>:<col>`) to its source line |
| `fetch <base-url>` | Snapshot the deployment's JS and CSS; preflight every published `.map` |
| `env <base-url>` | The env values the deployment inlined, as `--env` flags for `build` |
| `build --repo --commit --build-cmd --output` | Build a commit in a worktree; keep output and maps in the cache |
| `rank --deployed --build <dir>...` | How much deployed code each build holds; matching chunk debug ids |
| `find-commit --deployed --repo --range A..B --build-cmd --output` | The deployed commit, from one reference build |
| `check --deployed --build <dir>` | How often `resolve` is right on THIS deployment |
| `carry --deployed --build <dir> --out <dir>` | A map for every deployed chunk, carried from the build |
| `cache list\|prune --project <name>` | What the cache holds, and pruning it (prune: or `--all`) |

```bash
tools ts sourcemaps fetch https://app.example.com/
tools ts sourcemaps env https://app.example.com/
tools ts sourcemaps resolve https://app.example.com/static/js/710.f9e49e56.chunk.js:95812 \
    --deployed https://app.example.com/ \
    --repo . \
    --commit v1.2.3 \
    --build-cmd 'bun install && bun run build' \
    --output web/build
tools ts sourcemaps find-commit \
    --deployed https://app.example.com/ \
    --repo . \
    --range v1.2.0..origin/main \
    --build-cmd 'bun install --frozen-lockfile && bun run build' \
    --output web/build \
    --link .npmrc
tools ts sourcemaps check --deployed https://app.example.com/ --build ./web/build --files 40
tools ts sourcemaps carry --deployed https://app.example.com/ --build ./web/build --out ./carried-maps
tools ts sourcemaps cache prune --all
```

#### Shared flags

The deployment (`resolve`, `fetch`, `env`, `rank`, `find-commit`, `check`, `carry`):

| Flag | Meaning |
|---|---|
| `--deployed <base-url>` | Where the app is deployed (`fetch` and `env` also take it as the argument) |
| `--page <url>` | An app page to start from when the base URL serves no HTML; repeatable |
| `--asset <url>` | A deployed file discovery misses (its chunk references are followed too); repeatable |
| `--deployed-dir <dir>` | A copy of the deployment on disk instead of fetching it |
| `--refresh` | Fetch again even when the cache has this deployment |
| `--project <name>` | Cache folder name (default: the `--repo` folder name, else the host) |
| `--json` | Machine-readable result |

The local build (`resolve`, `build`, `rank`, `find-commit`, `check`, `carry`):

| Flag | Meaning |
|---|---|
| `--build <dir>` | A finished build folder (JS next to its `.map` files); repeatable |
| `--repo <dir>` | Git checkout to build from (never built in place: a worktree is used) |
| `--commit <ref>` | Commit to build with `--build-cmd` |
| `--build-cmd <cmd>` | YOUR build command, run with `sh -c` in the worktree root |
| `--output <dir>` | The build output folder, relative to the worktree root |
| `--link <file>` | Untracked file of `--repo` to symlink into the worktree (`.npmrc`); repeatable |
| `--env <KEY=VALUE>` | Extra environment for the build command; repeatable |
| `--deployed-env` | Also pass the env the deployment inlined; an explicit `--env` wins. Not on `build` |
| `--worktree <dir>` | Build in this worktree instead of the managed one (never removed) |
| `--keep-worktree` | Keep the managed build worktree for a faster next build |
| `--build-commit <ref>` | The commit a `--build` folder was made from (enables line translation) |
| `--deployed-commit <ref>` | The commit the deployment was built from (find-commit's answer) |

⚠️ `--deployed-env` works only on the commands that also read a deployment (`resolve`, `rank`, `find-commit`,
`check`, `carry`). `build --help` lists it too, but `build` reads no deployment and takes no `--deployed` or
`--deployed-dir`, so `build --deployed-env` always fails with `--deployed-env reads the deployment: pass --deployed
<base-url> or --deployed-dir <dir>`. For `build`, run `tools ts sourcemaps env <base-url>` and pass the `--env` flags
it prints.

Debug ids (`resolve`, `check`):

| Flag | Meaning |
|---|---|
| `--maps-dir <dir>` | Maps from any source, by debug id: `<id>.map`, `debug_id` in the JSON, a Sentry `.zip` |
| `--sentry <url>` | Ask Sentry's artifact lookup by debug id |
| `--sentry-mcp <server>` | Take the Sentry URL, token and CA from this Claude Code MCP server entry |
| `--sentry-org <slug>` | Sentry organization (default `SENTRY_ORG`); listed when missing |
| `--sentry-project <slug>` | Sentry project (default `SENTRY_PROJECT`); listed when missing |
| `--sentry-token-stdin` | Read the Sentry token from stdin (default `SENTRY_AUTH_TOKEN`) |
| `--sentry-ca <pem>` | CA bundle for a Sentry behind a private CA |

#### Per-command flags

- `fetch --out <dir>` and `build --out <dir>`: also expose the snapshot or build output there, as a symlink into the
  cache. `build --project <name>` defaults to the `--repo` folder name.
- `carry --out <dir>` (required): the folder for the carried maps and their `index.json`.
- `check --per-file <n>` (default 8): literals sampled per deployed file. `check --files <n>` (default all): deployed
  files sampled, spread evenly.
- `find-commit --range <A..B>` (required): the deployed commit is after A and at or before B. `--base <ref>`: the
  reference build (default the end of the range). `--strategy [tokens|rebuild]` (default `tokens`). `--no-verify`:
  skip the build that confirms the best-ranked commit (tokens). `--max-builds <n>` (default 8): candidate builds
  besides the base (rebuild). `--all-parents`: walk merged branches too (default first-parent only).
- `cache [list|prune]` (default `list`): `cache list` requires `--project <name>`; without it, the error names the
  cached projects. `cache prune` requires `--project <name>` or `--all` (every project), and
  `--max-age-days <n>` (default 30) sets its age limit. Both take `--json`.

#### What each command does

**resolve** takes one or more positions and runs each through the resolver chain. For each one it prints the source
line, the evidence, any warnings and a code excerpt. It exits 1 when a position stays unresolved.

**fetch** takes the file list from a build manifest, else from the page's scripts, the bundler runtime's chunk table
and ES imports.

**rank** reports, for each `--build`, how much of the deployed code it contains and how many chunk debug ids match.

**find-commit** (`--strategy tokens`, the default) builds one reference commit and ranks every first-parent commit
of the range by how closely the strings and property names it would put in the bundle match the deployed ones; no
build per commit. Commits that produce the same strings tie, and the oldest of the tie introduced the deployed code;
one more build confirms it (`verified`). It also reports, as evidence only: commit shas the bundle names, the newest
`Last-Modified` of the deployed files (commits after it cannot be the build), and inlined env values the build did
not get. `--strategy rebuild` traces the differing code through the reference build's maps to source files and
builds the commits that touched them instead.

**env** matters because a local build made with other env values differs from the deployment in strings and, worse,
in the code a bundler removed as dead (`if (process.env.REACT_APP_X === "true") ...`). Pass the `--env` flags it
prints to `build`. The commands that also read the deployment (`resolve`, `rank`, `find-commit`, `check`, `carry`)
take `--deployed-env` instead, which reads the same values for you. Only env OBJECTS (`process.env` and
`import.meta.env`) are recoverable: a value a define replaced one by one has lost its name.

**check** uses the deployment's own string literals as ground truth. It samples unique literals (they survive
minification as they are), resolves each one's position with
the same chain `resolve` uses, and counts how often the literal is in the source within 3 lines of the answer, per
confidence word (`exact`, `aligned`, `approximate`). Run it once per deployment and build pair, then trust
`resolve`'s words as far as these numbers say. Literal-heavy code is easier than average: read it as an upper bound.

**carry** compares each deployed chunk with its local counterpart with identifiers collapsed, and moves every local
mapping in code that is equal to the same code in the deployed chunk. Mappings in code that differs are dropped,
never guessed. The maps name the LOCAL build's lines, so build the deployed commit (find-commit) for line-exact
results. Measured: webpack and rsbuild 100% right line on 12k+ probes in about 1.4 s for 350 chunks; Vite with a
build 3 commits off 90%. Then let DevTools show the real sources while you debug the deployed page:
`tools chrome-devtools intercept --match '<tab>' --map-dir <out>`.

#### The cache

`~/.genesis-tools/ts/sourcemaps/<project>/<id>/` with an index in `<project>/metadata.json` (kind, origin, size,
last use). A deployment snapshot is keyed by its asset list, a build by commit + command + output folder, so a second
run reuses both. Pass the same `--project` every time. Maps fetched by debug id are kept in
`<project>/debug-id-maps/`. `--out <dir>` exposes an entry as a symlink.

Every command that writes the cache first removes entries unused for 30 days, and folders a failed build left
(`cache prune --max-age-days` to do it by hand). `cache prune` prints what it freed.

Builds run in one managed worktree per project (`<project>/worktree`) unless `--worktree` names one; `--link .npmrc`
symlinks untracked files the build needs. The installed dependencies make that worktree gigabytes for a large app,
so a command that built (`build`, `find-commit`, `rank`, `resolve`, `check`, `carry`) removes it with
`git worktree remove` when it ends, also after a failure or Ctrl-C (since 2026-10-13). `cache prune` removes one
unused for an hour. `--keep-worktree` keeps it for a faster next build: on a small fixture (13 packages, 78 MB) a
build took about 0.5 s with a fresh install and 0.2 s with the kept one. A worktree is never removed while a build
runs in it, while it is locked with `git worktree lock`, while a process has its working directory inside it, or
when it has tracked changes; a worktree named with `--worktree` is never removed. `cache prune` prints a warning for
each worktree it kept, and exits 1 when a project could not be pruned.

The full guide, with the fastest order, every strategy's cost and its measured hit rate, is the chrome-devtools
skill's [`references/sourcemaps.md`](../../plugins/genesis-tools/skills/chrome-devtools/references/sourcemaps.md).
The library is `src/utils/ts/sourcemaps/` (`resolvers/` holds one file per resolver).

## How it works

Everything runs on your Mac. No command calls an AI model or a paid API. Only `sourcemaps` uses the network: it
fetches the deployed files and their maps, and with `--sentry` or `--sentry-mcp` it asks Sentry's artifact lookup.

| Command group | What it runs |
|---|---|
| `skeleton`, `duplicates`, `refactors`, `areas`, `depth` | The TypeScript parser (syntax only) and ast-grep; `areas` and `depth` also resolve imports with Bun's resolver; nothing runs |
| `imports` (also `startup`) | Fresh `bun` worker processes (`lib/measure-worker.ts`) that import the graph and time it |
| `profile` | `bun --cpu-prof` on the entry in the current folder; `/usr/bin/sample` with `--threads` |
| `program` | `node --expose-gc --max-old-space-size=<heap>` on `lib/program/check-worker.ts`, or `bun --smol` |
| `program trace` | The project's own `tsc` under node, with `--max-old-space-size=<heap>` |
| `sourcemaps` | `fetch`, `git worktree`, your build command (`sh -c`), and `git diff` for line translation |

What it needs:

- Bun. `imports` measures Bun's transpile-plus-evaluate cost, not Node's.
- `node` on `PATH` for `program` (Node.js 22.18 or newer for every command but `trace`), unless you pass
  `--runtime bun`.
- macOS for `profile --threads` (`/usr/bin/sample`). Nothing in this tool needs a privacy permission.
- `git` for `sourcemaps build`, `find-commit` and every `--repo` build.

Where data lives:

| Path | What |
|---|---|
| `~/.genesis-tools/ts/profiles/<time>/` | `profile`: `run-<n>.cpuprofile` per run, `threads.txt` with `--threads` |
| `~/.genesis-tools/ts/traces/<time>/` | `program trace`: the `--generateTrace` output |
| `~/.genesis-tools/ts/sourcemaps/<project>/` | `sourcemaps`: snapshots, builds, debug-id maps, the build worktree |

`program` writes its worker's result to a temporary `gt-ts-program-*` folder and removes it when the check ends.
Nothing else is written: `skeleton`, `duplicates`, `refactors`, `areas`, `depth` and `imports` keep no state.

## Configuration

The tool has no config file. Environment variables:

| Variable | Effect |
|---|---|
| `PROFILE=ts` | `imports` prints graph build, each worker run and attribution timings through the shared profiler |
| `PROFILE=sourcemaps` | `sourcemaps` times each phase |
| `SENTRY_AUTH_TOKEN` | Sentry token when `--sentry-token-stdin` is not passed |
| `SENTRY_ORG`, `SENTRY_PROJECT` | Defaults for `--sentry-org` and `--sentry-project` |
| `CLAUDE_CONFIG_DIR` | `--sentry-mcp` reads `$CLAUDE_CONFIG_DIR/.claude.json` when it is set |

`--sentry-mcp <server>` finds the MCP entry the way Claude Code would for the current folder: a project entry of
`~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) for the folder or its nearest parent, then a `.mcp.json` up
the tree, then the user-wide entry. From a `@sentry/mcp-server` entry it takes `--host` or `SENTRY_HOST`,
`--access-token` or `SENTRY_ACCESS_TOKEN` (else `SENTRY_AUTH_TOKEN`), and a private CA from `SENTRY_CA_BUNDLE`,
`NODE_EXTRA_CA_CERTS` or `CURL_CA_BUNDLE`. `${VAR}` and `${VAR:-fallback}` references in the entry are expanded the
way Claude Code expands them. The token stays in memory and is never logged. A Sentry token needs `project:read`,
and downloading a map also needs the organization's debug-file download permission; without it the lookup reports
that the token lacks permission for the project.

## For agents

- **Reading code:** `tools ts skeleton <file>` before you open a file, `--exported --top-level` to orient in a
  folder, `--types` when a signature names a type you do not know. The `cmd` inline token of the markdown skill
  allows `tools ts skeleton` as a read-only command.
- **Machine output:** `skeleton`, `duplicates`, `refactors`, `areas`, `depth` and `imports startup` print the result on stdout in the chosen format and
  their closing line on stderr. `--json` is the readable object form; a parser that wants `cols` and positional rows
  asks for `--json-compact`. Every other group takes `--json`. `imports --json` is always an array of sessions, one
  per entry, each with `timedOut`, `planned` and `unmeasured`.
- **Exit codes:**
  - 0: the command finished.
  - 1: a usage error (an unknown flag, a number out of range, two output formats, an unknown analyser or kind), a
    path with no TypeScript source, an `areas` run that breaks a `--forbid` rule, an `imports startup` run with a
    failed or partial entry, an `imports` entry that resolves to nothing, a `program` check that ran out of
    heap or time, a `sourcemaps resolve` position that stayed unresolved, or a `cache prune` that failed for a
    project.
  - 130: a `sourcemaps` command that can build (`resolve`, `build`, `rank`, `find-commit`, `check`, `carry`)
    stopped with Ctrl-C. Its build worktree is still released.
- **Number flags are checked.** `--similarity 5` used to report zero groups and `--similarity -1` grouped everything,
  and both read like a real answer. Now a value out of range is a one-line usage error (`Must be at most 1.`).
- **Skills:** the repository's `performance` skill (`.claude/skills/performance/`) routes to `profile`
  (`references/profiling.md`) and to `program` (`references/typecheck.md`). The plugin's `chrome-devtools` skill
  routes to `sourcemaps` (`references/sourcemaps.md`, `references/perf-investigation.md`).

## Troubleshooting

Each entry gives the symptom in bold, then the cause, then the fix.

- **`No TypeScript source found`.** The path does not exist, holds no `.ts`, `.tsx`, `.mts` or `.cts` file outside
  the skipped folders, or `--ignore` matched it. Name a source folder, and check the `--ignore` needles.
- **`Pick one output format; got md and json`.** You passed two format flags. Pass one.
- **`A measure worker was killed at --timeout` above the `imports` table.** A module never settled, or the run needs
  longer. Raise `--timeout`, or look for a `hang` row: usually an entry point whose import awaits a prompt, a server
  or a lock.
- **`no tsconfig at <path>`** from `program`. The folder holds no `tsconfig.json` (the default is
  `./tsconfig.json`). Pass the tsconfig or its folder as the argument; `own` takes `--tsconfig <path>`.
- **`node is not on PATH`.** `program` needs node. Install Node.js 22.18 or newer, or pass `--runtime bun`.
- **`the program does not fit in N MiB of heap (out of memory)`.** `--heap` is smaller than the program. Pass a
  larger `--heap`. When you test a reviewer's limit, that failure is the answer.
- **`did not finish in N s and was stopped`.** The check is longer than `--timeout`. Pass a larger `--timeout`.
- **`no typescript/lib/tsc.js resolvable from <dir>`.** `trace` uses the project's own TypeScript only. Install
  `typescript` in the project, or pass `--dir` with an existing trace.
- **`no run wrote a profile (exit …)`.** The entry failed, or it ended on a default SIGINT, SIGTERM or SIGKILL, which
  writes no profile (Bun 1.4.2 and 1.4.3). Read the stderr tail it prints, and let the entry exit normally.
- **`"<entry>" is neither a file nor a tool`.** `profile` found no such file and no `src/<name>/index.ts`. Check the
  path from the current folder.
- **The examples in `tools ts profile --help` read `tools ts profile profile --help ai …`.** The help builds them
  from the argv it was called with (seen 2026-11-09). Drop the repeated `profile --help`:
  `tools ts profile ai --runs 3 -- …`.
- **`--deployed-env reads the deployment: pass --deployed <base-url> or --deployed-dir <dir>`** from
  `sourcemaps build`. `build` reads no deployment and takes neither flag. Run `tools ts sourcemaps env <base-url>`
  and pass the `--env` flags it prints instead.
- **`cache list needs --project <name>`** or **`cache prune needs --project <name> or --all`.** The cache commands
  work on one project. Pass `--project <name>` (the `list` error names the cached projects), or `--all` to prune.
- **`--sentry needs a token`.** `--sentry` has no token. Pipe it with `--sentry-token-stdin`, or set
  `SENTRY_AUTH_TOKEN`.
- **A chunk stays unresolved in `check` or `carry`.** Only the deployment has that code. Report it as unresolved, and
  never guess a nearby file.

More `sourcemaps` traps (an SPA fallback that answers a manifest name with HTML, a CDN without `Last-Modified`, a
stale commit sha in the bundle) are in the guide's "Traps" section.

## Layout

```
src/ts/
├── index.ts                 commander entry (`tools ts`)
├── commands/
│   ├── options.ts           the --format and scan flags, checked number flags, usage errors
│   ├── skeleton.ts  duplicates.ts  refactors.ts  areas.ts  depth.ts  imports.ts  startup.ts  profile.ts
│   │   program.ts  sourcemaps.ts
└── lib/
    ├── collect.ts           walk paths to source files, honouring --tests, --ignore and quoted globs
    ├── load.ts              one read of every file, shared by skeleton/duplicates/refactors
    ├── format.ts            resolve --format and emit text / md / json / json-compact / toon
    ├── skeleton.ts          declarations, fingerprints, body context, local declarations
    ├── signature.ts         parameter types, return type, signature-shape similarity
    ├── type-expand.ts       --types: follow the named types to their declarations
    ├── rank.ts              --rank and --max-tokens: importers, size, recency, budget packing
    ├── duplicates.ts        shingles, MinHash banding, clustering, pattern suppression
    ├── refactors/           one file per analyser, plus the registry
    ├── parse.ts             ast-grep: imports with names, re-exports, module-scope work, scope uses
    ├── graph.ts             resolve + walk, post-order, reachability
    ├── import-index.ts      the whole-tree static import index behind `areas` and `depth`: lines and resolved imports
    ├── areas.ts             files to areas (--split, --depth), the area report, --forbid, the Mermaid flowchart
    ├── depth.ts             interface against code per module, pass-through, importers, the shallow and deep scores
    ├── startup.ts           `imports startup`: entries, the measurement per entry, recurring heavy modules
    ├── measure-worker.ts    the process that imports and times; no repository imports on purpose
    ├── measure.ts           spawns the worker per run and mode, keeps the minimum
    ├── analyze.ts           graph + measure + totals + attribution, into AnalysisResult
    ├── attribute.ts         why a module is slow (native, await, side effects, barrel, subtree, cycle)
    ├── barrels.ts  lazy.ts  cycles.ts
    ├── render.ts            terminal output (box tables from @genesiscz/utils/table)
    ├── profile/             `tools ts profile`: run.ts (bun --cpu-prof, sample), cpuprofile.ts (sums, await
    │                        gaps), threads.ts (sample output), render.ts
    └── program/             `tools ts program`: check-worker.ts (node process, no repository imports), run.ts
                             (spawns it), closure.ts (folder closures, package sizes, duplicate copies, --why),
                             sites.ts (site groups), trace.ts (--generateTrace hot spots)
```

The `sourcemaps` library is `src/utils/ts/sourcemaps/`.

## Limits

- `imports` is Bun only: the worker uses `Bun.resolveSync` and `bun run`, and the numbers are Bun's
  transpile-plus-evaluate cost, not Node's.
- Self time for a package is marginal cost with the rest of the graph warm (see above).
- `require()` inside a function body is treated as dynamic; `require()` at module scope as a static edge.
- Module-scope side effect detection is syntactic. It sees `new Database("x")` at top level; it does not see a
  `Database` constructed inside a function that a top-level statement calls.
- Barrel tracing follows `export * from` six levels deep and stops there.
- `duplicates` and `refactors` are syntactic. They compare declarations as text and shape; they do not resolve
  types, so two helpers with the same signature over different types read as alike.
- `unused-exports` cannot see a consumer outside the scanned paths, a name reached through `export *`, or a name
  reached by a string key. It is evidence, never a verdict.
- `areas` and `depth` read top-level import statements and every `import()` / `require()` call. An import inside a
  `declare module` block is not an edge, and a specifier built at run time (`import(name)`) cannot be resolved.
- `depth` strips comments with a regular expression that keeps string literals; a comment marker inside a regular
  expression literal or a nested template can be misread. The scores rank modules; they are not a gate.
- When `skeleton --rank` and the other static commands walk a directory, they read TypeScript only, not JavaScript.
  A `.js` file named directly is parsed too.

## Related

- [`tools chrome-devtools`](../chrome-devtools/README.md): `intercept --map-dir` shows the maps `sourcemaps carry`
  wrote in DevTools, and the Long Animation Frame entries it captures give the positions `sourcemaps resolve` maps.
- [`tools ai`](../ai/README.md): `tools ai tokens --method claude-api` counts tokens exactly when the skeleton
  estimate is not enough (it needs `ANTHROPIC_API_KEY`).
