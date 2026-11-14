---
paths:
  - "src/*/commands/**"
  - "src/*/index.ts"
  - "src/*/index.tsx"
  - "src/*/cli.ts"
  - "src/**/*-cli.ts"
  - "src/**/display.ts"
  - "src/**/render*.ts"
  - "src/utils/logger/**"
  - "src/utils/cli/**"
  - "src/utils/profile/**"
  - "src/utils/table.ts"
  - "scripts/**/*.ts"
---

# Logging, console output and CLI tables

Covers the `logger` and `out` layers, `runTool`, the high-density `ui` status, CLI inventory tables, output destinations, the day logs and the profiler. The core rules also stand in `.claude/rules/tools.md`.

The logger (`src/utils/logger/`, pino) writes day-stamped files under `~/.genesis-tools/logs/`.

## Logging & output

Two cleanly separated layers (the 2026-05 logger+out overhaul):

- **`logger` — diagnostics.** `import { logger } from "@genesiscz/utils/logger"` (named only; there is **no** default export and no `consoleLog` — they were removed). Writes to the day-stamped file **always** (debug+), and to the console **on stderr**, gated by level. `logger.*` is **never** the result channel. Global `-v` promotes file-only `logger.debug` to the console; `-vv` → trace (only on tools that opted into `--trace`).
- **`out` — user-facing.** `import { out } from "@genesiscz/utils/logger"` (or `const { log, out } = logger.scoped("comp")`). clack-shaped. **`out.result(data)` / `out.print(raw)` are the ONLY writers to stdout** (the machine result). `out.log.*` / spinners / notes / prompts → stderr. Never emit a serialized result via `logger.*` — that is `out.result()`'s job (CI guard enforces this).
- **`const { log, out } = logger.scoped("comp")`:** `log.*` = logger-only (diagnostics); `log.out.*` / `log.tee.*` = both (component-tagged single mirror); destructured `out.*` = only-out (no logger mirror).
- **Every commander entrypoint** ends with `await runTool(program, { tool })` (from `@genesiscz/utils/cli`) — it owns `-v`/`--readme`/help registration, console-level resolution, and the `{tool}` log binding, then `parseAsync`. It also records each failed run into the failures log (`src/utils/cli/failures/`); an entry point without commander calls `watchToolRun({ tool })` itself and `noteUsageError(message)` when its own parser refuses the command line. The subprocess **spawner** is `execTool` (renamed from the old `runTool`).
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

## Output destinations

-   Support multiple output destinations: file, clipboard, stdout
-   Use `clipboardy` for clipboard operations
-   Use `picocolors` (or `chalk`) for colored terminal output (but strip ANSI codes for non-TTY)
-   Respect `--silent` and `--verbose` flags
-   **Human inventory lists (models, accounts, ports, processes, …):** do **not** dump multi-column data via clack `out.log.info`. Use the port-style table helpers from `@genesiscz/utils/table` + `out.println` — see **CLI inventory tables** below.
-   A non-TTY spinner is `createQuietSpinner()` (`src/utils/cli/quiet-spinner.ts`); pair it with `isQuietOutput()` from `src/utils/cli/output-mode.ts`.
## Debugging & Logging

- **Triage from logs first.** When any tool misbehaves, the FIRST step is to read `~/.genesis-tools/logs/<today>.log` (and recent days) and `rg` for the tool name / error string — *before* forming hypotheses or reproducing. Logs are day-stamped pino JSON. This bug (`sqlite-vec extension failed to load`) was in the logs for weeks before it was triaged; checking them first collapses hours of guessing into one `rg`. `tools genesis-tools logs failures` lists the failed runs (each with its stderr tail and caller), `logs day --level warn --tool <name>` filters the day log through rg, and `logs profile` lists slow timers.
- **Only today and yesterday stay plain.** The daily pass (started by the logger once a day, `src/utils/logger/daily-trigger.ts`) stores every older `<date>.log`, `<date>-profiling.log` and `<date>-failures.jsonl` as `<name>.zst`. Read an older day with `tools genesis-tools logs day|failures|profile --since <when>` (they open either form), `tools compress cat <plain name> | rg <pattern>` (the plain name finds the `.zst`; no CLI needed), or `rg -z <pattern> <file>.zst` (rg runs the `zstd` CLI); `rg -z` also reads plain files, so `rg -z <pattern> ~/.genesis-tools/logs/2026-10-0*` covers both. Code that reads a day file goes through `dayLogPath` / `listDayLogs` (`@genesiscz/utils/logger/day-logs`, kind `log`, `profiling` or `failures`), the readers in `@genesiscz/utils/fs/read-lines` (`readLinesSync`, `readLastLines`) and `ripgrepFiles` (`@genesiscz/utils/compress/search`), which open either form; never build `<date>.log` by hand. Details: `.claude/rules/compress.md`.
- **Profiling lines live in their own file:** `~/.genesis-tools/logs/<date>-profiling.log` (e.g. `2026-09-03-profiling.log`; `.zst` after yesterday, `tools genesis-tools logs profile` reads both), one `[profile:<scope>] <label> <ms>` line per measurement plus a `── <title> ──` summary table per scope. Enable per run with `PROFILE=1`, `PROFILE=*` or `PROFILE=<scope,scope>` (scope names in `src/utils/profile/scopes.ts`); an env `PROFILE` also echoes to stderr, `PROFILE_TO_STDERR=0` silences that. Persistent profiling comes from `tools config profiling`.
- **To ADD a measurement, use the shared profiler, never a hand-rolled `performance.now()` pair.** `import { profiler } from "@genesiscz/utils/profile"`, then one module-level `const prof = profiler.scope("<scope>")` (see `src/du/lib/engine.ts:21`). Verbs: `prof.measure(label, fn)` / `prof.measureAsync(label, fn)` wrap a call, `prof.start(label)` returns a stop function, `prof.section(label)` works with `using`, `prof.mark(label)` records a point in time, `prof.summary(title)` prints the table at the end. A disabled scope is a no-op, so a timer may sit in a hot path; put only work you would not otherwise do behind `prof.enabled`, and hide per-file or per-item timers behind `profiler.detail === "all"` so `--detail phases` stays readable. **A new scope name must be added to `PROFILER_SCOPE_NAMES` in `src/utils/profile/scopes.ts`**, or `--scopes` cannot offer it and `PROFILE=<name>` is a guess.
- **Log enough to triage from logs alone.** Every tool must emit enough via `@genesiscz/utils/logger` that a future reader can reconstruct what happened without re-running it: log key decision branches, every external-resource access (DB opens with their paths, spawned commands, API URLs), mode/config resolution, and result counts.
- **Never swallow errors.** A bare `catch {}` is forbidden. At minimum `logger.debug` (or `.warn`) the caught error with context. A swallowed error is a future debugging session that did not have to happen.

- **Day-log lines from before 2026-10-12 include test output**: until #490 every `bun test` process wrote into the real day log. Before fixing a logged error from then, check whether its pid also logged a `gt-test-tmp` path or a `*.test.ts:<line>` frame that day (`tools compress cat ~/.genesis-tools/logs/<date>.log | rg <pid>`: those days are `.zst`); if so it is a fixture.
