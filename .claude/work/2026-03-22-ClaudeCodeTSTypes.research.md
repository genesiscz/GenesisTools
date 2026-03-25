# Claude Code TypeScript Types — Research Report

**Date:** 2026-03-22
**Goal:** Find repos/packages providing TypeScript types for Claude Code sessions, JSONL files, agent structures, hooks, and tool I/O.

---

## TL;DR — The Best Options

| # | Source | What it gives you | Updater/Sync? | Install |
|---|--------|-------------------|---------------|---------|
| 1 | **`@anthropic-ai/claude-agent-sdk`** (npm) | **Official** 161+ exported types: all SDK messages, hook events, tool I/O schemas, session types, agent definitions, MCP configs | N/A — **it IS the upstream** | `npm i @anthropic-ai/claude-agent-sdk` |
| 2 | **`cc-hooks-ts`** (npm) | Type-safe hook definitions wrapping the official SDK types, `defineHook()` DX, tool-specific type narrowing | **YES** — versions track upstream SDK (currently 2.1.81 = SDK 0.2.81), documented diff workflow | `npm i cc-hooks-ts` |
| 3 | **`constellos/claude-code`** (GitHub) | 32KB `shared/types/types.ts` with hook I/O types, transcript parsing, plugin utilities | Manual — no auto-sync | Clone repo |

---

## 1. Official Source: `@anthropic-ai/claude-agent-sdk`

- **npm:** <https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk>
- **GitHub:** <https://github.com/anthropics/claude-agent-sdk-typescript>
- **Version:** 0.2.81 (published 2026-03-20, 139 versions total)
- **Unpacked size:** 61.0 MB

### What's inside

The package ships two primary `.d.ts` files:

**`sdk.d.ts`** (~3,970 lines, 161 exports) — the motherlode:

- **Session types:** `SDKSession`, `SDKSessionInfo`, `SDKSessionOptions`, `SessionMessage`, `SessionMutationOptions`
- **Message types (JSONL lines):** `SDKMessage` is a union of 20+ message types:
  - `SDKAssistantMessage`, `SDKUserMessage`, `SDKUserMessageReplay`
  - `SDKResultMessage` (`SDKResultSuccess | SDKResultError`)
  - `SDKSystemMessage`, `SDKPartialAssistantMessage`
  - `SDKCompactBoundaryMessage`, `SDKStatusMessage`, `SDKAPIRetryMessage`
  - `SDKLocalCommandOutputMessage`
  - `SDKHookStartedMessage`, `SDKHookProgressMessage`, `SDKHookResponseMessage`
  - `SDKToolProgressMessage`, `SDKToolUseSummaryMessage`
  - `SDKAuthStatusMessage`, `SDKRateLimitEvent`
  - `SDKTaskNotificationMessage`, `SDKTaskStartedMessage`, `SDKTaskProgressMessage`
  - `SDKFilesPersistedEvent`, `SDKElicitationCompleteMessage`, `SDKPromptSuggestionMessage`
- **Hook types:** `HookEvent` (23 event types), `HookInput`, `HookJSONOutput`, `AsyncHookJSONOutput`, `SyncHookJSONOutput`, plus per-event input/output types for all of:
  - `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`
  - `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`
  - `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`
  - `PermissionRequest`, `Setup`, `TeammateIdle`, `TaskCompleted`
  - `Elicitation`, `ElicitationResult`, `ConfigChange`
  - `InstructionsLoaded`, `WorktreeCreate`, `WorktreeRemove`
- **Agent types:** `AgentDefinition`, `AgentInfo`, `AgentMcpServerSpec`
- **MCP types:** `McpServerConfig`, `McpStdioServerConfig`, `McpSSEServerConfig`, `McpHttpServerConfig`, `McpSdkServerConfig`, `McpServerStatus`
- **Permission types:** `PermissionBehavior`, `PermissionMode`, `PermissionResult`, `PermissionRuleValue`, `PermissionUpdate`
- **Settings:** `Settings` interface, `SettingSource`, `ConfigScope`
- **SDK functions:** `query()`, `listSessions()`, `getSessionInfo()`, `getSessionMessages()`, `forkSession()`, `renameSession()`, `tagSession()`
- **v2 API:** `unstable_v2_createSession()`, `unstable_v2_prompt()`, `unstable_v2_resumeSession()`

**`sdk-tools.d.ts`** (~2,823 lines) — auto-generated from JSON Schema:

- `ToolInputSchemas` — union of all built-in tool inputs
- Individual types: `AgentInput`, `BashInput`, `FileEditInput`, `FileReadInput`, `FileWriteInput`, `GlobInput`, `GrepInput`, `WebFetchInput`, `WebSearchInput`, `TodoWriteInput`, `NotebookEditInput`, `McpInput`, `AskUserQuestionInput`, `ConfigInput`, `EnterWorktreeInput`, `ExitWorktreeInput`, etc.
- Matching output types for every tool

### Key insight

**This is the canonical source.** The repo only contains `scripts/`, `.claude/`, `.github/`, `CHANGELOG.md`, and `README.md` — the actual source code is closed-source and the npm package is a compiled distribution. But the `.d.ts` files are comprehensive and auto-generated, making them the ground-truth for all Claude Code types.

### Using it for JSONL parsing

```typescript
import type { SDKMessage, SDKAssistantMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

// Each line in a ~/.claude/projects/**/*.jsonl file is an SDKMessage
function parseJsonlLine(line: string): SDKMessage {
  return JSON.parse(line) as SDKMessage;
}
```

---

## 2. Best Community Wrapper: `cc-hooks-ts`

- **npm:** <https://www.npmjs.com/package/cc-hooks-ts> (v2.1.81)
- **GitHub:** <https://github.com/sushichan044/cc-hooks-ts>
- **Language:** TypeScript
- **Updated:** 2026-03-22 (yesterday)
- **Dependency:** `@anthropic-ai/claude-agent-sdk@0.2.81`

### Why this is special — **Automatic Upstream Sync**

This is the **only** project with a documented process for staying in sync with the official SDK:

> Starting with versions 2.0.42, we will raise our version number to match Claude Code whenever Hook-related changes occur.

Their documented update workflow:
1. Check installed vs latest `@anthropic-ai/claude-agent-sdk` version
2. Run `npm diff --diff=@anthropic-ai/claude-agent-sdk@<old> --diff=@anthropic-ai/claude-agent-sdk@<new> '**/*.d.ts'`
3. Reflect changes in `src/hooks/` types
4. Type-level tests (`*.test-d.ts`) verify correctness

### What it adds beyond raw SDK types

- `defineHook()` — type-safe hook definition with event-specific type narrowing
- `runHook()` — stdin/stdout JSON I/O runner
- `context.success()`, `context.blockingError()`, `context.defer()` — structured response helpers
- Tool-specific hooks with automatic `tool_input` typing (e.g., `PreToolUse.Read` narrows to `{ file_path: string; limit?: number; offset?: number }`)
- Custom MCP tool type extension via `declare module "cc-hooks-ts"` augmentation
- Conditional execution via `shouldRun`
- Async deferred hook execution

### Source structure

```
src/
├── context.ts          — Hook context helpers (success, error, defer, json)
├── define.ts           — defineHook() overloads
├── hooks/              — Per-event input/output type definitions
├── index.ts            — Re-exports + tool schema types
├── run.ts              — Hook runner (stdin parse → handler → stdout)
├── types.ts            — Core type definitions
└── utils/              — Internal utilities
```

---

## 3. Plugin Marketplace with Types: `constellos/claude-code`

- **GitHub:** <https://github.com/constellos/claude-code>
- **Language:** TypeScript
- **Description:** "TypeScript types and type gen hooks for Claude Code: system tools, MCP tools, session transcripts, and hook events"
- **License:** MIT

### What it provides

A `shared/types/types.ts` file (32KB) with full hook type definitions, plus:

- `shared/hooks/utils/` — Hook I/O utilities, debug logging, transcript parsing
  - `io.ts` — stdin/stdout JSON handling, `runHook()` wrapper
  - `transcripts.ts` — Parse Claude transcript JSONL files
  - `subagent-state.ts` — Subagent context save/load/analyze
  - `task-state.ts` — Task state management
- Three production plugins demonstrating the types in use

### Caveats

- **No npm package** — must clone the repo
- **No auto-sync** mechanism with upstream SDK
- Types may drift from official SDK over time
- More focused on plugin development than JSONL parsing

---

## 4. Other Hook SDKs

### `hgeldenhuys/claude-hooks-sdk`
- **GitHub:** <https://github.com/hgeldenhuys/claude-hooks-sdk>
- **Description:** "Type-safe TypeScript SDK for building Claude Code hook extensions"
- **Last updated:** 2025-12-15 (somewhat stale)
- **No npm package found**

### `mizunashi-mana/claude-code-hook-sdk`
- **GitHub:** <https://github.com/mizunashi-mana/claude-code-hook-sdk>
- **Description:** "TypeScript SDK to write claude-code hooks easily with type safety, dependency injection, and comprehensive testing support"
- **Last updated:** 2025-12-15 (somewhat stale)

### `Payshak/claude-hook-kit`
- **GitHub:** <https://github.com/Payshak/claude-hook-kit>
- **Description:** "TypeScript SDK for building Claude Code hooks — typed, testable, composable"
- **Last updated:** 2026-03-21 (very fresh)

---

## 5. JSONL Parsers & Viewers (with embedded types)

These repos parse JSONL files and thus contain implicit or explicit type definitions:

| Repo | Lang | Description | Updated |
|------|------|-------------|---------|
| [ryoppippi/ccusage](https://github.com/ryoppippi/ccusage) | TS | CLI for analyzing Claude Code usage from JSONL | 2026-03-22 |
| [Codestz/claude-hindsight](https://github.com/Codestz/claude-hindsight) | TS | Observability tool — JSONL → interactive visualizations | 2026-03-20 |
| [delexw/claude-code-trace](https://github.com/delexw/claude-code-trace) | TS/React | Real-time JSONL session log viewer (Tauri desktop app) | 2026-03-21 |
| [mttetc/AgentReplay](https://github.com/mttetc/AgentReplay) | TS | DevTools for replaying AI agent sessions from JSONL | 2026-03-22 |
| [Ruya-AI/cozempic](https://github.com/Ruya-AI/cozempic) | TS | Context cleaning — prune bloated JSONL sessions | 2026-03-19 |
| [daaain/claude-code-log](https://github.com/daaain/claude-code-log) | Python | JSONL → readable HTML | 2026-03-18 |
| [Vvkmnn/claude-historian-mcp](https://github.com/Vvkmnn/claude-historian-mcp) | TS | MCP server for conversation history search from JSONL | 2026-03-22 |
| [amac0/ClaudeCodeJSONLParser](https://github.com/amac0/ClaudeCodeJSONLParser) | ? | Parser for Claude Code JSON logs (early, May 2025) | 2025-05-22 |
| [shitchell/claugs](https://github.com/shitchell/claugs) | ? | Parse and prettify Claude Code JSONL output | 2026-03-19 |
| [nitsanavni/session](https://github.com/nitsanavni/session) | ? | CLI to parse claude code JSONL files | 2026-01-15 |
| [erans/cc-sessions-cli](https://github.com/erans/cc-sessions-cli) | ? | CLI for managing/viewing session JSONL files | 2025-09-24 |
| [withLinda/claude-JSONL-browser](https://github.com/withLinda/claude-JSONL-browser) | Web | Web-based JSONL → Markdown converter | 2026-03-21 |
| [Brads3290/cclogviewer](https://github.com/Brads3290/cclogviewer) | ? | Review JSONL files with HTML UI | 2025-08-08 |
| [cobra91/better-ccusage](https://github.com/cobra91/better-ccusage) | ? | Token usage/costs from JSONL, multi-provider | 2026-02-16 |
| [KindledFlameStudios/cinderace-sessions](https://github.com/KindledFlameStudios/cinderace-sessions) | ? | Export sessions as markdown, HTML, JSON, ZIP | 2026-03-22 |

---

## 6. Session Analytics & Tracking (JSONL consumers)

| Repo | Description | Updated |
|------|-------------|---------|
| [neozenith/claude-code-sessions](https://github.com/neozenith/claude-code-sessions) | FastAPI + React dashboard, DuckDB | 2026-03-10 |
| [hazyhaar/claude-vault](https://github.com/hazyhaar/claude-vault) | MCP plugin — JSONL → SQLite JSONB, analytics | 2026-03-21 |
| [cnu/claude-stats](https://github.com/cnu/claude-stats) | Go CLI — JSONL → SQLite analytics | 2026-03-07 |
| [kimsaandev/Claude-Monitor](https://github.com/kimsaandev/Claude-Monitor) | Real-time dashboard via WebSocket | 2026-03-17 |
| [ElementalInsights/claude-wrapped](https://github.com/ElementalInsights/claude-wrapped) | "Spotify Wrapped" for Claude sessions | 2026-02-27 |
| [LokiQ0713/cc-token-usage](https://github.com/LokiQ0713/cc-token-usage) | Token usage + interactive HTML dashboard | 2026-03-21 |

---

## 7. Session Modification / Recovery

| Repo | Description | Updated |
|------|-------------|---------|
| [Ruya-AI/cozempic](https://github.com/Ruya-AI/cozempic) | Context cleaning, tiered pruning | 2026-03-19 |
| [Chill-AI-Space/session-snapshot](https://github.com/Chill-AI-Space/session-snapshot) | Rolling JSONL snapshots, auto-restore | 2026-03-16 |
| [danieliser/agent-reflog](https://github.com/danieliser/agent-reflog) | Forensic recovery from JSONL logs | 2026-02-25 |
| [ahundt/ai_session_tools](https://github.com/ahundt/ai_session_tools) | Find/recover data from sessions | 2026-03-19 |
| [miteshashar/claude-code-thinking-blocks-fix](https://github.com/miteshashar/claude-code-thinking-blocks-fix) | Fix "thinking blocks" corruption in JSONL | 2026-02-14 |
| [meridianix/clawdbot-session-pruner](https://github.com/meridianix/clawdbot-session-pruner) | Truncate large tool results in JSONL | 2026-01-26 |

---

## 8. Cross-Platform Bridges

| Repo | Description | Updated |
|------|-------------|---------|
| [bakhtiersizhaev/ai-session-bridge](https://github.com/bakhtiersizhaev/ai-session-bridge) | Bidirectional JSONL conversion: Claude Code ↔ Codex | 2026-03-20 |
| [Om22210564/OpenAnt](https://github.com/Om22210564/OpenAnt) | Session bridge: Claude Code ↔ Codex | 2026-03-08 |
| [ChaitanyaPinapaka/rethread](https://github.com/ChaitanyaPinapaka/rethread) | Export Claude Code + Gemini CLI conversations | 2026-03-09 |

---

## 9. Official Anthropic Repos

| Repo | Stars | Description |
|------|-------|-------------|
| [anthropics/claude-code](https://github.com/anthropics/claude-code) | Very high | Official repo — has `plugins/`, `examples/`, `.claude-plugin/` but **no source code** (compiled npm distribution) |
| [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript) | High | Source repo for `@anthropic-ai/claude-agent-sdk` — only has scripts, changelog, README (source is closed) |
| [anthropics/claude-agent-sdk-demos](https://github.com/anthropics/claude-agent-sdk-demos) | — | Demo projects using the SDK |
| [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | — | Official plugin directory |

---

## Recommendations

### For JSONL parsing / session types
**Use `@anthropic-ai/claude-agent-sdk` directly.** It exports `SDKMessage` (union of 20+ message types) which maps 1:1 to JSONL lines. Also exports `getSessionMessages()`, `listSessions()`, `getSessionInfo()`, `forkSession()` for programmatic session access.

### For writing hooks
**Use `cc-hooks-ts`.** It wraps the official SDK types with excellent DX (`defineHook`, `runHook`, context helpers) and actively tracks upstream changes. Published on npm, 34 versions, updated daily.

### For plugin development
**Use `constellos/claude-code`** as a reference. It has production plugins with comprehensive type usage, transcript parsing utilities, and shared hook utilities.

### For building your own types / keeping in sync
Follow `cc-hooks-ts`'s approach:
```bash
# Check for upstream type changes
npm diff --diff=@anthropic-ai/claude-agent-sdk@<old_version> --diff=@anthropic-ai/claude-agent-sdk@<new_version> '**/*.d.ts'
```

---

## Summary: Type Coverage Map

| What you need types for | Best source | Auto-updated? |
|------------------------|-------------|---------------|
| JSONL message lines (`SDKMessage`) | `@anthropic-ai/claude-agent-sdk` | Yes (npm) |
| Tool inputs/outputs (Bash, Read, Write, etc.) | `@anthropic-ai/claude-agent-sdk` `sdk-tools.d.ts` | Yes (npm) |
| Hook event types (all 23 events) | `@anthropic-ai/claude-agent-sdk` or `cc-hooks-ts` | Yes |
| Hook DX (defineHook, runHook) | `cc-hooks-ts` | Yes (tracks SDK) |
| Session management (list, fork, rename, tag) | `@anthropic-ai/claude-agent-sdk` | Yes (npm) |
| Agent definitions & MCP configs | `@anthropic-ai/claude-agent-sdk` | Yes (npm) |
| Permission system | `@anthropic-ai/claude-agent-sdk` | Yes (npm) |
| Settings interface | `@anthropic-ai/claude-agent-sdk` | Yes (npm) |
| Transcript parsing utilities | `constellos/claude-code` `shared/` | No |
| Plugin structure types | `constellos/claude-code` | No |
