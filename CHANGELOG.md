# Changelog

All notable changes to GenesisTools will be documented in this file.

Version format: `YYYY.MM.DD.revision` (e.g., `2026.02.18.1`)

## 2026.04.29.1

### doctor (NEW)
- Added `tools doctor` — macOS dev-machine diagnostic CLI with TUI (OpenTUI/Solid) and plain modes
- 12 analyzers: battery, brew, dev-caches, disk-space, memory, network, processes, security, startup, system-caches, plus core/remaining
- Findings drawer, prompt host, executor with safety guards + timeouts, history cache, JSON/log/plain renderers
- Generic + per-analyzer view registry, status strip, modal/toolbar/error boundary

### cmux (NEW)
- Added `tools cmux profiles save / view / restore / list / delete / edit / path` for terminal-multiplexer state snapshots
- Snapshots cwd, env, shell, and history via shell-probe; restore-tree planner with focus guard
- Programmable socket transport with cmux protocol types

### todo (NEW)
- Added `tools todo` — project-scoped task management for LLM workflows (#142)
- add / edit / list / sync / done commands with TodoStore, link parsing (URL/PR/issue), reminder time parsing
- Calendar/Reminders sync via DarwinKit; `--at` flag for explicit event time
- Fixed 4 sync bugs: one calendar event with multiple alerts (was N events), URL pass-through to event, alert offsets computed from reminder times (was hardcoded 10 min), reliable Reminders via DarwinKit
- `syncTodo` now returns `SyncResult` with per-target outcomes; `SYNC_FAILED` lines + non-zero exit on failure

### indexer (NEW MAJOR)
- Added end-to-end code/document indexer with FTS5 BM25 + vector search, Merkle hashing, AST chunker (#117)
- Hybrid search drivers: sqlite-vec ANN and Qdrant; RRF fusion 3× over-fetch with min-score threshold
- 16 AST languages with chunking overhaul (overlap, 2000-char cap, minified detection, merge/sub-chunk)
- 3-phase streaming pipeline raised throughput from ~8/sec to ~300/sec; resumable sync, batch embedding (32/req), task prefixes, parallel file I/O
- MCP server for AI assistant access; per-mode search stats; pretty/simple/table search formatters with confidence + highlighting
- Kotlin/Scala/C# imports, circular-dependency detection, rich Mermaid graphs, CoreML batch, Google provider, graph persistence, tsconfig aliases
- `.genesistoolsignore`, infrastructure-aware watcher backoff, context artifacts, auto-resume
- AST grammars install on-demand (saves ~658 MB) — selective, interactive prompt, in-flight Promise dedup
- Search backend: sqlite-vec ANN, Qdrant hybrid, `migrate-vec`, IndexerStorage, ModelRegistry, benchmark integration
- Critical safety: lock ordering, `shouldRetry`, DarwinKit alignment, Ollama dimensions, watcher events
- Verify command, xxHash64, guardrails, date filtering, sync command, store routing fixes
- Search output redesign + Qdrant Docker (#136), GPU-first embedding, Ollama auto-pull, interactive remove, model selector

### mail (NEW)
- Added Apple Mail indexing — incremental sync, emlx extraction, DarwinKit auto-select (#117)
- FTS/hybrid search with FTS5 native `snippet()` excerpts; account listing, show with pagination, monitor command, columns selection, multiple output formats (#131)
- Opens Envelope Index directly (avoids EPERM copy on macOS); helpful error message on Full Disk Access denial

### ai (NEW)
- Added `tools ai` CLI — translate, summarize, classify, models, config
- Unified `AIConfig`, `AIAccount`, resolver registry, `ProviderManager`, `ChatEngine`, with config migration
- ModelRegistry replaces hardcoded maps; cache detection and default model management
- OpenAI Codex / ChatGPT subscription support via WHAM backend — `OpenAISubResolver`, `CodexOAuthClient` PKCE, import from `~/.codex/auth.json` or browser auth
- Live WHAM `/models` endpoint instead of stale `KNOWN_MODELS`; `store=false` provider option for openai-sub
- Auto-detect openai-sub accounts in provider discovery; bare `--provider` opens interactive picker
- Added GPT-5.x, gpt-5.3-codex, o3, o3-mini, o4-mini to `KNOWN_MODELS`
- Ollama LLM chat for summarize and translate; retry wrappers for Transcriber/Summarizer/Translator
- HuggingFace stack on-demand install (saves ~4.5 GB) with shared `ensureHuggingFaceTransformers()` helper
- Shared `embedding-selection.ts` utility (provider detection + interactive model selection)
- Diarization + word-timestamp options on `TranscribeOptions`; `Embedder.dimensions` from ModelRegistry
- WhisperTextStreamer progress, corrupt-cache retry, warning suppression
- `embedBatch()` on Cloud, Local, DarwinKit, Ollama, CoreML providers + retry with backoff
- Fixed: required `instructions` field for WHAM Responses API; stale OpenRouter default model ID; Codex auth.json official-CLI format; infinite fallback loop in TranscriptionManager

### ask
- Added @file mention expansion for inline file context
- Added Read, Grep, Bash tools for file access and shell execution
- Added /context, /tools, /history, /system chat commands
- Added markdown rendering for streaming output via mdast → terminal
- ⏺ Claude-Code-style icon for tool signatures; suppressed websearch chatty logs; blank lines between tool blocks
- `ConversationManager` storage moved to `~/.genesis-tools/ask/conversations/` (was cwd-relative)
- Routes streaming output through agents `TerminalRenderer` (`AskStreamRenderer` bridges ChatEvent → FormattedBlock)
- Provider creation delegated to resolver registry

### claude / claude-history / cc
- Added Sessions tab + History fix + commit search fix (#137)
- Added `tail --list-sessions` + Claude-Code-style formatter (#132); display agent progress events in tail output (#120)
- Added `cc tail` for live session/agent output streaming (#113)
- Added `claude export` — full/mini/raw formats, file output, include spec, project filtering
- Added warmup service, multi-account usage, memory command, AIConfig integration
- claude-history-dashboard: glass-card UI with sidebar, markdown rendering, syntax highlighting; pages and Tailwind v4 fixes
- 429 bypass via token refresh + poll coordination (#82)
- Auto-refresh history/rates + scroll fix (#78); preserve account order + plan label fix (#83)
- Optimized `--commit` search speed (#85)
- Subscription OAuth + tail enhancements (#129)

### reas
- Added React dashboard — routes, components, Vite config (#147)
- Added API clients, data layer, analysis, and core lib
- Added `backfill` subcommand for historical sold listings
- Added unit and E2E test suites

### timely
- Added `create` command — generate time entries from auto-tracked memories (plan/apply, #155)
- Added `categorizer`, `event-corpus`, `plan-build`, `plan-apply`, `flatten-memories` utilities
- Added `dayOfWeek` to Timely entries

### clarity
- Added granular 3-section StatusCard (Clarity PPM, Azure DevOps, TimeLog)
- Added Settings page with ADO configure (URL paste), TimeLog configure (auto-fetch API key + team-member picker), Clarity auth (cURL paste)
- Added timesheet notes — comment popup + mandatory post-fill review dialog with weekly summary builder (Czech day names, grouped by date)
- Added `granular-status`, `configure-ado`, `configure-timelog-key`, `configure-timelog-user`, `team-members` API routes
- Carousel forward navigation for last partial week (offset +1) + DRY `parseCarouselEntry` helper
- Date shift fix: `parseUTCDate()` strips time to avoid UTC/local off-by-one
- Work item links use org URL instead of orgId GUID
- Compute `clarityTotalMinutes` from all timesheet entries (was ADO-matched only)
- Show Clarity-only tasks; handle inaccessible work items; surface enrichment errors in API response
- Vite SSR `watchExternalDirs` plugin for server-side hot-reload; smaller work-item title font; fixed Status column width
- Czech date format fix; allow initial setup from UI (no CLI required); orgId auto-derive

### azure-devops
- Team-member picker replaces manual GUID entry in timelog configure
- Real org GUID from `connectionData` endpoint with api-version 5.0-preview (7.1 returns 400)
- Extracted reusable ADO/TimeLog config lib (`lib/ado-configure.ts`, `lib/timelog-configure.ts`) so CLI and Clarity UI share logic

### macos
- Added `tools macos voice-memos` with SQLite reader and ONNX device detection
- Added iMessages database, contacts resolution, and CLI commands
- Added `tools reminders` (list / search / add / remove) and `tools calendar` (list / search / add / update / delete) with full DarwinKit/EventKit CRUD
- Migrated to `@genesiscz/darwinkit` package (#100), bumped to 0.7.4 (#152)
- Rewrote Calendar/Reminders utils — DarwinKit replaces JXA; extracted shared JXA helpers for apple-notes
- Added `runDarwinkitGuarded` wrapper with per-request timeouts, disconnect/error rejection, diagnostic-report + stderr capture, surfacing `DarwinkitTimeoutError` / `DarwinkitCrashError` instead of hangs

### transcribe / youtube
- Added `tools transcribe` CLI with multi-provider support
- Added `tools youtube transcribe` with captions and audio fallback
- Pipeline polish, LLM gating, usage tracking, UTC timestamps

### say / notify / timer
- Added `tools say` with volume, dynamic voices, speak alias
- Added `tools notify` with terminal-notifier support
- Added `tools timer` with countdown, pomodoro, notify/say integration
- Added multi-channel notification system with dispatcher (`utils/notifications`)

### daemon
- Added scheduler `--notify` flag, `restart` command, launchd-aware `stop`

### benchmark
- Added `tools benchmark` with hyperfine integration
- Added `show`, `edit`, `history`, `--cwd`, `--env`, complete hooks, modular structure (#140)

### port
- Enhanced listings, commands, and polish internals

### zsh
- Added `tools zsh` shell enhancement manager (#103)
- Tab completion; fixed notify escaping and `...` recursion

### darwinkit
- Added interactive CLI tool for DarwinKit (#104)

### cursor
- Added `tools cursor` wrapping Cursor Agent CLI with stream-json NDJSON parser
- Defaults to `--mode=ask` with live streaming; `--raw` for clean output
- Routes through `TerminalRenderer` for colorized tool calls

### github
- Added Actions billing analysis — workflow runs, costs, billable minutes, failure waste, cross-repo scanning, run management (#106)
- Worktree integration for review/pr commands (#128)
- Replaced `--save-locally` with `--save [path]`
- Added commit URL support to `tools github get` (#81)

### update / raycast / shell-fix
- update: install/update marketplace; discard `bun.lock` before `git pull` to avoid merge conflict
- raycast: bash command fix script (#139); fixed paste command
- shell-fix: preserved quoted newlines and command-group separators (#148)

### Plugins / Skills / Commands
- Renamed plugin prefix `genesis-tools:` → `gt:` and expanded README (#115)
- Added `gt:research` skill with MCP-availability protocol (and PR #153 review fixes)
- Added `genesis-tools:explore` agent (#84)
- Added `genesis-tools-server` security audit plugin with `security-audit-linux-server` command (#101)
- Added `/question` answer-only mode (already in 03.03 entry; refined here)
- Refactored genesis-tools skills, commands, and descriptions (consolidated SKILLs into commands/)
- Optimized trigger descriptions for 4 plugin skills
- Added writing-plans, debugging-master skills (session reuse, LAN IP, server sharing #138)
- Telegram conversation memory + assistant v2 (#77); routes notifications through dispatch system

### agents (UI framework)
- Added unified formatter layer with terminal and web renderers
- Added React UI components for session rendering with dark theme
- `ClaudeSessionFormatter` wraps the new format pipeline; reuses `session-helpers`

### UI framework / shared components
- "Wow" theme + custom components + theme-aware Card (#147)
- Added shared shadcn components (alert-dialog, alert variants, textarea), graphs, dashboard layout
- Consolidated sub-package deps into root `package.json` to eliminate duplicate React; pinned react/react-dom to exact 19.2.0 then aligned to 19.2.5
- Added `PROJECT_ROOT` constant in `utils/paths.ts`; `--strictPort` for clarity vite spawn

### search (utils)
- `SearchEngine` with `VectorStore` / `TextStore`, pluggable `IndexerSource`, `MailSource`, `TelegramSource`
- Added `Embedder` task class shared across mail/indexer (#112)
- FTS5 native `snippet()` propagated through `SearchResult` / `IndexStore` / `searchIndexReadonly` for context-aware excerpts
- ModelRegistry, LanceDB

### prompts (utils)
- Added zsh-style file-path input with tab completion
- Voice-memos interactive transcribe UX with shared prompts
- Added `prompts/p/` backend abstraction (clack, opentui) with `offer-install` flow
- Replaced `@inquirer/prompts` with clack `searchSelect` to avoid signal-exit crash (#102)

### utils infrastructure
- Atomic config update, `Stopwatch`, `formatBytes`, lazy logger binding
- Locale-aware `formatDateTime()` with system locale detection (`utils/date`)
- Shared `ApiClient`, cache utility, lazy logger binding (`utils/tools`)
- Added on-demand package installer (`isPackageInstalled` / `ensurePackage` / `ensurePackages`) with rejection-list persistence and TTY prompt
- Replaced `JSON.parse/stringify` with `SafeJSON` (json5/comment-json) (#95)
- Storage: throw on corrupt config instead of silently returning null
- `parseVariadic` moved into `cli/` to unblock `Executor` export

### dependency hygiene
- Removed dead deps: eslint stack, diff2html, md-to-pdf, node-notifier
- Removed react-devtools (Electron app, saves ~451 MB)
- Vector DB clients install on-demand (saves ~206 MB)
- HuggingFace ML stack on-demand (saves ~4.5 GB)
- AST grammars on-demand (saves ~658 MB)

### Windows
- Windows compatibility for azure-devops, clarity, shared utils (#123)
- `install.sh`: setx/PowerShell PATH on Git Bash/MSYS2/Cygwin, stale-path replacement
- `tools.cmd`: CMD/PowerShell wrapper for tool invocation
- `.gitattributes`: enforce LF for `*.sh`/`tools`, CRLF for `*.cmd`/`*.ps1`
- Avoid leading semicolon when user PATH is empty
- cURL DevTools step-by-step instructions for non-technical users; orgId auto-derive

### Tests / CI
- Added E2E test suite and unit tests for all new tools
- Pre-commit hook now mirrors CI checks (biome + tsgo)
- Added type stubs for on-demand packages so tsgo accepts dynamic imports
- Indexer E2E pipeline, SearchEngine integration, Qdrant hybrid, watcher debounce, chunker edge cases, graph cycles
- ASK websearch tests, AIChat retry tests, todo sync tests, darwinkit guard tests

### Fixes
- mcp-manager: pass `space` param in strict `SafeJSON.stringify`; non-TTY guard (#127)
- ask: use `.chat()` for OpenAI v5+; enable file logging (#86)
- claude-usage: prevent OAuth token loss on crash (#75) — atomic persistence + keychain fallback
- Clarity SSR/Vite fixes; date utils; robust auth handling; routeTree generation
- Externalize `bun` in Vite config + `notFoundComponent` for clarity root
- Upgraded `signal-exit` to v4 to fix Bun ESM resolution for `foreground-child`
- Resolved all biome lint/format errors and TypeScript errors across codebase

### docs (CLAUDE.md)
- Documented `SafeJSON` requirement (`JSON` is biome-restricted); strict/jsonl modes

## 2026.03.03.1

### clarity
- Added Clarity PPM integration with `tools clarity` CLI (configure, timesheet, fill, link-workitems, ui)
- Added web dashboard with cyberpunk theme (export, import/fill, mappings, settings pages)
- Added cURL-based auth extraction, timesheet CRUD, and ADO-to-Clarity work item linking
- Added fill command for importing ADO timelog hours into Clarity timesheets with dry-run preview

### claude
- Added interactive Ink TUI dashboard for usage monitoring with 4 tabs (Overview, Timeline, Rates, History), SQLite persistence, rate calculation, and macOS notifications
- Fixed OAuth token loss on crash — tokens now persisted atomically with file lock immediately after refresh
- Added keychain fallback recovery for permanently invalid refresh tokens

### daemon
- Added general-purpose background task scheduler with interval scheduling, retry on crash, JSONL log capture, macOS launchd integration, and interactive clack UI

### azure-devops
- Added `--images` flag to download inline images from work item descriptions and comments, with local path rewriting in generated markdown
- Added `timelog export-month` library function and CLI command
- Added cached work item enrichment service with type definitions

### watchman
- Added `--temporary` flag to auto-unwatch paths on process exit

### migrate-to-codex
- Overhauled scope detection, plugin directory symlinks, and namespace handling
- Improved edge case handling for plugin migration

### UI Framework
- Extracted shared UI component library (`src/utils/ui/`) from claude-history-dashboard
- Added `createDashboardApp` factory, `DashboardLayout`, base Vite config factory, and `@ui/` alias
- Migrated claude-history-dashboard to shared UI framework and TanStack Start server routes

### Skills & Commands
- Added `/question` command for answer-only mode with refinement loop
- Added writing-plans skill
- Added living-docs parallel dispatch documentation
- Moved debugging-master skill into genesis-tools plugin

### json
- Improved format detection matching

### Core
- Added Clarity PPM API client, type definitions, and comprehensive API/auth documentation
- Added cURL command parser utility for cookie/header extraction
- Resolved all TypeScript errors across codebase
- Resolved all Biome lint/format errors and added pre-commit hook
- Added shared Ink component library (`src/utils/ink/`) with reusable UI components and hooks

## 2026.02.26.3

### ask (AIChat SDK)
- Added `AIChat` programmatic SDK for provider-agnostic LLM chat with session management, streaming, and persistence
- Added `ChatTurn` class that is both awaitable (buffered) and async-iterable (streaming)
- Added `ChatSession`, `ChatSessionManager`, `ChatEvent`, `ChatLog` library components with full test coverage
- Refactored CLI single-message mode to use AIChat — removed stdout monkey-patching

### telegram
- Fixed stdout leakage by replacing subprocess calls with in-process AIChat

### azure-devops
- Added automatic Remaining/Completed Work updates after logging time

## 2026.02.26.2

### Skills
- Added git-rebaser skill

## 2026.02.26.1

### ask
- Migrated to @clack/prompts and picocolors

### claude
- Added unified CLI with usage monitoring and multi-account config
- Added OAuth login and watch mode notification rewrite
- Added `migrate-to-codex` command

### telegram
- Added Telegram MTProto client with history and semantic search
- Added Telegram bot with macOS Mail tool and automation framework

### github-pr
- Added analysis report with Explore agents before thread selection

### github
- Fixed review reply truncation, added PR-level comments and author filter
- Preferred `gh` CLI token for `resolveReviewThread`

### Skills & Tools
- Added debugging-master skill
- Migrated 8+ tools to Executor pattern
- Added comprehensive unit tests for `src/utils/`

### azure-devops
- Fixed infinite loop in reporting API pagination
- Split utils into domain modules

### Core
- Tightened Biome lint rules
- DRY consolidation of shared utilities

## 2026.02.18.1

### github
- Added repository search with `--type repo`
- Added notifications and activity feed with browser utility
- Added auto-fallback for `resolveReviewThread`

### claude-history
- Added `summarize` subcommand with 7 LLM-powered modes

### azure-devops
- Added history activity command with cache refactor

### claude-skill-to-desktop
- Added new tool to sync skills to desktop apps

### Tools Browser
- Added interactive tools browser with markdown-cli enhancements

### Skills
- Added delegate PR review replies to background haiku agent

## 2026.02.15.1

### har-analyzer
- Added new HAR analyzer tool

### Core
- Added JSON schema inference utility (`src/utils/json-schema.ts`)

### github
- Enhanced review tool

### claude-history
- Added full metadata extraction, ripgrep search, and auto-reindex

### azure-devops
- Added batch work item downloads and `buildUrl` utility

## 2026.02.13.2

### github
- Added consolidated PR review system

### claude-resume (cc)
- Added session finder tool

## 2026.02.13.1

### azure-devops
- Added work item attachment listing and download
- Added batch API with parallel comments fetching
- Added unified `getWorkItems` function

### github
- Overhauled reactions system — generic sums, split body/comment filters, search support

### timelog
- Added 3-tier child prioritization and cross-work-item queries
- Added delete command

### timely
- Added `--force` cache bypass
- Added `--since`/`--until` aliases

### markdown-cli
- Added new tool for rendering markdown to terminal

### Core
- DRY consolidation of shared utility modules
- Biome linter setup

## 2026.02.07.1

### azure-devops
- Added work item history tracking with WIQL queries

### timelog
- Added natural language time logging
- Added Timely sync skill

### timely
- Added memory caching, day-grouped output, and app name resolution

## 2026.02.06.1

Internal improvements only.

## 2026.02.04.1

### azure-devops
- Added full timelog system: configure, list, types, add, import, interactive mode
- Migrated to Commander subcommands
- Added query name resolution with fuzzy matching
- Increased cache TTL

### git-rebranch
- Added new tool for branch rebasing workflows

### git-rebase-multiple
- Added conflict detection, git pull, and divergence detection

### github
- Added advanced search with deduplication
- Added code search and issue/PR search
- Added pagination for >50 comment threads in PR reviews

### rohlik-spending
- Added new command

### react-compiler-debug
- Added AST prettification with `--with-original` flag

### mcp-manager
- Added config-json, env/headers, non-interactive mode, and safe writing with preview

### mcp-web-reader
- Added pluggable engine system with ReaderLM support

### claude-history
- Added session ID support, relevance scoring, advanced filters
- Added SQLite caching and dashboard with analytics

### json
- Added passthrough for invalid input

### Core
- Migrated all tools from enquirer/minimist to @inquirer/prompts + Commander
- Added `--readme` flag for all CLI tools
- Added @clack/prompts and picocolors
- Set up Biome linter/formatter
- Various type safety and ReDoS fixes

## 2026.01.11.1

### Initial Release
- Added `azure-devops` skill for work item management
- Added `claude-history` tool and skill for conversation search
- Added `github-pr` command for PR review workflows
- Added `jenkins-mcp` server
- Added `setup` command for installation
- Added Raycast `kill-port` extension
- Added Claude Code marketplace plugin infrastructure
