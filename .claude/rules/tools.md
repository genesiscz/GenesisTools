---
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
  - "scripts/**/*.ts"
---

# Writing and changing tools

Loaded by Claude Code when you read, write or edit TypeScript under `src/` or `scripts/`: tool structure, shared utilities, logging and output, spawning, ports, databases.

## Key Components

-   **Logger** (`src/logger.ts`): Centralized logging using pino, writes day-stamped files under `~/.genesis-tools/logs/`
-   **MCP Integration**: Several tools implement Model Context Protocol servers for AI assistant integration
-   **No Build Step**: Bun executes TypeScript directly without compilation

## Utility Convention

When creating a new tool and writing helper functions, check if the utility is **general-purpose** (usable by other tools). If so, place it in `src/utils/` instead of inside the tool directory:

**🛑 `src/utils/**` is the `@genesiscz/utils` package and can NEVER import `@app/*`.** That includes every subfolder (`src/utils/claude/`, `src/utils/ai/`, …); there is no exception for a folder named after a tool. If code you are writing under `src/utils/` needs an `@app/<tool>/...` module, that module belongs in `src/utils/**` too: move it there (with its tests) and import it via `@genesiscz/utils/...`. Never solve it by moving YOUR file out to the tool directory, and never by a relative `../../<tool>/` path. `scripts/ci/check-package-boundaries.ts` fails CI on any `@app/*` import under `src/utils/**`; run it before you commit a move.

- `src/utils/format.ts` - Formatting: `formatDuration()`, `formatBytes()`, `formatTokens()`, `formatNumber()`, `formatList()`, `formatTimestamp()`, `createStopwatch()`
- `src/utils/Stopwatch.ts` - High-res stopwatch class: `elapsed()`, `lap()`, `stamp()` (wall-clock + elapsed), `now()` (HH:MM:SS.mmm)
- `src/utils/table.ts` - CLI tables: `formatTable()` (plain padded), **`createBoxTable()` / `renderCliHeader()` / `formatDotStatus()`** (port-style boxed inventories via `cli-table3`)
- `src/utils/string.ts` - String utilities (glob matching, ANSI stripping)
- `src/utils/cli/executor.ts` - CLI helpers: `suggestCommand()`, `isInteractive()`, `buildCommand()`, `Executor`, `enhanceHelp()`
- `src/utils/storage/storage.ts` - Config & cache management
- `src/utils/storage/root.ts` - `toolDataDir(tool, ...)` / `genesisToolsDir(...)`: every `~/.genesis-tools/...` path (honours `GENESIS_TOOLS_HOME`, no logger import); `genesisToolsDirIn(home, ...)` for an explicit sandbox or fixture home. Never hand-join any home with `".genesis-tools"`: lint-rules `no-hand-joined-genesis-tools` fails it outside tests and `plugins/**`
- `src/utils/async.ts` - Async helpers (concurrency, retry, etc.)
- `src/utils/json-schema.ts` - JSON schema inference: `inferSchema()`, `formatSchema(value, "skeleton"|"typescript"|"schema")`
- `src/utils/ai/local/device.ts` - ONNX Runtime device detection: `detectDevice()`, `resolveDevice()` (CoreML/CUDA/DML/CPU)
- `src/utils/audio/converter.ts` - Audio transcode helpers: `convertToWhisperWav()`, `convertFileToMonoMp3()`, `MONO_MP3_BITRATE_KBPS`, `toFloat32Audio()`
- `src/utils/audio/detect-format.ts` - Magic-byte audio sniffing: `detectAudioFormat()`, `sniffAudioExt()`
- `src/utils/cli/quiet-spinner.ts` - No-op spinner for non-TTY (`createQuietSpinner()`); pair with `isQuietOutput()` from `src/utils/cli/output-mode.ts`
- `src/utils/cli/interrupt.ts` - `withInterrupt(fn)`: Ctrl-C as an AbortSignal. Use it instead of `process.once("SIGINT")`: `./tools` and the app launcher forward each Ctrl-C, and a `once` listener lets the second copy kill the process mid-cleanup
- `src/utils/repo-context/` - Repository context gatherers (agent instruction files, owning project + package manager + test runner, test commands) over a caller-supplied reader; `gatherRepoContext()`, `defaultGatherers()`
- `src/utils/ai/evaluation/spend.ts` - All Jev spend from the usage ledger: `jevSpend()`, `jevCalls()` (by feature label, model, day)
- `src/utils/browser-router/router-link.ts` - Every link to a GenesisTools app: `routerLink({ preset, action, data, via?, when?, render?, fallback })` returns `{ result, link, via, error? }`, the link only when it opens on this Mac (router installed, the https handler, preset routed; or the app installed for its scheme) and the fallback with a coded reason otherwise; `schemeLink()` for a link the code opens itself. A new kind of link is a new entry in its `LinkTargets` table, never a URL at a call site: lint-rules `no-raw-genesis-link` fails a `genesis.tools/`, `genesis-md://` or `genesis-tools://` literal anywhere else

Tool-specific logic stays in the tool directory (e.g., `src/har-analyzer/core/`).

**Code in `src/utils/` handles Windows paths** (match separators with `[/\\]`, not `/`). These are shared utilities, so missing Windows support there is a critical review finding.

**A bound belongs where the data is read.** When a command takes `--hours`, `--since`, `--limit` or `--min`, the bound must reach every stage: discovery, refresh, the SQL `WHERE` and hydration. Filtering in JavaScript after loading everything scales with the corpus, not the answer, and the corpora here are large (12 GB of transcripts). Prove it with a fixture test that counts what was parsed.

## Tool Patterns

Most tools follow these common patterns:

**CLI Argument Parsing**:

-   Use `commander` for parsing command-line arguments with subcommands and options
-   **One core, three thin doors.** Business logic lives in `src/<tool>/lib/`. All THREE surfaces are thin adapters that parse input, call lib, and render output: `src/<tool>/commands/*` (CLI), `src/<tool>/lib/server/routes/*` (HTTP) and MCP tool modules. **A behaviour must never exist in a route that the CLI cannot reach**, and vice versa. The rule used to name commands only, which is how the same question came to be answered differently depending on which door you knocked on: the youtube `qa` pipeline stage and `analyze --ask` each indexed and called `qa.ask` inline, skipping the citation enrichment the HTTP route performed.

**Interactive User Experience**:

-   Two prompt libraries available: `@inquirer/prompts` (legacy) and `@clack/prompts` (preferred for new tools)
-   **Prompts go through the `p` facade** (`p.text`, `p.select`, `p.multiselect`, `p.password`, … from `@genesiscz/utils/prompts/p`). Set the backend once at the tool's entry point with `p.setBackend`; never call `inquirerBackend.*` or `clackBackend.*` in tool code, so cancel handling stays the same on both backends.
-   **Non-TTY guard**: Always check `isInteractive()` (from `@genesiscz/utils/cli`) before showing prompts. When non-interactive, either error with `suggestCommand()` showing required CLI flags, or use a sensible default:

    ```typescript
    import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";

    if (!isInteractive()) {
        logger.error("--provider required in non-interactive mode.");
        logger.info(suggestCommand("tools my-tool", { add: ["--provider", "claude"] }));
        return;
    }
    // ... interactive prompt here
    ```

-   **Enumerated flags (closed value set):** If a flag takes a known list (`--detail phases|all`, `--scopes` from `PROFILER_SCOPE_NAMES`), do **not** declare it as `--flag <value>`. Commander then exits with a generic "argument missing" and never lists the values. Declare `--flag [value]` (optional) and handle the empty case yourself:
    - TTY: prompt with the possible values (`p.select` / `p.multiselect`).
    - non-TTY, or an invalid value: print `suggestEnumFlag("tools my-tool", "--flag", VALUES)` from `@genesiscz/utils/cli` (possible values plus a filled `suggestCommand` line), set `process.exitCode = 1`, return. Do not prompt.
    - Reference: `src/config/commands/profiling.ts` (`--scopes`, `--detail`).

**Output Handling**:

-   Support multiple output destinations: file, clipboard, stdout
-   Use `clipboardy` for clipboard operations
-   Use `picocolors` (or `chalk`) for colored terminal output (but strip ANSI codes for non-TTY)
-   Respect `--silent` and `--verbose` flags
-   **Human inventory lists (models, accounts, ports, processes, …):** do **not** dump multi-column data via clack `out.log.info`. Use the port-style table helpers from `@genesiscz/utils/table` + `out.println` — see **CLI inventory tables** below.

**Process Execution**:

-   Use `Bun.spawn()` for executing external commands
-   Handle stdout/stderr streams properly using `new Response(proc.stdout).text()`

**File Operations**:

-   Use Bun's native file APIs (`Bun.write()`) for better performance

## How to Write Tools

See `docs/tool-template.md` for complete templates (@inquirer + @clack/prompts), common patterns, and best practices.

## Performance Benchmarks (2026-03-16, hyperfine, Apple Silicon)

| What | Mean | Notes |
|---|---|---|
| Bun tool invocation (`tools <cmd>`) | **~86ms** | Baseline for any tool |
| `osascript` notification | **~120ms** | Unreliable banners on modern macOS |
| `terminal-notifier` native binary | **~295ms** | Reliable; bypass rbenv shim (adds +120ms) |

When spawning tools from shell hooks, always background (`&`) — 86ms Bun startup is invisible when async.

## Debugging & Logging

- **Triage from logs first.** When any tool misbehaves, the FIRST step is to read `~/.genesis-tools/logs/<today>.log` (and recent days) and `rg` for the tool name / error string — *before* forming hypotheses or reproducing. Logs are day-stamped pino JSON. This bug (`sqlite-vec extension failed to load`) was in the logs for weeks before it was triaged; checking them first collapses hours of guessing into one `rg`.
- **Days older than a week are compressed.** The daily pass (started by the logger once a day, `src/utils/logger/daily-trigger.ts`) stores `<date>.log` and `<date>-profiling.log` older than 7 days as `<name>.zst`. Search one with `rg -z <pattern> <file>.zst` (rg runs the `zstd` CLI) or `tools compress cat <file>.zst | rg <pattern>` (no CLI needed); `rg -z` also reads plain files, so `rg -z <pattern> ~/.genesis-tools/logs/2026-10-0*` covers both. Code that reads day logs goes through `dayLogPath` / `listDayLogs` (`@genesiscz/utils/logger/day-logs`) and the readers in `@genesiscz/utils/fs/read-lines`, which open either form; never build `<date>.log` by hand. Details: `.claude/rules/compress.md`.
- **Profiling lines live in their own file:** `~/.genesis-tools/logs/<date>-profiling.log` (e.g. `2026-09-03-profiling.log`), one `[profile:<scope>] <label> <ms>` line per measurement plus a `── <title> ──` summary table per scope. Enable per run with `PROFILE=1`, `PROFILE=*` or `PROFILE=<scope,scope>` (scope names in `src/utils/profile/scopes.ts`); an env `PROFILE` also echoes to stderr, `PROFILE_TO_STDERR=0` silences that. Persistent profiling comes from `tools config profiling`.
- **To ADD a measurement, use the shared profiler, never a hand-rolled `performance.now()` pair.** `import { profiler } from "@genesiscz/utils/profile"`, then one module-level `const prof = profiler.scope("<scope>")` (see `src/du/lib/engine.ts:21`). Verbs: `prof.measure(label, fn)` / `prof.measureAsync(label, fn)` wrap a call, `prof.start(label)` returns a stop function, `prof.section(label)` works with `using`, `prof.mark(label)` records a point in time, `prof.summary(title)` prints the table at the end. A disabled scope is a no-op, so a timer may sit in a hot path; put only work you would not otherwise do behind `prof.enabled`, and hide per-file or per-item timers behind `profiler.detail === "all"` so `--detail phases` stays readable. **A new scope name must be added to `PROFILER_SCOPE_NAMES` in `src/utils/profile/scopes.ts`**, or `--scopes` cannot offer it and `PROFILE=<name>` is a guess.
- **Log enough to triage from logs alone.** Every tool must emit enough via `@genesiscz/utils/logger` that a future reader can reconstruct what happened without re-running it: log key decision branches, every external-resource access (DB opens with their paths, spawned commands, API URLs), mode/config resolution, and result counts.
- **Never swallow errors.** A bare `catch {}` is forbidden. At minimum `logger.debug` (or `.warn`) the caught error with context. A swallowed error is a future debugging session that did not have to happen.

- **Day-log lines from before 2026-10-12 include test output**: until #490 every `bun test` process wrote into the real day log. Before fixing a logged error from then, check whether its pid also logged a `gt-test-tmp` path or a `*.test.ts:<line>` frame that day; if so it is a fixture.

## Logging & output

Two cleanly separated layers (the 2026-05 logger+out overhaul):

- **`logger` — diagnostics.** `import { logger } from "@genesiscz/utils/logger"` (named only; there is **no** default export and no `consoleLog` — they were removed). Writes to the day-stamped file **always** (debug+), and to the console **on stderr**, gated by level. `logger.*` is **never** the result channel. Global `-v` promotes file-only `logger.debug` to the console; `-vv` → trace (only on tools that opted into `--trace`).
- **`out` — user-facing.** `import { out } from "@genesiscz/utils/logger"` (or `const { log, out } = logger.scoped("comp")`). clack-shaped. **`out.result(data)` / `out.print(raw)` are the ONLY writers to stdout** (the machine result). `out.log.*` / spinners / notes / prompts → stderr. Never emit a serialized result via `logger.*` — that is `out.result()`'s job (CI guard enforces this).
- **`const { log, out } = logger.scoped("comp")`:** `log.*` = logger-only (diagnostics); `log.out.*` / `log.tee.*` = both (component-tagged single mirror); destructured `out.*` = only-out (no logger mirror).
- **Every commander entrypoint** ends with `await runTool(program, { tool })` (from `@genesiscz/utils/cli`) — it owns `-v`/`--readme`/help registration, console-level resolution, and the `{tool}` log binding, then `parseAsync`. The subprocess **spawner** is `execTool` (renamed from the old `runTool`).
- **`scripts/ci/logging-guard.sh`** enforces this convention repo-wide in CI: no default/extension/relative-path/any-name import of the logger module (root `./tools` and `scripts/` included — not just `src/`), no bare `logger.*(SafeJSON.stringify(…))` result dumps, no reintroduced transitional shims, and that the browser-client isolation test exists. Browser-client trees never value-importing `@genesiscz/utils/logger` is authoritatively enforced by `src/logger/client-isolation.test.ts`.
- **`@genesiscz/utils/cli/ui` — high-density CLI status.** For tools that emit many short status lines per command (e.g. `tools stash`), clack's `│ ◆ ●` box-drawing is the wrong texture. Import `{ ui }` from `@genesiscz/utils/cli/ui` to get plain stderr writes with chalk decoration (`ui.ok/info/warn/err/dim/header/kv/section/raw`). Use this INSTEAD of `out.log.*` for high-density status; keep `out.log.*` for clack-shaped task lifecycles. `out.print()` / `out.result()` are still the only writers to stdout for machine-readable output.
- **CLI inventory tables (port-style) — prefer this for multi-column human output.** Canonical helpers live in `@genesiscz/utils/table` (not reimplemented per tool). Reference UIs: `tools port`, `tools ai-proxy models`, `tools macos swap`.

  | Need | API | Notes |
  |---|---|---|
  | Boxed inventory table | `createBoxTable(headers)` | `cli-table3` + shared box chars; `table.push(row)` then `out.println(table.toString())` |
  | Title box | `renderCliHeader(title, subtitle)` | Cyan frame via `out.println` |
  | Section + key rows | `renderCliSection` / `renderCliKeyRow` | Column legends, detail blocks |
  | Status cell | `formatDotStatus("ok"\|"warn"\|"err"\|"dim", label)` | `● ok` / `● fail` coloring |
  | Cell truncate | `truncateDisplay(value, max)` | Em dash for empty; `…` ellipsis |
  | Plain padded table | `formatTable(rows, headers)` | Dense / non-TTY dumps without box borders |
  | Machine-readable | `out.result(...)` + `--json` | Never put JSON through the table path |

  Pattern:

  ```typescript
  import { out } from "@genesiscz/utils/logger";
  import { suggestCommand } from "@genesiscz/utils/cli";
  import { createBoxTable, formatDotStatus, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";
  import pc from "picocolors";

  renderCliHeader("Proxy Models", "ids clients can call");
  const table = createBoxTable(["PROXY ID", "PROBE"]);
  table.push([pc.white(id), formatDotStatus("ok", "ok")]);
  out.println(table.toString());
  renderCliSection("Columns");
  // footer: counts · Next/Debug via suggestCommand("tools <tool>", { replaceCommand: [...] })
  ```

  **Do not** hand-roll `new Table({ chars: … })` or copy/paste box-drawing from `src/port/` — import from `@genesiscz/utils/table`. Keep domain coloring (framework names, etc.) in the tool's `display.ts`; keep the table chrome shared.

## Spawning a tool vs calling its library

Audited 2026-09-19 across the whole repo: 32 places start a GenesisTools entry point as a child
process. 28 are correct, 3 were not, and the 32nd is a launcher inconsistency in the interactive
picker rather than a spawn-or-call question. So the default is NOT "a spawn is waste" — but the
three that were wrong each had an exported function one import away, and one was a live bug.

**Spawn when:**

1. **The target's IDENTITY matters, not just its code.** Anything touching a TCC-gated resource
   (Calendar, Contacts, Accessibility, Full Disk Access, notifications) must go through the same
   `genesisAppLauncher()` path `tools <name>` uses, so macOS attributes the grant to
   GenesisTools.app. An in-process call inherits the CALLER's TCC identity, which turns a working
   permission into an empty result with no error.
2. **The command name is not known until runtime** — automate's presets, jev's routed commands,
   the Telegram `/tools` bridge. There is no fixed function to import because the target is not
   fixed.
3. **The work must outlive the caller, or the caller must not wait on it** — detached speech,
   daemonised servers, `--detach`, launchd jobs, `tools task run`'s worker.
4. **A crash in the target must not take the caller down**, especially when it runs user-authored
   content or is driven by an external actor.

**Do NOT spawn when the target is your own tool's code, reachable through an exported function,
and none of the above applies.** The tell is a spawn aimed at `src/<same-tool>/...` or at a small
pure-function module. All three real offenders looked like that: `tools json` for a string
transform, an MCP server bootstrapping its own transport, and `claude history` re-entering its
own CLI to reach `summarize`.

🛑 **Never `Bun.spawn(["tools", ...])` directly.** Bare `tools` resolves off `$PATH` to the
**main checkout**, so a worktree silently runs the main branch's code — the exact trap in
[[reference_tools_path_runs_main_repo]]. Use `execTool` / `execToolInteractive` from
`@genesiscz/utils/cli`: they resolve the binary worktree-safely and route through the real
wrapper, and therefore through the launcher.

## Web servers & ports

- Canonical registry: `src/utils/ui/dashboards.ts` — `DASHBOARDS` (browser UIs, consumed by DashboardApp launchers) + `WEB_SERVICES` (http-api/extension/proxy listeners); ports must be unique across both.
- Never hardcode a port for a repo web server — look it up there (`registryEntryForPort()`; e.g. dev-dashboard 3042, log viewer 7243).

## Database & Migrations

- Per-tool config/cache dirs: `src/utils/storage/storage.ts` → `~/.genesis-tools/<tool>/`; system SQLite (Mail, Messages) read-only via `src/utils/macos/MacDatabase.ts`.
- Migrations: `src/utils/database/migrations.ts` (`Migration`, `runMigrations()`, `Migrator`); applied IDs persist in `_migrations`; indexer applies `INDEXER_MIGRATIONS` on read-write opens.
- DB test pattern: in-memory `new Database(":memory:")` in `*.test.ts` beside source. Full map: `.claude/rules/database.md`.
