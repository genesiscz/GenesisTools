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
- `src/utils/ai/device.ts` - ONNX Runtime device detection: `detectDevice()`, `resolveDevice()` (CoreML/CUDA/DML/CPU)
- `src/utils/audio/converter.ts` - Audio transcode helpers: `convertToWhisperWav()`, `convertFileToMonoMp3()`, `MONO_MP3_BITRATE_KBPS`, `toFloat32Audio()`
- `src/utils/audio/detect-format.ts` - Magic-byte audio sniffing: `detectAudioFormat()`, `sniffAudioExt()`
- `src/utils/cli/quiet-spinner.ts` - No-op spinner for non-TTY (`createQuietSpinner()`); pair with `isQuietOutput()` from `src/utils/cli/output-mode.ts`

Tool-specific logic stays in the tool directory (e.g., `src/har-analyzer/core/`).

### Tool Patterns

Most tools follow these common patterns:

**CLI Argument Parsing**:

-   Use `commander` for parsing command-line arguments with subcommands and options
-   **Commands as controllers**: Treat `src/<tool>/commands/` files as thin wrappers — parse args, call into `src/<tool>/lib/` for business logic. Keep commands lean, keep logic in lib/.

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

See `.claude/docs/tool-template.md` for complete templates (@inquirer + @clack/prompts), common patterns, and best practices.

## Building or Restyling Web UI

**Before writing or restyling ANY web UI** (`src/<tool>/ui`, `src/dashboard`, `src/dev-dashboard/ui`), read `.claude/docs/design-system.md`. It is the single shared-UI contract: theme tokens + `@ui/components/*` primitives + `wow-components.css` looks. Hard rules: no raw `zinc-*`/`white/NN` palette in app code (use theme tokens), never override a `<Card>`'s surface, pick a rich Button/Card variant on purpose, wrap routes in the shared shell/auth-layout. This doc exists because clarity & shops drifted "flat" by ignoring it while the dashboard didn't — don't repeat that. For per-dashboard design lineage (all 8 dashboards categorized into design families; why youtube/dev-dashboard diverge) see `.claude/docs/design-system-dashboards.md`; for the canonical ports/launch registry + conflict detection see `src/utils/ui/dashboards.ts`.

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

## LLM Model Library & Pricing (one place — do not add new rate tables)

- **Canonical model list + pricing**: `providerManager.detectProviders()` (`src/ask/providers/ProviderManager.ts`) returns `ModelInfo[]` with `pricing?: PricingInfo` (`inputPer1M`/`outputPer1M`, `src/ask/types/provider.ts`). Pricing is populated by `dynamicPricingManager.getPricing(provider, modelId)` (`src/ask/providers/DynamicPricing.ts`), sourced from LiteLLM's `model_prices_and_context_window.json` (cached as `litellm-pricing.json`) + OpenRouter.
- **Cost math (pure)**: `src/utils/ai/llm-cost.ts` — `estimateLlmCallCostUsd({pricing, inputTokens, outputTokens})`, `estimateSpeechTokens(durationSec)`. No rates in there, math only.
- **Deliberate exception**: `src/ai-proxy/lib/billing/pricing.ts` keeps a small STATIC table — it's the ai-proxy client-ledger invoicing source of truth (deterministic, offline). Don't "deduplicate" it into the dynamic path, and don't copy it anywhere else.
- Resolving a user's provider/model choice (default account, `-sub` suffix handling): `resolveProviderChoice()` in `src/youtube/lib/provider-choice.ts` wraps `modelSelector`/`providerManager`.
- **Accounts** live in `~/.genesis-tools/ai/config.json` (`AIConfig`, types in `src/utils/config/ai.types.ts`). Subscription billing is flagged by `DetectedProvider.subscription` (set by the `*SubResolver`s in `src/utils/ai/resolvers/`) — never infer it from name suffixes. API-key accounts may REFERENCE an env var via `tokens.apiKeyEnv` (resolved by `AIConfig.resolveApiKey`, never copied); `grok-sub` accounts reference the Grok CLI auth file via `tokens.authFile` (default `~/.grok/auth.json`, resolved by `resolveGrokSubToken` in `src/utils/ai/grok/account.ts`). ai-proxy's subscription providers bill these same accounts by `accountName` reference.

