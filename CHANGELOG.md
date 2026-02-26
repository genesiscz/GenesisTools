# Changelog

All notable changes to GenesisTools will be documented in this file.

Version format: `YYYY.MM.DD.revision` (e.g., `2026.02.18.1`)

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
