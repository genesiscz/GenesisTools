# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

### Running Tools

```bash
# List all available tools interactively
tools

# Run a specific tool
tools <tool-name> [args]

# View a tool's README documentation
tools <tool-name> --readme
```

### `tools say` — config v2 with per-app profiles

`tools say` loads voice / volume / provider / model / language / format from a per-app profile (`--app <name>`), inheriting unset fields from a `default` profile. Notable rules:

- `--save` persists explicitly-passed flags to `--app`'s profile (requires `--app`; in TTY without it, prompts; in non-TTY, errors).
- `--save` with no message text is a save-only invocation (does not speak, does not enter interactive mode).
- `--mute` / `--unmute` require `--save` to persist (breaking change vs. older builds — they are no longer standalone state-write commands).
- `--unset <fields>` (comma-separated): without `--save`, ignores those fields for this run; with `--save`, deletes the keys from the saved profile.
- Run `tools say config` for an interactive profile manager.
- Config lives at `~/.genesis-tools/say/config.json`; old v1 configs are auto-migrated and the original is backed up once to `config.v1.bak.json`.

So when you write the end-of-task notification, you can typically rely on a saved `claude` profile and just call `tools say "<xxx> done" --app claude` — voice etc. come from the profile.

### Running Tests

**Use `bun run test` (or `bun scripts/test.ts <paths>`), never bare `bun test`.** The wrapper stat-checks the dependency tree first (~1ms) and reinstalls when it is missing, partial or stale, then hands off to `bun test` with argv, output and exit code untouched.

This exists because inside a **git worktree** any `bunx` call creates a partial `node_modules/` that shadows the parent checkout's complete one. Bare `bun test` then fails across a hundred unrelated files with errors like `Cannot find module 'parse5/lib/common/doctype'`, which looks exactly like the branch broke the world. Logic lives in `scripts/test-deps.ts` (`diagnose()` / `lockStamp()`), covered by `scripts/test-deps.test.ts`.

### 🛑 Hard rules for agents working in an isolated worktree

Every teammate/subagent given its own worktree MUST, before ANY other work:

1. **Verify the base commit.** Isolated worktrees are often cut from `origin/master`, NOT the campaign/feature branch you were briefed on. Run `git log --oneline -1`; if the briefed base commit is not an ancestor, `git fetch origin <branch> && git reset --hard <base-sha>`. Building on the wrong base silently invalidates every anchor in your brief.
2. **Run `bun install` in the worktree.** A worktree without its own `node_modules` resolves imports against the MAIN repo's dependency tree and fabricates failures that look like "the branch broke the world" (verified repeatedly; see also Running Tests below).
3. **Never bare `bun test`** — always `bun run test` (the wrapper repairs the dependency tree first).

Skipping any of these has cost real sessions hours; there are no exceptions.

### Installation & Setup

```bash
# Initial setup (requires Bun)
bun install && ./install.sh
source ~/.zshrc  # or ~/.bashrc

# The install script adds GenesisTools to PATH by modifying shell config files
```

## Architecture Overview

GenesisTools is a TypeScript-based CLI toolkit that runs on Bun. The architecture follows a plugin pattern where each tool is self-contained:

### Core Structure

-   **Entry Point**: The `tools` executable is a TypeScript file with a shebang that:
  -   Without arguments: Shows an interactive tool selector using @inquirer/prompts
  -   With arguments: Executes the specified tool by running `bun run` on the appropriate file
-   **Tool Discovery**: Tools are discovered by checking `/src/` for:
  -   Directories containing `index.ts` or `index.tsx` (tool name = directory name)
  -   Standalone `.ts` or `.tsx` files (tool name = filename without extension)
-   **Execution Model**: Each tool runs in its own process via `bun run`, inheriting stdio for seamless interaction

### Key Components

-   **Logger** (`src/logger.ts`): Centralized logging using pino, writes day-stamped files under `~/.genesis-tools/logs/`
-   **MCP Integration**: Several tools implement Model Context Protocol servers for AI assistant integration
-   **No Build Step**: Bun executes TypeScript directly without compilation

### Performance Benchmarks (2026-03-16, hyperfine, Apple Silicon)

| What | Mean | Notes |
|---|---|---|
| Bun tool invocation (`tools <cmd>`) | **~86ms** | Baseline for any tool |
| `osascript` notification | **~120ms** | Unreliable banners on modern macOS |
| `terminal-notifier` native binary | **~295ms** | Reliable; bypass rbenv shim (adds +120ms) |

When spawning tools from shell hooks, always background (`&`) — 86ms Bun startup is invisible when async.

### Environment variables

Never read `process.env` directly in application code — use `import { env } from "@genesiscz/utils/env"`. Values: `env.getXAIApiKey()` or `env.x.getApiKey()`; resolved key names (for config metadata): `env.getXAIApiEnvKey()` or `env.x.getApiEnvKey()`. Grouped domains: `env.tools`, `env.ai.*`, `env.github`, `env.log`, `env.paths`, `env.device`, `env.test`, etc. Tests that need overrides: `env.testing.set()` / `env.testing.withOverrides()`.

### Utility Convention

When creating a new tool and writing helper functions, check if the utility is **general-purpose** (usable by other tools). If so, place it in `src/utils/` instead of inside the tool directory:

- `src/utils/format.ts` - Formatting: `formatDuration()`, `formatBytes()`, `formatTokens()`, `formatNumber()`, `formatList()`, `formatTimestamp()`, `createStopwatch()`
- `src/utils/Stopwatch.ts` - High-res stopwatch class: `elapsed()`, `lap()`, `stamp()` (wall-clock + elapsed), `now()` (HH:MM:SS.mmm)
- `src/utils/table.ts` - CLI tables: `formatTable()` (plain padded), **`createBoxTable()` / `renderCliHeader()` / `formatDotStatus()`** (port-style boxed inventories via `cli-table3`)
- `src/utils/string.ts` - String utilities (glob matching, ANSI stripping)
- `src/utils/cli/executor.ts` - CLI helpers: `suggestCommand()`, `isInteractive()`, `buildCommand()`, `Executor`, `enhanceHelp()`
- `src/utils/storage/storage.ts` - Config & cache management
- `src/utils/async.ts` - Async helpers (concurrency, retry, etc.)
- `src/utils/json-schema.ts` - JSON schema inference: `inferSchema()`, `formatSchema(value, "skeleton"|"typescript"|"schema")`
- `src/utils/ai/local/device.ts` - ONNX Runtime device detection: `detectDevice()`, `resolveDevice()` (CoreML/CUDA/DML/CPU)
- `src/utils/audio/converter.ts` - Audio transcode helpers: `convertToWhisperWav()`, `convertFileToMonoMp3()`, `MONO_MP3_BITRATE_KBPS`, `toFloat32Audio()`
- `src/utils/audio/detect-format.ts` - Magic-byte audio sniffing: `detectAudioFormat()`, `sniffAudioExt()`
- `src/utils/cli/quiet-spinner.ts` - No-op spinner for non-TTY (`createQuietSpinner()`); pair with `isQuietOutput()` from `src/utils/cli/output-mode.ts`

Tool-specific logic stays in the tool directory (e.g., `src/har-analyzer/core/`).

### Tool Patterns

Most tools follow these common patterns:

**CLI Argument Parsing**:

-   Use `commander` for parsing command-line arguments with subcommands and options
-   **One core, three thin doors.** Business logic lives in `src/<tool>/lib/`. All THREE surfaces are thin adapters that parse input, call lib, and render output: `src/<tool>/commands/*` (CLI), `src/<tool>/lib/server/routes/*` (HTTP) and MCP tool modules. **A behaviour must never exist in a route that the CLI cannot reach**, and vice versa. The rule used to name commands only, which is how the same question came to be answered differently depending on which door you knocked on: the youtube `qa` pipeline stage and `analyze --ask` each indexed and called `qa.ask` inline, skipping the citation enrichment the HTTP route performed.

**Interactive User Experience**:

-   Two prompt libraries available: `@inquirer/prompts` (legacy) and `@clack/prompts` (preferred for new tools)
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

## Building or Restyling Web UI

**Before writing or restyling ANY web UI** (`src/<tool>/ui`, `src/dashboard`, `src/dev-dashboard/ui`), read `docs/design-system.md`. It is the single shared-UI contract: theme tokens + `@ui/components/*` primitives + `wow-components.css` looks. Hard rules: no raw `zinc-*`/`white/NN` palette in app code (use theme tokens), never override a `<Card>`'s surface, pick a rich Button/Card variant on purpose, wrap routes in the shared shell/auth-layout. This doc exists because clarity & shops drifted "flat" by ignoring it while the dashboard didn't — don't repeat that. For per-dashboard design lineage (all 8 dashboards categorized into design families; why youtube/dev-dashboard diverge) see `docs/design-system-dashboards.md`; for the canonical ports/launch registry + conflict detection see `src/utils/ui/dashboards.ts`.

## Working on `tools du` (`src/du/`)

**Before touching ANYTHING under `src/du/`, read `docs/benchmarks-du.md`, and append a new dated section to it for every feature you add.** The native core (`src/du/native/clonesize.c`) is syscall-bound and runs in the hot loop of multi-million-file scans, so an unmeasured feature is a silent regression. Measure with `src/du/native/bench.sh <label>` (fixed target matrix + hyperfine), record system CPU time as the primary metric (wall time on this machine swings with load average — always note `uptime`), and diff the `--json` byte totals. **Identical totals are required only when the change is meant to preserve scan semantics** (refactors, performance work, validation hardening). Features that deliberately change what is counted — `--changed-within` filtering, cloud-boundary pruning, allocation-vs-mapped reporting — must instead state which totals move, by how much, and why. Unexplained movement is a bug either way.

## Code Style: Biome formatting gotchas (write it right the first time)

- **Imports are auto-sorted by module specifier** (`bun:` / `node:` builtins first, then packages and `@genesiscz/...` aliases alphabetically), and named imports inside braces are sorted case-insensitively — write them pre-sorted or the hook churns your diff.
- **Line width is 120, 4-space indent.** Don't hand-wrap below that; biome unwraps your "pretty" 3-line call back onto one line.
- **Long call: biome keeps args inline and expands only the trailing object/array** (`fn(a, b, {\n ... \n})`), not one-arg-per-line.
- **Long `if`: parenthesized multiline, one clause per line** — `if (\n  a ||\n  b\n ) {`.
- **`// biome-ignore` must name a rule that actually fires there**, else it becomes a `suppressions/unused` warning itself.
- **The SafeJSON rule (`noRestrictedGlobals` denying bare `JSON`) is OFF in exactly one zone** — `src/youtube/extension/**` (a biome.json override). There, use `JSON` directly with NO biome-ignore (it warns as unused). **Standalone plugin skill scripts** (`plugins/*/skills/*/scripts/**`) have no override: they cannot import `SafeJSON`, so each `JSON` call carries its own `// biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON`. Everywhere else use `SafeJSON`, never an ignore.
- **The pre-commit hook runs `biome check --write --staged`**: it can fix the staged copy while leaving a reflow residue in the working tree of the SAME file. After committing, glance at `git status` and commit the residue as `style:` — don't leave it to pollute the next person's diff.

## Code Style Rules

- **Fix bugs at the root, not at every call site.** When the same issue appears in multiple places because of a shared function, fix the shared function — don't patch each caller individually. One fix at the source beats N fixes at the edges.
- **No file-path comments**: Never add `// src/path/to/file.ts` as first line of files
- **No obvious comments**: Don't add comments that restate what the code already says (e.g. `// Build initial context` before `buildContext()`)
- **Concise commit messages**: Just a title line, no per-file breakdown in the body. Keep it short and focused on the "why"
- **Always use `SafeJSON`, never `JSON`**: Import `SafeJSON` from `@genesiscz/utils/json` and use `SafeJSON.parse()` / `SafeJSON.stringify()` everywhere — `JSON` is biome-restricted in this repo. `SafeJSON` is a comment-json wrapper that handles `//` comments, multi-line comments, and trailing commas. For strict JSON behavior, pass `{ strict: true }` or `{ jsonl: true }`.

## Code Style: Conditionals & Spacing

- **No one-line `if` statements** — even for early returns. Always use block form with braces.
- **Empty line before `if`** — unless the preceding line is a variable declaration used by that `if`.
- **Empty line after closing `}`** — unless followed by `else`, `catch`, `finally`, or another `}`.
- Example:

  ```typescript
  const value = getValue();
  if (!value) {
      return;
  }

  doSomething(value);
  ```

## Code Style: Function Parameters

- **3+ params or optional params → use an object:** `callLLM({ systemPrompt, userPrompt, providerChoice, streaming })`
- **1-2 required, obvious params → positional is fine:** `estimateTokens(text)`, `resolve(base, path)`
- **Mix of required + optional → object with required fields + optional:** `({ session, mode, tokenBudget? })`
- Rule of thumb: if you'd need to look at the signature to know which arg is which, use an object.

## Code Style: Type Safety

- **No `as any`** — use proper type narrowing, type guards, or explicit interfaces.
- When working with union types, use discriminant checks (e.g. `entity.className === "User"`).
- Prefer `error: err` over `error: err instanceof Error ? err.message : String(err)` when the error field accepts unknown.

## Side Effects: Diagnostics & Irreversible Operations

The recurring bug shape in this repo is a path that READS like an inspection but MUTATES durable state. Two of them shipped in one week: `tools ai config doctor` and `tools ai config account test` both spent single-use Anthropic refresh tokens, because both reached a shared auth path that refreshed on expiry. Diagnosing an account could brick it.

- **A diagnostic must never mutate.** If the name says it inspects (`doctor`, `test`, `probe`, `health`, `check`, `status`, `list`, `show`, `--dry-run`, `--check`) it may READ durable state and REPORT on it, and nothing else. No writes, no token rotation, no cache mint that changes what a later process observes. When a diagnostic finds a problem it prints the fix command; it does not apply the fix.
- **Guard above the consuming call, not at the caller.** Single-use credentials (OAuth refresh tokens), machine-global state (the OS keychain), and anything with a rotation counter get their guard in the shared function, immediately BEFORE the line that spends them. A guard at the call site only protects the callers you thought of.
- **A new safety parameter leaves every existing caller unsafe.** Adding `{ noRefresh: true }` fixes exactly the one caller you pass it to. Prefer inverting the default so the DANGEROUS behavior is the opt-in. When you cannot invert (too many callers, public API), `rg` every call site and classify each one in the same commit — an unclassified caller is an unfixed bug, and "I fixed it at the root" is not a defense if the root still defaults to dangerous.
- **Ship the negative control.** A test proving the guarded path is safe is half a test. The other half proves normal use still WORKS: `a bind without probe still reaches the refresh call`. Without it, a guard that leaks into the normal path silently breaks every account at token expiry, which is worse than the bug it fixed.
- **Spy on the irreversible call itself.** Assert against the primitive that spends the resource (the `refresh` call, the keychain `setPassword`, the `DELETE`), not on a symptom downstream. Make the spy THROW as well as record, so a path that reaches it fails loudly instead of passing quietly.

## Debugging & Logging

- **Triage from logs first.** When any tool misbehaves, the FIRST step is to read `~/.genesis-tools/logs/<today>.log` (and recent days) and `rg` for the tool name / error string — *before* forming hypotheses or reproducing. Logs are day-stamped pino JSON. This bug (`sqlite-vec extension failed to load`) was in the logs for weeks before it was triaged; checking them first collapses hours of guessing into one `rg`.
- **Log enough to triage from logs alone.** Every tool must emit enough via `@genesiscz/utils/logger` that a future reader can reconstruct what happened without re-running it: log key decision branches, every external-resource access (DB opens with their paths, spawned commands, API URLs), mode/config resolution, and result counts.
- **Never swallow errors.** A bare `catch {}` is forbidden. At minimum `logger.debug` (or `.warn`) the caught error with context. A swallowed error is a future debugging session that did not have to happen.

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

## Database & Migrations

- Per-tool config/cache dirs: `src/utils/storage/storage.ts` → `~/.genesis-tools/<tool>/`; system SQLite (Mail, Messages) read-only via `src/utils/macos/MacDatabase.ts`.
- Migrations: `src/utils/database/migrations.ts` (`Migration`, `runMigrations()`, `Migrator`); applied IDs persist in `_migrations`; indexer applies `INDEXER_MIGRATIONS` on read-write opens.
- DB test pattern: in-memory `new Database(":memory:")` in `*.test.ts` beside source. Full map: `src/utils/database/CLAUDE.md`.

## Web servers & ports

- Canonical registry: `src/utils/ui/dashboards.ts` — `DASHBOARDS` (browser UIs, consumed by DashboardApp launchers) + `WEB_SERVICES` (http-api/extension/proxy listeners); ports must be unique across both.
- Never hardcode a port for a repo web server — look it up there (`registryEntryForPort()`; e.g. dev-dashboard 3042, log viewer 7243).

## Scoped docs (nested CLAUDE.md — auto-loads when working under that directory)

- `src/utils/claude/CLAUDE.md` — Claude Agent SDK types alignment + upstream-diff commands
- `src/utils/audio/CLAUDE.md` — audio transcription gotchas (`tools transcribe`, `ask --sst`)
- `src/utils/database/CLAUDE.md` — Storage / MacDatabase / migrations / metadata-schema map
- `src/azure-devops/CLAUDE.md` — context7 IDs, local `az` docs, ADO API quick reference

## Important Notes

-   **Logging**: Check `~/.genesis-tools/logs/` for debug information if tools encounter errors

## AI subsystem (layers, accounts, secrets) — one place, do not add new rate tables

Everything AI lives under `src/utils/ai/` + `src/utils/security/`, in layers that import only DOWNWARD. Adding a provider means adding one plugin folder, not touching six call sites.

- **L0 `src/utils/security/`**: `SecretStore` is an AES-256-GCM vault at `~/.genesis-tools/security/vault.json`, per-entry key via HKDF, written under `Storage.withFileLock`. Credentials in config are `SecureRef`s (`{ type: "secure", path: "ai/<accountId>/<field>" }`), never plaintext. The master key comes off a ladder: `GENESIS_TOOLS_MASTER_KEY` env, then the OS keychain, then an opt-in key file (`keyring/headless.ts`). The keychain rung goes through `@napi-rs/keyring` on every platform and NEVER the `security` CLI: macOS grants silent access by code signature, so the same `bun` that wrote an item reads it back with no prompt, while a second binary gets prompted.
  - 🛑 **Tests can never reach the real keychain.** Five independent layers stop them (sandboxed service name, under-test rung block, a `@napi-rs/keyring` preload mock, a non-interactive write barrier, dual-signal test detection), pinned by `keyring/keychain-guard.test.ts`.
- **L1 `src/utils/ai/config/`**: `AiConfigStore` is the single reader/writer of the v4 `~/.genesis-tools/ai/config.json` (accounts with immutable `id` plus renameable `name`, `defaults.{account,task,app}`, aliases). It re-reads on mtime change, so a long-running proxy sees a `tools claude login` from another terminal. Mutate through `mutate()` / `withLock()`, never by writing the file directly. `AIConfig` survives only as a deprecated facade.
- **L2 `src/utils/ai/providers/`**: one folder per provider implementing `ProviderPlugin` (`kind`, `capabilities`, `credential`, `bind()`, optional `health()`). `resolveCredential` is the ONE chokepoint deciding where a key comes from: the account first, a DECLARED env var second. Ambient env pickup that no account claims is an error naming the fix command, except the grandfathered set, which keeps working through `ephemeralEnvAccounts` (in memory, names the variable, never copies the value).
- **L3 `src/utils/ai/catalog/`**: `STATIC_CATALOG` plus `byId(id, provider?)` and `pricingFor()` (static, then LiteLLM, then OpenRouter). Pricing supports dated and context-banded `rules`, resolved by the pure `effectivePricing()`.
- **L4 `src/utils/ai/core/`**: `resolveModel` / `resolveModelTarget` is the ONE resolution ladder (explicit ref, then app default, then task default, then global), and `coreChat` / `callLLM` the one transport. `ModelRef` grammar: `"grok-4-fast"`, `"xai/grok-4-fast"`, `"@account/<id>:<model>"`, `"@proxy/<slug>/<model>"`.
- **L5 `src/utils/ai/tasks/`**: the `ai.*` facade (`chat`, `embed`, `transcribe`, `speak`, `synthesize`, `summarize`, `translate`, `image`; `realtime` throws a documented `NotImplementedError`). It owns binding lifetime, so a facade verb disposes the binding it resolved. That matters because local runtimes hold native handles.
- **L6 `src/utils/ai/session/`** and **L7 `src/utils/ai/usage/`**: shared session store plus mini-agent, and `recordUsage` / `queryUsage`. `recordUsage` NEVER throws (it sits in the hot path of every call) and records `costSource` so a derived price is never mistaken for a booked one.

**Cost math is `src/utils/ai/llm-cost.ts` only**: `calculateCallCostUsd` (prices cache reads and writes at their own rates) and `estimateLlmCallCostUsd`. No rate table belongs there, or anywhere new.

⚠️ **ai@7's Anthropic provider folds cache tokens into top-level `inputTokens`.** Recording that field as billable input charges cached tokens twice, once at the full rate and again at the cache rate. Use `usageInputNoCacheTokens(usage)` from `@genesiscz/utils/ask/usage-tokens`.

🛑 **Deliberate exception, do not "deduplicate":** `src/ai-proxy/lib/billing/pricing.ts` keeps a STATIC rate table. It is the ai-proxy client-ledger invoicing source of truth: deterministic, offline, and its rates may intentionally differ from list prices. Cost is booked at WRITE time (`recordClientUsage()`), so a later rate edit never rewrites past invoices. Readers print the stored `cost_usd` and never recompute. `pricing.test.ts` asserts every priced prefix still names a known model, never rate equality.

**Guards.** `scripts/ci/ai-credentials-guard.sh` fails the build on argless `createOpenAI(` / `createGroq(`, bare `@ai-sdk` singletons outside `providers/`, and any `new Storage("ai")` outside `src/utils/ai/config/**` (need a path? use `aiDataDir()` from `config/paths.ts`). Note its rule-3 regex has no comment awareness, so it matches the literal call inside prose too.

**CLI.** `tools ai config account add|list|show|edit|rm|test`, `default set`, `link ls`, `secret set|rotate|export|import`, and `tools ai config doctor` (per-account credential diagnosis). `tools ai-proxy link` registers the proxy as a real account so `@proxy/...` refs resolve.

🛑 **A diagnostic must never mutate.** See "Side Effects: Diagnostics & Irreversible Operations" above. `doctor` and `account test` pass `probe: true`, and each plugin's shared auth path refuses to spend a single-use refresh token.
