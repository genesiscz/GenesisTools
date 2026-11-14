---
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
  - "scripts/**/*.ts"
---

# Writing and changing tools

Loaded by Claude Code when you read, write or edit TypeScript under `src/` or `scripts/`: tool structure, shared utilities, logging and output, spawning, ports, databases.

## Utility Convention

Whenever you write a helper, in a new tool or in a change to an existing one, ask whether another tool could use it. If so, it goes in `src/utils/`, not in `src/<tool>/`. The tells: it parses a format another tool also reads (a transcript, a git output, a config file), it wraps a CLI or an OS service, or a second tool already has a private copy (`tools ts refactors <paths> --include shadowed` lists those). A transcript fact is a provider reader member: `.claude/rules/agent-transcripts.md`.

**🛑 `src/utils/**` is the `@genesiscz/utils` package and can NEVER import `@app/*`.** That includes every subfolder (`src/utils/claude/`, `src/utils/ai/`, …); there is no exception for a folder named after a tool. If code you are writing under `src/utils/` needs an `@app/<tool>/...` module, that module belongs in `src/utils/**` too: move it there (with its tests) and import it via `@genesiscz/utils/...`. Never solve it by moving YOUR file out to the tool directory, and never by a relative `../../<tool>/` path. `scripts/ci/check-package-boundaries.ts` fails CI on any `@app/*` import under `src/utils/**`; run it before you commit a move.

Rules from the shared utilities (the rest of the catalog: `tools ts skeleton src/utils --exported --top-level`):

- A module's folder is `moduleDir(import.meta)`, a lazy load beside it `requireSibling(import.meta, name)` (`src/utils/fs/module-dir.ts`). Bun-only `import.meta.dir`/`.dirname` and a bare `require()` break every Vite dashboard that loads the module; lint-rules `no-bun-only-import-meta` and `no-bare-require-in-utils` fail them.
- Every `~/.genesis-tools/...` path comes from `toolDataDir(tool, ...)` / `genesisToolsDir(...)` (`src/utils/storage/root.ts`, honours `GENESIS_TOOLS_HOME`), or `genesisToolsDirIn(home, ...)` for a sandbox or fixture home. Never hand-join any home with `".genesis-tools"`: lint-rules `no-hand-joined-genesis-tools` fails it outside tests and `plugins/**`.
- Ctrl-C is `withInterrupt(fn)` (`src/utils/cli/interrupt.ts`), never `process.once("SIGINT")`: `./tools` and the app launcher forward each Ctrl-C, and a `once` listener lets the second copy kill the process mid-cleanup.
- A tool that deletes user files or caches goes through `src/utils/rm/` (`planRemoval()`, `moveToTrash()`), never `rmSync`; `tools doctor` uses `removeForDoctor()` (`src/doctor/lib/remove.ts`). In a test process the trash refuses any path outside the test's temp folder.
- A new MCP tool group is one row in `TOOL_GROUPS` (`src/genesis-tools-mcp/lib/groups.ts`) and one `src/<tool>/mcp/genesis-tools.ts` that exports `toolGroup()` (`src/utils/mcp/`).
- A util never writes `tools …` or calls `toolCommand()` itself: it imports the command's function from `src/utils/genesis-tools/tools/` (`ai.ts`, `system.ts`, `services.ts`; `suggest.ts` only in a util that already loads the executor), and a new command is a new function there. lint-rules `no-tool-command-in-utils` fails it outside that folder. A copy of `src/utils` in another repository edits only that folder.
- A link to a GenesisTools app comes from `routerLink()`, a new kind of link is a new `LinkTargets` entry: `.claude/rules/genesis-links.md`.

Tool-specific logic stays in the tool directory (e.g., `src/har-analyzer/core/`).

**Code in `src/utils/` handles Windows paths** (match separators with `[/\\]`, not `/`). These are shared utilities, so missing Windows support there is a critical review finding.

**A bound belongs where the data is read.** When a command takes `--hours`, `--since`, `--limit` or `--min`, the bound must reach every stage: discovery, refresh, the SQL `WHERE` and hydration. Filtering in JavaScript after loading everything scales with the corpus, not the answer, and the corpora here are large (12 GB of transcripts). Prove it with a fixture test that counts what was parsed.

## Tool Patterns

Most tools follow these common patterns:

**CLI Argument Parsing**:

-   Use `commander` for parsing command-line arguments with subcommands and options
-   **One core, three thin doors.** Business logic lives in `src/<tool>/lib/`. All THREE surfaces are thin adapters that parse input, call lib, and render output: `src/<tool>/commands/*` (CLI), `src/<tool>/lib/server/routes/*` (HTTP) and MCP tool modules. **A behaviour must never exist in a route that the CLI cannot reach**, and vice versa. The rule used to name commands only, which is how the same question came to be answered differently depending on which door you knocked on: the youtube `qa` pipeline stage and `analyze --ask` each indexed and called `qa.ask` inline, skipping the citation enrichment the HTTP route performed.

**Interactive User Experience**:

-   `@inquirer/prompts` and `@clack/prompts` are the two prompt backends behind the `p` facade (next item). New tool code imports neither of them directly.
-   **Prompts go through the `p` facade** (`p.text`, `p.select`, `p.multiselect`, `p.password`, … from `@genesiscz/utils/prompts/p`). Set the backend once at the tool's entry point with `p.setBackend`; never call `inquirerBackend.*` or `clackBackend.*` in tool code, so cancel handling stays the same on both backends. A cancel (Escape, Ctrl-C) ends the process with code 0 by default; a call whose caller handles the cancel passes `cancel: "back"` and gets the cancel symbol back (`if (p.isCancel(answer)) { … }`). Lint `no-raw-clack-import` refuses `@clack/prompts` outside `src/utils/prompts/`; a clack function the facade lacks becomes a pass-through there. Tests answer a cancel with `CANCEL_ANSWER` from `p/__tests__/test-backend.ts`.
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

**Output Handling**: multiple destinations, colors, `--silent` / `--verbose`, and human inventory lists (never multi-column data through `out.log.info`): `.claude/rules/logging.md`.

**Process Execution**:

-   **`Executor.exec` always has a deadline**: the call's `timeout`, else the Executor's, else
    `DEFAULT_EXEC_TIMEOUT_MS` (60 s). On expiry the process group is killed, the call throws and a `deadline`
    record goes into the failures log. A command that can run longer by design (a clone, a fetch, a rebase, a build)
    says why: `timeout: { ms: 600_000, reason: "a fetch of every branch" }`; `{ ms: 0, reason }` is no deadline.
    `scripts/ci/exec-deadline-ratchet.ts` lists the calls that still run on the default (lint `no-exec-without-deadline`);
    a call leaves it only when it really needs its own bound.
-   Use `Bun.spawn()` for executing external commands
-   Handle stdout/stderr streams properly using `new Response(proc.stdout).text()`
-   Write files with Bun's native file APIs (`Bun.write()`).

## How to Write Tools

See `docs/tool-template.md` for complete templates, common patterns, and best practices. Its prompt imports are older than the `p` facade: new code imports `p` from `@genesiscz/utils/prompts/p`, never from `@clack/prompts` (lint `no-raw-clack-import`).

## Logging & output (core)

Read `.claude/rules/logging.md` before you add or change console output, a log line, a table, a profiler timer, or code that reads the day logs. It loads by itself with `commands/`, entry points, `src/utils/logger/`, `src/utils/cli/`, `src/utils/table.ts` and `scripts/`.

- **`logger` is diagnostics, `out` is user-facing.** `import { logger, out } from "@genesiscz/utils/logger"` (named only). `logger.*` writes the day file always and stderr by level, and is **never** the result channel.
- **`out.result(data)` / `out.print(raw)` are the ONLY writers to stdout.** Never emit a serialized result via `logger.*` (`scripts/ci/logging-guard.sh` enforces it).
- **Every commander entrypoint ends with `await runTool(program, { tool })`** (`@genesiscz/utils/cli`); the subprocess spawner is `execTool`. A tool with several command trees passes them as `registrars` (a `LazyRegistrar[]` table, `src/utils/cli/lazy-registrars.ts`; `src/codex/registrars.ts` is the model), so `tools <tool> <command>` imports only that command's tree. Bare `--help` and an unknown name still register every tree.
- **Triage from logs first, and log enough to triage from logs alone.** Read `~/.genesis-tools/logs/<today>.log` (or `tools genesis-tools logs failures`) before any hypothesis. Code that reads a day file goes through `dayLogPath` / `listDayLogs` and the readers that open `.zst` too; never build `<date>.log` by hand.
- **Never swallow errors.** A bare `catch {}` is forbidden; at minimum `logger.debug` (or `.warn`) the caught error with context. A new timer is `profiler.scope("<scope>")` from `@genesiscz/utils/profile`, never a hand-rolled `performance.now()` pair, and a new scope name goes into `PROFILER_SCOPE_NAMES`.

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

From a shell hook, start `tools` in the background (`&`): Bun's start costs about 86 ms (hyperfine, 2026-03-16), invisible when async.

## Web servers & ports

- Canonical registry: `src/utils/ui/dashboards.ts` — `DASHBOARDS` (browser UIs, consumed by DashboardApp launchers) + `WEB_SERVICES` (http-api/extension/proxy listeners); ports must be unique across both.
- Never hardcode a port for a repo web server — look it up there (`registryEntryForPort()`; e.g. dev-dashboard 3042, log viewer 7243).

## Database & Migrations

- Per-tool config/cache dirs: `src/utils/storage/storage.ts` → `~/.genesis-tools/<tool>/`; system SQLite (Mail, Messages) read-only via `src/utils/macos/MacDatabase.ts`.
- Migrations: `src/utils/database/migrations.ts` (`Migration`, `runMigrations()`, `Migrator`); applied IDs persist in `_migrations`; indexer applies `INDEXER_MIGRATIONS` on read-write opens.
- DB test pattern: in-memory `new Database(":memory:")` in `*.test.ts` beside source. Full map: `.claude/rules/database.md`.
