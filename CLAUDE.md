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

# Examples:
tools git-last-commits-diff . --commits 3 --clipboard
tools collect-files-for-ai ./my-repo -c 5
tools files-to-prompt src/ --cxml > prompt.xml
tools watch "src/**/*.ts" -v
tools npm-package-diff react 18.0.0 18.2.0
tools ask --readme  # View ask tool documentation
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

Never read `process.env` directly in application code — use `import { env } from "@app/utils/env"`. Values: `env.getXAIApiKey()` or `env.x.getApiKey()`; resolved key names (for config metadata): `env.getXAIApiEnvKey()` or `env.x.getApiEnvKey()`. Grouped domains: `env.tools`, `env.ai.*`, `env.github`, `env.log`, `env.paths`, `env.device`, `env.test`, etc. Tests that need overrides: `env.testing.set()` / `env.testing.withOverrides()`.

### Utility Convention

When creating a new tool and writing helper functions, check if the utility is **general-purpose** (usable by other tools). If so, place it in `src/utils/` instead of inside the tool directory:

- `src/utils/format.ts` - Formatting: `formatDuration()`, `formatBytes()`, `formatTokens()`, `formatNumber()`, `formatList()`, `formatTimestamp()`, `createStopwatch()`
- `src/utils/Stopwatch.ts` - High-res stopwatch class: `elapsed()`, `lap()`, `stamp()` (wall-clock + elapsed), `now()` (HH:MM:SS.mmm)
- `src/utils/table.ts` - Text table formatting
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

### Audio transcription gotchas (`tools transcribe`, `ask --sst`)

Hard-won; do not relearn these by trial:

- **Audio transcode/convert utils belong in `src/utils/audio/`**, never tied
  into a tool (e.g. NOT new methods on `src/ask/audio/AudioProcessor.ts`).
  Reuse/extend `converter.ts`.
- **AI SDK `transcribe()` has no top-level `language`.** A language hint
  ONLY works via `providerOptions.<providerId>.language`. Passed anywhere
  else it is silently dropped → Whisper auto-detects per-30s and
  hallucination-loops on Czech/non-English. Provider-option keys are
  **camelCase** (`language`, `temperature`, `timestampGranularities`,
  `smartFormat`, `detectLanguage`).
- **`ai@5`'s `transcribe()` only accepts spec-v2 transcription models.**
  `@ai-sdk/deepgram@2.x` and latest `@ai-sdk/groq` are spec-v3 →
  `AI_UnsupportedModelVersionError`. Pin **`@ai-sdk/deepgram@^1.0.28`**
  (latest v2). Don't "fix" by upgrading `ai`.
- **Deepgram via AI SDK exposes only raw lowercase per-word segments**;
  the smart-formatted transcript is solely in `result.text`. SRT/VTT need
  word→sentence realignment (see `mapResultSegments` in
  `TranscriptionManager.ts`).
- **`gpt-4o-transcribe`/`gpt-4o-mini-transcribe` reject many containers**
  ("does not support the format") and return **no segment timestamps**.
  Cloud uploads are normalized to 16kHz-mono MP3 (`convertFileToMonoMp3`)
  in `AICloudProvider.transcribe`; for these models SRT degrades to text.
- **`whisper-1` still loops on some audio even configured correctly** —
  it's a model limitation, not a bug. Offer `gpt-4o-transcribe` or
  Deepgram nova-3 (robust + ~5× faster) as the alternative.
- Non-TTY transcribe must use the quiet spinner (no clack frames),
  transcript → stdout, status → stderr.

### Tool Patterns

Most tools follow these common patterns:

**CLI Argument Parsing**:

-   Use `commander` for parsing command-line arguments with subcommands and options
-   Define command structure with `.command()`, `.option()`, and `.action()`
-   Provide clear `--help` documentation with usage examples (auto-generated by commander)
-   **Commands as controllers**: Treat `src/<tool>/commands/` files as thin wrappers — parse args, call into `src/<tool>/lib/` for business logic. Keep commands lean, keep logic in lib/.

**Interactive User Experience**:

-   Two prompt libraries available: `@inquirer/prompts` (legacy) and `@clack/prompts` (preferred for new tools)
-   See "Choosing a Prompt Library" below for when to use each
-   Common prompt types: `select`, `input`, `confirm`, `checkbox`/`multiselect`
-   Handle user cancellation gracefully
-   Provide sensible defaults and suggestions in prompts
-   **Non-TTY guard**: Always check `isInteractive()` (from `@app/utils/cli`) before showing prompts. When non-interactive, either error with `suggestCommand()` showing required CLI flags, or use a sensible default:

    ```typescript
    import { isInteractive, suggestCommand } from "@app/utils/cli";

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
-   Use `chalk` for colored terminal output (but strip ANSI codes for non-TTY)
-   Respect `--silent` and `--verbose` flags

**Process Execution**:

-   Use `Bun.spawn()` for executing external commands
-   Handle stdout/stderr streams properly using `new Response(proc.stdout).text()`
-   Always check exit codes and provide meaningful error messages

**File Operations**:

-   Use Node.js `path` module for cross-platform path handling
-   Resolve relative paths to absolute using `resolve()`
-   Check file/directory existence before operations
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
- **Always use `SafeJSON`, never `JSON`**: Import `SafeJSON` from `@app/utils/json` and use `SafeJSON.parse()` / `SafeJSON.stringify()` everywhere — `JSON` is biome-restricted in this repo. `SafeJSON` is a comment-json wrapper that handles `//` comments, multi-line comments, and trailing commas. For strict JSON behavior, pass `{ strict: true }` or `{ jsonl: true }`.

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
- **Log enough to triage from logs alone.** Every tool must emit enough via `@app/logger` that a future reader can reconstruct what happened without re-running it: log key decision branches, every external-resource access (DB opens with their paths, spawned commands, API URLs), mode/config resolution, and result counts.
- **Never swallow errors.** A bare `catch {}` is forbidden. At minimum `logger.debug` (or `.warn`) the caught error with context. A swallowed error is a future debugging session that did not have to happen.

## Logging & output

Two cleanly separated layers (the 2026-05 logger+out overhaul):

- **`logger` — diagnostics.** `import { logger } from "@app/logger"` (named only; there is **no** default export and no `consoleLog` — they were removed). Writes to the day-stamped file **always** (debug+), and to the console **on stderr**, gated by level. `logger.*` is **never** the result channel. Global `-v` promotes file-only `logger.debug` to the console; `-vv` → trace (only on tools that opted into `--trace`).
- **`out` — user-facing.** `import { out } from "@app/logger"` (or `const { log, out } = logger.scoped("comp")`). clack-shaped. **`out.result(data)` / `out.print(raw)` are the ONLY writers to stdout** (the machine result). `out.log.*` / spinners / notes / prompts → stderr. Never emit a serialized result via `logger.*` — that is `out.result()`'s job (CI guard enforces this).
- **`const { log, out } = logger.scoped("comp")`:** `log.*` = logger-only (diagnostics); `log.out.*` / `log.tee.*` = both (component-tagged single mirror); destructured `out.*` = only-out (no logger mirror).
- **Every commander entrypoint** ends with `await runTool(program, { tool })` (from `@app/utils/cli`) — it owns `-v`/`--readme`/help registration, console-level resolution, and the `{tool}` log binding, then `parseAsync`. The subprocess **spawner** is `execTool` (renamed from the old `runTool`).
- **`scripts/ci/logging-guard.sh`** enforces this convention repo-wide in CI: no default/extension/relative-path/any-name import of the logger module (root `./tools` and `scripts/` included — not just `src/`), no bare `logger.*(SafeJSON.stringify(…))` result dumps, no reintroduced transitional shims, and that the browser-client isolation test exists. Browser-client trees never value-importing `@app/logger` is authoritatively enforced by `src/logger/client-isolation.test.ts`.
- **`@app/utils/cli/ui` — high-density CLI status.** For tools that emit many short status lines per command (e.g. `tools stash`), clack's `│ ◆ ●` box-drawing is the wrong texture. Import `{ ui }` from `@app/utils/cli/ui` to get plain stderr writes with chalk decoration (`ui.ok/info/warn/err/dim/header/kv/section/raw`). Use this INSTEAD of `out.log.*` for high-density status; keep `out.log.*` for clack-shaped task lifecycles. `out.print()` / `out.result()` are still the only writers to stdout for machine-readable output.

## Claude Agent SDK Types Reference

The session/message types in `src/utils/claude/` are aligned with `@anthropic-ai/claude-agent-sdk`. To check for upstream changes:

```bash
# Check latest version
npm view @anthropic-ai/claude-agent-sdk version

# Diff types between versions (no install needed)
npm diff \
  --diff=@anthropic-ai/claude-agent-sdk@<old> \
  --diff=@anthropic-ai/claude-agent-sdk@<new> \
  '**/*.d.ts'

# Read full current types (extracts ~270KB of .d.ts, no node_modules)
cd /tmp && npm pack @anthropic-ai/claude-agent-sdk && \
  mkdir -p sdk-types && \
  tar xzf anthropic-ai-claude-agent-sdk-*.tgz -C sdk-types --strip-components=1 '*.d.ts'
# Then read: /tmp/sdk-types/sdk.d.ts and /tmp/sdk-types/sdk-tools.d.ts
```

Key SDK type files: `sdk.d.ts` (session/message/streaming types), `sdk-tools.d.ts` (tool I/O schemas).

**Known gaps vs SDK** (as of v0.2.81):

| SDK Feature | Status |
|-------------|--------|
| `FileReadOutput` (image base64+dimensions, PDF, notebook) | Not tracked (tool output type, not message type) |

## Important Notes

-   **Runtime**: This project requires Bun as it uses Bun-specific APIs (e.g., `Bun.spawn`)
-   **Global Access**: The `install.sh` script modifies shell config to add GenesisTools to PATH
-   **No Tests**: The project currently has no test suite
-   **TypeScript Config**: Strict mode enabled, ES modules, no emit (Bun runs TS directly)
-   **Logging**: Check `~/.genesis-tools/logs/` for debug information if tools encounter errors

## Database Infrastructure

- **Storage**: `src/utils/storage/storage.ts` owns per-tool config/cache directories under `~/.genesis-tools/<tool>/`; wrap it with tool-specific subclasses such as `IndexerStorage`.
- **MacDatabase**: `src/utils/macos/MacDatabase.ts` is the read-only base accessor for system SQLite databases (Mail Envelope Index, Messages, etc.) and exposes subclass-owned `getMigrator()`.
- **Generic migrations**: `src/utils/database/migrations.ts` provides `Migration`, `runMigrations()`, `getPendingMigrations()`, and `Migrator`; applied IDs are persisted in `_migrations` while schema-aware migrations can use `isApplied`.
- **Indexer migrations**: `src/indexer/lib/indexer-migrations.ts` defines `INDEXER_MIGRATIONS`, which `createIndexStore()` applies on read-write opens.
- **Metadata schema**: `src/indexer/lib/metadata-schema.ts` supports per-source typed columns plus `metadata_json TEXT DEFAULT '{}'` for ad-hoc fields; typed columns are used for filter pushdown and unindexed extras round-trip through the JSON bag.
- **Test pattern**: When adding DB logic, use an in-memory `new Database(":memory:")` in `*.test.ts` files grouped alongside source.

## Context7 Library IDs for Documentation Lookup

When researching Microsoft/Azure APIs, use these context7 library IDs:

| Library ID | Use For | Key Topics |
|------------|---------|------------|
| `/websites/learn_microsoft_en-us_rest_api_azure_devops` | Azure DevOps REST API | Work items, revisions, updates, comments, WIQL, reporting APIs |
| `/microsoftdocs/azure-docs-cli` | Azure CLI commands | `az boards`, `az devops`, `az pipelines`, `az repos`, `az rest` |
| `/microsoftdocs/azure-devops-docs` | Azure DevOps general docs | Process templates, boards config, permissions |

**Usage with context7 MCP:**
```bash
# 1. Resolve library ID
mcp__context7-mcp__resolve-library-id with libraryName="azure devops rest api"

# 2. Query docs (use the resolved ID)
mcp__context7-mcp__get-library-docs with context7CompatibleLibraryID="/websites/learn_microsoft_en-us_rest_api_azure_devops" topic="work item revisions"
```

**When to use context7 vs local docs:**
- **Context7**: For detailed API specs, parameters, response schemas, edge cases
- **Local docs** (`src/azure-devops/docs/`): Quick reference for `az` CLI commands with examples

### Local Azure DevOps CLI Documentation

See `src/azure-devops/docs/` for comprehensive CLI reference (~15K tokens total):
- `az-boards-work-item.md` - Work item CRUD
- `az-boards-iteration.md` - Sprint/iteration management
- `az-repos-pr.md` - Pull request workflows
- `az-rest.md` - Raw REST API calls
- `work-item-history-api-reference.md` - **Revisions, updates, comments APIs** (detailed)

### Azure DevOps API Quick Reference

**Batch endpoints (reduce API calls):**
- `POST /wit/workitemsbatch` - Get up to 200 work items in one call (current state only)
- `GET /wit/reporting/workitemrevisions` - **Batch history** for multiple work items (use for sync)

**Per-item endpoints:**
- `GET /wit/workitems/{id}?$expand=all` - Single work item with all fields/relations
- `GET /wit/workitems/{id}/updates` - Field change deltas (no batch available)
- `GET /wit/workitems/{id}/revisions` - Full snapshots per revision
- `GET /wit/workitems/{id}/comments` - Comments (no cross-item batch)
