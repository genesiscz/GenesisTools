# 🌟 GenesisTools

<div align="center">

  <a href="https://deepwiki.com/genesiscz/GenesisTools"><img src="https://img.shields.io/badge/DeepWiki-AI_Docs-blue?style=for-the-badge&logo=readthedocs&logoColor=white" alt="DeepWiki" /></a>
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white" alt="Bun" />
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge" alt="MIT License" />

  <h3>One <code>tools</code> command, 97 self-contained CLIs.</h3>

  <p>
    <strong>A personal-scale toolkit for AI-assisted development: LLM plumbing, agent orchestration,
    git surgery, MCP server management, macOS automation, and time tracking.</strong>
  </p>

</div>

---

## 📚 Table of Contents

-   [What this is](#what-this-is)
-   [🚀 Quick Start](#-quick-start)
-   [🧭 How the CLI works](#-how-the-cli-works)
-   [🎯 Claude Code plugin](#-claude-code-plugin)
    -   [Commands](#commands-4)
    -   [Skills](#skills-24)
    -   [Agents and hooks](#agents-and-hooks)
    -   [The genesis-tools MCP server](#the-genesis-tools-mcp-server)
    -   [Second plugin: genesis-tools-server](#second-plugin-genesis-tools-server)
-   [🛠️ Tool catalogue](#️-tool-catalogue)
    -   [AI and LLM](#ai-and-llm)
    -   [Agents and AI coding sessions](#agents-and-ai-coding-sessions)
    -   [Git and code history](#git-and-code-history)
    -   [GitHub and CI](#github-and-ci)
    -   [MCP servers and tooling](#mcp-servers-and-tooling)
    -   [Frontend and web debugging](#frontend-and-web-debugging)
    -   [Work tracking and time](#work-tracking-and-time)
    -   [Web dashboards and data](#web-dashboards-and-data)
    -   [macOS and system](#macos-and-system)
    -   [Processes and terminals](#processes-and-terminals)
    -   [Scheduling, automation, notifications](#scheduling-automation-notifications)
    -   [Shell and small utilities](#shell-and-small-utilities)
    -   [Not user-facing](#not-user-facing)
-   [💡 Flagship tools in detail](#-flagship-tools-in-detail)
-   [🗂️ Where things are stored](#️-where-things-are-stored)
-   [🌐 Web servers and ports](#-web-servers-and-ports)
-   [🧪 Development](#-development)

---

## What this is

GenesisTools is a TypeScript monorepo that Bun executes directly, with no build step. Every tool
lives in its own folder under `src/` and runs in its own process. The `tools` executable is the
only entry point you need.

The catalogue below is taken from what actually exists in this checkout: 100 discoverable
entries, of which `src/utils` is the shared package barrel (`@genesiscz/utils`, not a runnable
tool) and `src/Internal` plus `src/t3chat-length` are private. That leaves **97 usable tools**.
Running `tools` with no arguments prints the same total of discovered entries in its header.

---

## 🚀 Quick Start

### Prerequisites

> 📌 **Bun is required.** Many tools use Bun-only APIs (`Bun.spawn`, `Bun.file`, `bun:sqlite`),
> so Node.js is not a substitute.

```bash
curl -fsSL https://bun.sh/install | bash
```

### Installation

```bash
git clone https://github.com/genesiscz/GenesisTools.git
cd GenesisTools

bun install && ./install.sh
```

`install.sh` checks for Bun, installs dependencies if `node_modules` is missing, then puts the
repo on your `PATH`. On macOS and Linux it appends its lines to `~/.zshrc` and `~/.bashrc`. On Windows
(Git Bash, MSYS, Cygwin) it sets `GENESIS_TOOLS_PATH` and extends the user `PATH` via `setx`
and PowerShell.

Reload your shell afterward:

```bash
source ~/.zshrc    # zsh
source ~/.bashrc   # bash
```

### First command

```bash
tools
```

That opens the Tools Browser: a searchable list of every tool, with per-tool actions
(run, view README, list subcommands, copy the command to the clipboard).

### Staying current

```bash
tools update       # git pull, bun install with a clean retry, optional plugin refresh
```

---

## 🧭 How the CLI works

**Discovery.** `tools` scans `src/` and treats as a tool:

-   any directory containing `index.ts` or `index.tsx` (tool name is the directory name),
-   any standalone `.ts` or `.tsx` file directly in `src/` (tool name is the filename).

Nothing is registered by hand, so adding a folder with an `index.ts` adds a tool.

**Invocation.**

```bash
tools                       # interactive browser
tools <name> [args...]      # run a tool
tools <name> --help         # commander help for that tool
tools <name> --readme       # print the tool's README.md, when it ships one
tools <name> -v             # promote debug logging to the console
tools <partial-name>        # fuzzy match, then pick from a shortlist
```

Two tools live as loose scripts inside a folder without an `index.ts` and are addressed by
path instead of by name:

```bash
tools hold-ai/server        # WebSocket hold/release server
tools hold-ai/client        # the client an AI calls to block on your input
```

**Global flags** are added by the shared `runTool` wrapper, so they exist on every commander
entrypoint: `-v, --verbose`, `--readme`, `-h, --help`. Tools that opt in also accept `--trace`
(and `-vv` as a shorthand).

**Output contract.** `out.result()` and `out.print()` are the only writers to stdout, so piping
a tool's machine-readable output is always safe. Diagnostics, spinners, prompts, and status
lines go to stderr. Every run also appends structured JSON to a day-stamped log file.

**Recovery.** If a tool dies with a module-resolution error (a stale or partial
`node_modules`), the wrapper recognises the error shape and offers to run `bun install` for
you. Set `TOOLS_SKIP_AUTOINSTALL=1` to suppress that.

---

## 🎯 Claude Code plugin

The repo ships two Claude Code plugins through the marketplace file at
`.claude-plugin/marketplace.json`. The main one, `genesis-tools` (currently version 1.0.43),
contains **4 commands**, **24 skills**, **2 subagents**, **4 hook registrations**, and a stdio
**MCP server**.

Commands are invoked explicitly as `/gt:<name>`, which comes from each command file's own
`name:` frontmatter. Skills load themselves when the conversation matches their trigger
description, and they resolve by plugin and directory (`genesis-tools:<skill>`), so the `gt:`
prefix that 14 of the 24 skill files still carry in their frontmatter has no effect on how they
are addressed.

### Installation for Claude Code

Add this repository as a plugin marketplace, then install the plugin:

```
/plugin marketplace add genesiscz/GenesisTools
/plugin install genesis-tools
```

Because the plugin is installed from the GitHub remote, local edits to `plugins/` only take
effect after you push and run `/plugin update`.

### Commands (4)

| Command | Argument hint | What it does |
|---------|---------------|--------------|
| `/gt:setup` | `[optional: setup details]` | Install GenesisTools so `tools` works globally. Checks Bun, asks where to clone, runs `install.sh`, verifies. |
| `/gt:github-pr` | `<pr-number-or-url> [-u] [-w] [--save] [--open] [--open-only]` | Fix PR review comments: fetch threads, verify each claim against the source, pick which to fix, implement, commit, reply. |
| `/gt:automate` | `[run\|list\|show\|create] [name-or-args]` | Build or run multi-step `tools` CLI automation presets. |
| `/gt:timelog` | `[date or range]` | Sync Timely to Azure DevOps time logs, then fill Clarity PPM timesheets. |

`/gt:github-pr` also handles multiple PRs in one invocation: pass several URLs and it works
them in parallel, writes a per-PR plan, and presents one consolidated report.

`/gt:automate` and `/gt:timelog` are deliberately commands rather than skills. Their guidance
is large, and as skills they would load into sessions that never needed them.

### Skills (24)

| Skill | What it does |
|-------|--------------|
| `agents-talk` | Cross-agent messaging protocol via `tools agents`. Invoke before spawning subagents that must talk to each other. |
| `analyze-har` | Token-efficient HAR analysis. The rule it enforces: never `cat` or `jq` a HAR file. |
| `azure-devops` | Work items, queries, dashboards. Defers time logging to `/gt:timelog`. |
| `claude-history` | Find a past Claude Code conversation by topic, file, or date. |
| `debugging-master` | Hypothesis-driven runtime debugging with temporary, auto-cleanable instrumentation (Node/TS, PHP, browser). |
| `git-rebaser` | Cascade rebase for a parent branch plus the children stacked on it, using `git rebase --onto`. |
| `github` | Read or search GitHub, and analyze GitHub Actions runs, failures, and billing. |
| `handoff-to` | Offload work to another model or agent and pick which one (Codex/GPT, sonnet, opus, fable). |
| `handoff-to-codex` | Hand a review or implementation to Codex and drive the session: spawn, steer, approve, verify. |
| `improve-agents-md` | Empirically evaluate and trim `CLAUDE.md` / `AGENTS.md` by testing which rules a clean model already follows. |
| `living-docs` | Self-maintaining docs system: bootstrap, validate, refine minimal doc chunks. |
| `macos-control` | Drive native macOS apps through the Accessibility API, and record short screen captures reviewed frame by frame. |
| `mcp-scripting` | Call MCP tools from a plain TypeScript script via `tools scripts`, with types generated from each server's live `tools/list`. |
| `plan-it` | Write implementation plans hardened with an executor-proof contract, so a weaker model can execute them. |
| `question` | Answer a question, then preserve the question and answer for later review. |
| `react-compiler-debug` | Inspect `babel-plugin-react-compiler` output and explain memoization decisions. |
| `research` | Answer questions that need information from outside the local codebase. |
| `stash` | Save, apply, and unapply named code overlays across projects with `tools stash`. |
| `summarize` | Summarize a Claude Code session into learnings, a postmortem, a changelog, or onboarding docs. |
| `task` | Run long-lived interactive commands (dev servers, Metro, Vite) with PTY capture and an agent-friendly log tail. |
| `timely` | Turn a day of Timely auto-tracked memories into time-log entries via a plan/apply workflow. |
| `todo` | Task tracking for the current session through `tools todo`. |
| `typescript-error-fixer` | Fix TypeScript compile errors and eliminate `any`, one agent per file. |
| `wrap-up` | Write the state doc that lets a fresh agent resume cold: an Obsidian wrap-up or a repo handoff. |

### Agents and hooks

Two subagents ship with the plugin:

-   **`agent-driver`** drives one external worker session end to end (spawn, watch, steer,
    resolve approvals, verify, tear down) so the worker's event stream stays out of the
    orchestrator's context. One instance per worker session.
-   **`explore`** does deep codebase exploration and writes a persistent report, so findings
    survive the subagent exiting.

Four hook registrations in `plugins/genesis-tools/hooks/hooks.json`:

| Event | Script | Purpose |
|-------|--------|---------|
| `SessionStart` | `track-session-files.ts` | Start the per-session record of modified files. |
| `SessionStart` | `agents-talk-hint.ts` | Remind the agent to invoke `agents-talk` before spawning subagents that need to communicate. |
| `SessionStart` | `record-session-account.ts` | Record which Claude account the session is billing. |
| `PostToolUse` (`Edit\|Write\|MultiEdit`) | `track-session-files.ts` | Append each edited file to that session's record. |

The session file record lands in
`~/.genesis-tools/claude-code/sessions/<session-id>.json`, which is what makes
"commit only the files you touched this session" possible.

### The genesis-tools MCP server

```bash
tools claude mcp        # stdio MCP server
```

It registers **27 tools across 4 capability groups**:

| Capability | Tools | Purpose |
|------------|-------|---------|
| `question_answer` | `question_answer` | Capture a question and your complete answer to the local question store, reviewable later with `tools question log` / `tools question tail`. |
| `handoff` | `handoff_post`, `handoff_get`, `handoff_list`, `handoff_action` | Cross-agent task handoff: post a task list, claim it, check items off with proof, finish. |
| `annotate` | `annotate_image` | Annotate an image (arrows, boxes, labels) for review. |
| `boards` | 21 `boards_*` tools | Dev-dashboard annotation boards: create and compose boards, push screenshot sets, list and answer work, wait for new annotations. |

All four groups are enabled when `GENESIS_TOOLS_MCP_CAPABILITIES` is unset. Set it to a
comma-delimited list of capability names to restrict registration, for example in
`~/.claude.json` under `mcpServers.genesis-tools.env`:

```bash
GENESIS_TOOLS_MCP_CAPABILITIES=question_answer,handoff   # only these two groups
GENESIS_TOOLS_MCP_CAPABILITIES=boards                    # only the boards tools
```

> ⚠️ The `tools claude mcp --help` string still says "exposes question_answer + boards". The
> registry is the authority, and it registers all four groups.

### Second plugin: genesis-tools-server

`genesis-tools-server` (version 1.0.0, category `security`) ships exactly one command:
a comprehensive Linux server security audit that analyzes logs, detects attack patterns,
identifies malicious IPs, checks security tool status, runs malware and rootkit scans, and
generates the matching `fail2ban` commands.

---

## 🛠️ Tool catalogue

Every row is a real tool in this checkout, described from its own `--help`. Each name links to
that tool's own `README.md`, which you can also print in the terminal with
`tools <name> --readme`. All 97 usable tools ship one.

### AI and LLM

| Tool | What it does | Key subcommands |
|------|--------------|-----------------|
| [`ai`](src/ai/README.md) | Unified AI toolkit: translate, summarize, classify, generate images, manage accounts and models. | `translate` `summarize` `image` `classify` `models` `config` |
| [`ai-proxy`](src/ai-proxy/README.md) | OpenAI-compatible local proxy in front of Grok, GitHub Copilot, and other providers, with a client ledger. | `up` `down` `serve` `status` `models` `calls` `clients` `usage` `link` `config` |
| [`ai-spend`](src/ai-spend/README.md) | Claude Code token and cost analytics across every local session. | `summary` `sessions` `today` |
| [`ask`](src/ask/README.md) | Multi-provider LLM chat, one-shot or interactive, with optional audio input via `--sst`. | flags only (`-m`, `-p`, `-f`, `-o`) |
| [`usage`](src/usage/README.md) | Token and cost analytics for `ask`, by provider, model, and day. | flags only (`--days`, `--provider`, `--format`) |
| [`say`](src/say/README.md) | Text to speech with pluggable backends (macOS, xAI Grok, OpenAI) and per-app config profiles. | `voices` `models` `config` |
| [`transcribe`](src/transcribe/README.md) | Transcribe audio files with AI, locally or in the cloud. | flags only |
| [`darwinkit`](src/darwinkit/README.md) | Apple on-device ML from the terminal: NLP, embeddings, OCR, clustering, biometry, iCloud. | 40+ verbs, see `--help` |
| [`redact`](src/redact/README.md) | Reversibly redact secrets and PII from text before pasting it into an AI, then restore the reply. | `restore` |
| [`json`](src/json/README.md) | Convert between JSON and TOON (30 to 60 percent fewer tokens), or infer a schema. | `convert` (default) `schema` |
| [`json-schema`](src/json-schema/README.md) | Infer a skeleton, TypeScript interfaces, or JSON Schema from JSON on a file or stdin. | flags only (`-m`, `--pretty`) |
| [`mcp-web-reader`](src/mcp-web-reader/README.md) | Fetch a page and convert HTML to Markdown with pluggable engines. Works as CLI and MCP server. | flags only (`--engine`, `--mode`) |
| [`repo-map`](src/repo-map/README.md) | Token-efficient repo symbol map for agents, in the style of aider. | flags only |
| [`indexer`](src/indexer/README.md) | Semantic code indexer with AST-aware chunking and hybrid search. | `add` `search` `sync` `watch` `graph` `context` `mcp-serve` |

### Agents and AI coding sessions

| Tool | What it does | Key subcommands |
|------|--------------|-----------------|
| [`claude`](src/claude/README.md) | Everything around Claude Code: history, resume, accounts and OAuth, desktop sync, usage, MCP server, cmux restore. | `history` `resume` `tail` `summarize` `usage` `config` `login` `start` `mcp` `code` `cmux` `teams` `doctor` |
| [`cc`](src/cc/README.md) | Resume a Claude Code session by short ID, name, or content search. | (single command) |
| [`codex`](src/codex/README.md) | Spawn, monitor, and steer Codex app-server sessions. | `spawn` `steer` `read` `review` `approve` `deny` `tail` `sessions` |
| [`cursor`](src/cursor/README.md) | Ask Cursor Agent a question about the codebase and stream the answer, tool calls on stderr and answer on stdout. | flags only (`--mode`, `--model`, `--raw`) |
| [`cursor-context`](src/cursor-context/README.md) | Strip tool-use parameters and results from Cursor SpecStory exports to save tokens. | flags only |
| [`agents`](src/agents/README.md) | Cross-agent communication: register, message, request, discover, listen across a swarm. | `login` `message` `request` `discover` `listen` |
| [`agent-watch`](src/agent-watch/README.md) | Notify you when background agents finish, stall, or need input. | `watch` `status` `list` |
| [`boards`](src/boards/README.md) | Dev-dashboard annotation boards: push screenshot sets, create boards, listen for work. | `init` `add` `push` `board-from-set` `watch` `operator` |
| [`question`](src/question/README.md) | Capture and review the questions fired at agents mid-session, with their answers. | `record` `log` `tail` `config` |
| [`task`](src/task/README.md) | PTY-aware command wrapper with ordered log capture, built for long-lived dev servers. | `run` `get` `logs` `tail` `wait` `sessions` `dashboard` |
| [`scripts`](src/scripts/README.md) | Script MCP tool calls directly, with no agent loop, using types generated from each server. | `servers` `tools` `call` `create` `run` `regen` `remote` `doctor` |
| [`debugging-master`](src/debugging-master/README.md) | Instrumentation primitives plus a token-efficient log reader for runtime debugging. | `start` `get` `expand` `diff` `sessions` `cleanup` `dashboard` |
| [`stash`](src/stash/README.md) | Global cross-project code-overlay manager: save a chunk of working-tree changes and reapply it anywhere. | `save` `apply` `unapply` `list` `diff` `versions` `doctor` |
| [`learn-from-fable`](src/learn-from-fable/README.md) | Staged pipeline that distills Fable 5's working style from local session transcripts into the Fable Pack. | `bootstrap` `mine` `eval` `consolidate` `spec` `skill` |

### Git and code history

| Tool | What it does | Key subcommands |
|------|--------------|-----------------|
| [`git`](src/git/README.md) | Commit analysis: query commits by range, extract work-item IDs by regex, manage author identities, branch cleanup. | `commits` `configure-authors` `configure-workitem-patterns` `health` `branch-gc` `monster` |
| [`git-commit`](src/git-commit/README.md) | Generate commit messages with AI, optionally staging first and pushing after. | flags only (`--stage`, `--detail`) |
| [`git-last-commits-diff`](src/git-last-commits-diff/README.md) | Render diffs between recent commits, formatted for feeding to an AI. | flags only (`--commits`, `--output`, `--clipboard`) |
| [`git-rebase-multiple`](src/git-rebase-multiple/README.md) | Safe branch-hierarchy rebasing with backup refs, fork-point tags, and full rollback. | flags only (`--status`, `--dry-run`, `--abort`, `--continue`, `--cleanup`) |
| [`git-rebranch`](src/git-rebranch/README.md) | Split a messy branch into several clean branches by grouping commits. | flags only (`--dry-run`) |
| [`git-rename-commits`](src/git-rename-commits/README.md) | Interactively rename the last N commit messages, with a confirmation screen before the rewrite. | flags only (`--commits`) |
| [`last-changes`](src/last-changes/README.md) | Show uncommitted changes grouped by modification time, so you can see what you touched when. | flags only |
| [`collect-files-for-ai`](src/collect-files-for-ai/README.md) | Copy files changed in git (by commit count, staged, unstaged, or all) into a folder for AI context. | flags only (`-c`, `--staged`, `--flat`) |
| [`files-to-prompt`](src/files-to-prompt/README.md) | Turn a directory tree into one AI-friendly prompt (XML, Markdown, or plain), with filters. | flags only (`-e`, `--markdown`, `--cxml`, `--flat-folder`) |
| [`time-machine`](src/time-machine/README.md) | Auto-bisect a failing command across history to find the last green commit. | flags only |
| [`regret-grep`](src/regret-grep/README.md) | Warn when the current diff repeats a bug you already fixed. | `index` `check` |
| [`apoptosis`](src/apoptosis/README.md) | Programmed cell death for dead code: flag zero-signal files and suggest deletion after a grace window. | `status` `kill` `rescue` `reset` |
| [`loc`](src/loc/README.md) | Count files and code, blank, and comment lines by language, respecting `.gitignore`. | flags only |

### GitHub and CI

| Tool | What it does | Key subcommands |
|------|--------------|-----------------|
| [`github`](src/github/README.md) | Token-efficient GitHub client: issues, PRs, review threads, code search, notifications, activity, raw files, stack-safe merges. | `issue` `pr` `merge` `comments` `search` `code` `get` `review` `notifications` `activity` `status` |
| [`github-release-notes`](src/github-release-notes/README.md) | Fetch release notes from any GitHub repository into Markdown. | flags only (`--limit`, `--oldest`) |
| [`jenkins-mcp`](src/jenkins-mcp/README.md) | Jenkins CLI and MCP server: paste a job path or full Jenkins URL, read stages, logs, changes, and monitor the queue. | `stages` `log` `info` `changes` `jobs` `monitor` |

`tools github merge` exists specifically because `gh pr merge --delete-branch` closes the
children of a PR stack instead of retargeting them (`cli/cli#1168`). It retargets dependents
onto the merged base first, then optionally deletes the head branch.

### MCP servers and tooling

| Tool | What it does | Key subcommands |
|------|--------------|-----------------|
| [`mcp-manager`](src/mcp-manager/README.md) | Manage MCP servers across Claude, Gemini, Codex, and Cursor from one unified config, with backups and visual diffs. | `config` `sync` `sync-from-providers` `list` `enable` `disable` `install` `show` `remove` `rename` `backup-all` `config-json` |
| [`mcp-doctor`](src/mcp-doctor/README.md) | Health-check and benchmark the MCP servers you already have configured. | `list` `check` `tools` |
| [`mcp-debug`](src/mcp-debug/README.md) | Debug MCP server configuration by running commands and printing JSON to stdout plus diagnostics to stderr, so you can see the env, cwd, and PATH your client passes. | flags only (`--env`) |
| [`mcp-ripgrep`](src/mcp-ripgrep/README.md) | MCP server exposing ripgrep: search, advanced search, count matches, list files, list file types. | server only |
| [`mcp-tsc`](src/mcp-tsc/README.md) | TypeScript diagnostics as both a CLI and an MCP server, using the compiler API or a language server. | flags only (`--lsp`, `--warnings`, `--mcp`) |

### Frontend and web debugging

| Tool | What it does | Key subcommands |
|------|--------------|-----------------|
| [`har-analyzer`](src/har-analyzer/README.md) | Token-efficient HAR analysis with a reference system, progressive disclosure, security scan, waterfall, and PII redaction. | `load` `list` `show` `expand` `domain` `errors` `security` `waterfall` `diff` `export` `redact` `sessions` `mcp` |
| [`react-compiler-debug`](src/react-compiler-debug/README.md) | Inspect what `babel-plugin-react-compiler` generates, to see whether and why a component was memoized. | flags only (`--code`, `--with-original`, `--target`, `--mode`) |
| [`npm-package-diff`](src/npm-package-diff/README.md) | Diff two versions of an npm package: parallel install into temp dirs, then terminal, unified, HTML, JSON, or side-by-side output. | flags only (`--filter`, `--format`, `--patch`, `--use-delta`) |

### Work tracking and time

| Tool | What it does | Key subcommands |
|------|--------------|-----------------|
| [`azure-devops`](src/azure-devops/README.md) | Azure DevOps work items, queries, dashboards, and time logs, with caching and change detection. | `configure` `query` `workitem` `workitem-create` `list` `dashboard` `timelog` `history` |
| [`timely`](src/timely/README.md) | Timely time tracking: OAuth login, accounts and projects, events, auto-tracked memories, monthly exports. | `login` `status` `accounts` `projects` `events` `memories` `create` `export-month` `cache` |
| [`clarity`](src/clarity/README.md) | CA PPM Clarity timesheet management, filled from Azure DevOps time logs and Timely activity. | `configure` `timesheet` `fill` `link-workitems` `ui` |
| [`timer`](src/timer/README.md) | Focus timer with live countdown, background mode, Pomodoro cycles, and completion hooks. | `list` `cancel` |
| [`todo`](src/todo/README.md) | Task tracking for AI-assisted sessions, backed by SQLite, with a full status lifecycle. | `add` `list` `show` `start` `block` `complete` `reopen` `edit` `search` `sync` `export` `import` |

### Web dashboards and data

| Tool | What it does | Key subcommands |
|------|--------------|-----------------|
| [`dashboards`](src/dashboards/README.md) | Orchestrate every GenesisTools web dashboard at once. | `up` `down` `restart` `status` `list` |
| [`dashboard`](src/dashboard/README.md) | Start the personal productivity dashboard, installing its dependencies if needed, then open it. | `up` `down` `restart` `status` `attach` `logs` `open` `install` |
| [`dev-dashboard`](src/dev-dashboard/README.md) | Personal dev dashboard wiring ttyd, cmux, and Obsidian together, with auth, tunnel, and pairing. | `ui` `configure` `auth` `agent` `tunnel` `pair` `share` |
| [`youtube`](src/youtube/README.md) | The largest tool here: channels, videos, transcripts, downloads, summarisation, Q&A, a browser extension, a queue, and an MCP server. | `channels` `videos` `transcribe` `download` `pipeline` `queue` `ask` `analyze` `extension` `server` `ui` `mcp` `config` |
| [`shops`](src/shops/README.md) | Grocery, drogerie, and pharmacy price intelligence across Czech e-shops, with crawlers, matching, and a dashboard. | `get` `crawl` `sitemap-sync` `match` `list` `watch` `notify` `daemon` `db` `ui` `mcp` |
| [`instagram`](src/instagram/README.md) | Inspect public Instagram profiles, and fetch stories and highlights with your own session. | `profile` `highlights` `stories` `highlight` `session` |
| [`spotify`](src/spotify/README.md) | Spotify listening analytics from your own export, plus cross-library compatibility with a partner. | `profile` `analytics` `harvest` `build` `enrich` `history-merge` `export` `doctor` |
| [`tradingview`](src/tradingview/README.md) | Stream TradingView live quotes, indicators, charts, and scans. | `quotes` `alerts` `indicator` `charts` `indicators` `scan` |
| [`rohlik-spending`](src/rohlik-spending/README.md) | Total up your spending on rohlik.cz from delivered orders and line items. | flags only |

### macOS and system

| Tool | What it does | Key subcommands |
|------|--------------|-----------------|
| [`macos`](src/macos/README.md) | Umbrella CLI for macOS native frameworks. | `mail` `calendar` `reminders` `messages` `voice-memos` `sleep` `swap` `clones` `control` |
| [`control`](src/control/README.md) | macOS UI automation through the Accessibility API, plus screen recording with timed actions. | `list` `tree` `find` `click` `type` `hotkey` `scroll` `screenshot` `ocr` `capture` `record-plan` `assert` |
| [`macos-eslogger`](src/macos-eslogger/README.md) | Monitor macOS Endpoint Security events in real time with category and JSON-path filters. Needs root and Full Disk Access. | flags only (`-e`, `-c`, `--filter-event`) |
| [`macos-resources`](src/macos-resources/README.md) | Live TUI dashboard of process CPU, RAM, and open-file usage, with alert thresholds. | flags only (`--process`, `--cpulimit`, `--notify`) |
| [`doctor`](src/doctor/README.md) | Diagnose and fix common macOS dev-machine problems. | `find` `log` `stats` `wipe-cache` |
| [`du`](src/du/README.md) | Clone-aware disk usage for APFS. Measures the real on-disk footprint of trees full of clonefiles, where plain `du` lies. | `clonesize` `volume` `clones` `bench` |
| [`fsevents-profile`](src/fsevents-profile/README.md) | Profile filesystem events to find the directories generating the most churn. | flags only (`-d`, `-t`, `--watchers`) |
| [`watch`](src/watch/README.md) | Watch files matching a glob and show content changes in real time, like `tail -f` with patterns. | flags only (`-s`, `-f`, `-n`) |
| [`watchman`](src/watchman/README.md) | Monitor files through Facebook's Watchman for instant change detection. | flags only (`-c`) |
| [`wakeup`](src/wakeup/README.md) | Wake-on-LAN helper plus a small wake relay you can run on an always-on host. | `config` `server` `register` `login` `wake` `send` `daemon` |

> 🛑 `tools voice-memos` no longer exists as its own tool. Voice Memos moved under the macOS
> umbrella: use `tools macos voice-memos`.

### Processes and terminals

| Tool | What it does | Key subcommands |
|------|--------------|-----------------|
| [`port`](src/port/README.md) | Inspect, list, watch, and clean the processes owning local ports, with interactive kill. | `ps` `clean` `watch` |
| [`tmux`](src/tmux/README.md) | Inspect, create, reset, attach, and snapshot tmux sessions. | `attach` `create` `sessions` `session` `presets` |
| [`cmux`](src/cmux/README.md) | Save, inspect, and restore cmux workspace profiles. | `profiles` `send-self` |

### Scheduling, automation, notifications

| Tool | What it does | Key subcommands |
|------|--------------|-----------------|
| [`automate`](src/automate/README.md) | Chain any `tools` commands into named, reusable presets, with variables, conditions, branching, and SQLite run history. | `preset` `step` `task` `daemon` `configure` |
| [`daemon`](src/daemon/README.md) | General-purpose background task scheduler that owns the scheduled work, with an installable service unit. | `start` `stop` `restart` `status` `install` `uninstall` `config` `logs` |
| [`notify`](src/notify/README.md) | Send macOS notifications through `terminal-notifier`, with action hooks and an interactive config. | `config` |
| [`telegram`](src/telegram/README.md) | Telegram MTProto user-account client: listen for messages, auto-respond, browse contacts and history, TUI watcher. | `configure` `listen` `contacts` `history` `watch` |
| [`telegram-bot`](src/telegram-bot/README.md) | Telegram Bot API client for notifications and remote control. Simpler auth than the user client. | `configure` `send` `start` |

### Shell and small utilities

| Tool | What it does | Key subcommands |
|------|--------------|-----------------|
| [`tools`](src/tools/README.md) | The interactive browser itself: fuzzy search every tool, read its README, list subcommands, copy the command. | (interactive) |
| [`zsh`](src/zsh/README.md) | Shell enhancement manager: installs one hook line into your rc files, with toggleable feature modules. | `install` `uninstall` `enable` `disable` `list` `hook` |
| [`aliases`](src/aliases/README.md) | Mine shell history for the command chains and single commands you actually repeat, and propose aliases. | `analyze` `apply` `decay` `status` `reset` |
| [`config`](src/config/README.md) | Manage GenesisTools configuration. | `packages` |
| [`update`](src/update/README.md) | Update GenesisTools: git pull, `bun install` with a clean retry, optional plugin refresh. | (single command) |
| [`benchmark`](src/benchmark/README.md) | Save command recipes and run them through hyperfine, keeping per-run history so you can see timings drift. | `add` `remove` `list` `show` `edit` `history` |
| [`markdown-cli`](src/markdown-cli/README.md) | Render Markdown to good-looking terminal output, with watch mode and themes. | flags only (`--watch`, `--no-color`) |
| [`hash`](src/hash/README.md) | Compute and verify file checksums (md5, sha1, sha256, sha512, blake3), coreutils-compatible. | flags only |
| [`jwt`](src/jwt/README.md) | Decode and inspect a JWT offline, humanizing `exp` / `iat` / `nbf` into local and relative time. It does not verify signatures. | flags only |
| [`qr`](src/qr/README.md) | Render QR codes in the terminal for a URL, arbitrary text, or a WiFi network. | `wifi` |
| [`tz`](src/tz/README.md) | Convert a time across timezones from natural language, for example `tz '3pm PST in Prague'`. | flags only |
| [`envdiff`](src/envdiff/README.md) | Diff `.env` against `.env.example`: missing, extra, and changed keys with masked values, plus `--sync` to scaffold. | flags only |
| [`secrets`](src/secrets/README.md) | Scan for hardcoded API keys, tokens, and private keys. | `scan` |

### Not user-facing

| Entry | Why it is here |
|-------|----------------|
| `utils` | The `@genesiscz/utils` package barrel. It is discovered because it has an `index.ts`, but running it does nothing. |
| `Internal` | Private tools, explicitly marked "not for public use". |
| `t3chat-length` | Internal scratch tool. It prints `[]` unless you edit `myInputJson` in its source first. |

---

## 💡 Flagship tools in detail

Each of these has its own README with the full option matrix. What follows is the shape of
each tool and the commands worth knowing.

### 🐙 GitHub

[`src/github/README.md`](src/github/README.md)

```bash
tools github issue https://github.com/org/repo/issues/123 --last 10
tools github pr 456 --no-bots --last 20
tools github search "memory leak" --repo org/repo --state open
tools github code "createOpenAI(" --repo org/repo
tools github get https://github.com/org/repo/blob/main/src/index.ts
tools github notifications --reason mention --open
tools github activity --since 7d
tools github status                      # auth, rate limit, cache stats
```

Review threads have a dedicated surface, including an LLM session mode that hands out short
refs instead of repeating whole threads:

```bash
tools github review 137                          # all threads
tools github review 137 -u                       # unresolved only
tools github review 137 --llm -u -s pr137         # compact summary with refs
tools github review expand t1,t3 -s pr137         # expand specific threads
tools github review respond t1 "Fixed in abc123" --resolve -s pr137
tools github review resolve t1,t2,t3 -s pr137     # batch resolve
tools github review sessions
```

### 🔷 Azure DevOps

[`src/azure-devops/README.md`](src/azure-devops/README.md)

Everything is a subcommand. The old flag-style interface (`--workitem 12345`,
`--query <id>`) is gone.

```bash
tools azure-devops configure "https://dev.azure.com/MyOrg/MyProject/_workitems"
tools azure-devops workitem 261575 --task-folders --images
tools azure-devops workitem 12345,12346,12347
tools azure-devops query "Open Bugs" --download-workitems --category react19
tools azure-devops workitem-create
tools azure-devops list
tools azure-devops dashboard <url-or-id>
tools azure-devops timelog add -w 268935 -h 2 -t "Development"
tools azure-devops history show 261575 --assigned-to "Martin"
```

Aliases exist for the long names: `config`, `wi`, `create`, `ls`.

Prerequisites are the Azure CLI plus its DevOps extension:

```bash
az extension add --name azure-devops
az login --allow-no-subscriptions --use-device-code
```

Caching has two layers. Work item files are kept for 365 days, but a 5-minute freshness window
decides whether a fetch hits the API again, so a re-read inside 5 minutes is free and a later
one refreshes. Queries and dashboards are cached for 180 days, the queries list and project
metadata for 30 days. `--force` bypasses all of it. Project config and downloaded task files
live under `.claude/azure/`, searched up to three parent levels from the current directory.

### 🔍 HAR Analyzer

[`src/har-analyzer/README.md`](src/har-analyzer/README.md)

A HAR file is usually megabytes of JSON. This tool never makes you read it. Any value longer
than 200 characters (`REF_THRESHOLD` in `src/utils/references.ts`) is shown once, then replaced
by a ref ID plus a preview. Static asset bodies (CSS, JS, images, fonts) are skipped entirely
unless you pass `--include-all`.

```bash
tools har-analyzer load capture.har               # parse and show the dashboard
tools har-analyzer list --status 4xx,5xx --domain api.example.com
tools har-analyzer show e14                       # entry detail
tools har-analyzer show e14 --raw --section body  # full content
tools har-analyzer expand e14.rs.body --schema    # structure before content
tools har-analyzer domain api.example.com
tools har-analyzer errors
tools har-analyzer waterfall
tools har-analyzer security                       # JWTs, API keys, insecure cookies
tools har-analyzer diff e5 e14
tools har-analyzer export --domain api.example.com --sanitize -o api-only.har
tools har-analyzer redact capture.har --dry-run    # report what would be redacted
tools har-analyzer redact capture.har -o clean.har # write a redacted copy
tools har-analyzer sessions
tools har-analyzer mcp                            # MCP server mode
```

Output format is switchable with `--format md|json|toon`, and `--full` bypasses the reference
system entirely.

`redact` never rewrites your file unless you ask. Default is a new file via `-o`, `--dry-run`
reports without writing, and `--in-place` rewrites the original after saving a backup to `/tmp`
and printing the restore command. Redaction kinds (`password`, `secret`, `token`, `session`,
`email`, `username`, `cookie`, `jwt`) are selectable with `--only` and `--skip`.

> ⚠️ A HAR captured from a logged-in browser contains live cookies and bearer tokens. Run
> `redact` or `export --sanitize` before sharing one.

### 🧠 Claude

[`src/claude/README.md`](src/claude/README.md)

```bash
tools claude history "timelog"              # search conversation history
tools claude history --file config.ts --since "7 days ago"
tools claude resume                         # pick a session to resume
tools claude tail                           # live-tail the current session or an agent
tools claude summarize <session-id>
tools claude usage                          # interactive usage TUI
tools claude spending                       # token and cost analytics (alias of ai-spend)
tools claude config                         # accounts and notification settings
tools claude login [name]                   # OAuth login for an extra account
tools claude start <name> -- --model opus    # launch Claude Code on a saved token
tools claude teams                          # list agent teams and re-attach teammates
tools claude cmux                           # reopen recent sessions as cmux workspaces
tools claude code unpack                    # unpack, diff, bisect published CLI bundles
tools claude doctor                         # find sessions billing the wrong account
tools claude mcp                            # the MCP server described above
```

`tools claude exec` runs any command with a chosen account's long-lived token in its
environment, so `claude -p` inside a hook or CI job never depends on whatever the keychain
happens to hold.

### 🤖 AI subsystem

The `ai` tool is the user-facing face of a layered subsystem under `src/utils/ai/`:
credentials in an encrypted vault, one config store, one provider plugin per vendor, one model
resolution ladder, one transport, and one usage recorder.

```bash
tools ai models                             # catalogue with pricing
tools ai translate "text" --to cs
tools ai summarize file.md
tools ai image "a red bicycle in the rain"
tools ai classify "the build fails on CI" --categories bug,feature,question
tools ai config account add
tools ai config account list
tools ai config account test <id-or-name>
tools ai config default set <task> <model-ref>
tools ai config secret rotate
tools ai config doctor                      # per-account credential diagnosis
```

Credentials are never stored in plaintext. Config holds references into an AES-256-GCM vault
at `~/.genesis-tools/security/vault.json`, and the master key comes from an environment
variable, the OS keychain, or an opt-in key file, in that order.

> ⚠️ `doctor` and `account test` are read-only by contract. Both once spent single-use
> Anthropic refresh tokens simply by diagnosing an account, so the guard now lives in the
> shared auth path, immediately before the call that would spend the token.

### 🔗 AI Proxy

[`src/ai-proxy/README.md`](src/ai-proxy/README.md)

An OpenAI-compatible endpoint on localhost that fronts providers you already pay for, so any
OpenAI-shaped client can reach a Grok or GitHub Copilot subscription.

```bash
tools ai-proxy config                       # interactive config menu
tools ai-proxy up                           # start in the background
tools ai-proxy status
tools ai-proxy models                       # the proxy IDs clients can call
tools ai-proxy calls --limit 20             # request log, newest first
tools ai-proxy calls --slower-than 5        # only calls that took 5s or more
tools ai-proxy clients                      # per-user client keys and usage ledger
tools ai-proxy introspect                   # copy-paste inventory for Cursor BYOK
tools ai-proxy link                         # register the proxy as an ai account
tools ai-proxy down
```

Once linked, `@proxy/<slug>/<model>` resolves as a model reference anywhere in the AI
subsystem.

### 📇 Scripts (MCP without an agent loop)

[`src/scripts/README.md`](src/scripts/README.md)

When a job means calling the same MCP tool fifty times, an agent loop is the wrong shape. This
tool generates typed bindings from a server's live `tools/list` and lets you write a plain
TypeScript script against them.

```bash
tools scripts servers                       # what MCP servers are configured
tools scripts tools <server>                # list a server's tools
tools scripts describe <server> <tool>      # full input schema
tools scripts call <server> <tool> '{"k":"v"}'
tools scripts create my-script
tools scripts run my-script
tools scripts regen                         # refresh generated types
tools scripts doctor
```

Scripts are stored under `~/.genesis-tools/scripts`.

### 🖥️ Task (run interactive processes for agents)

[`src/task/README.md`](src/task/README.md)

Dev servers, Metro, Vite, and anything else that assumes a TTY and never exits. `task` gives
each one a PTY, captures ordered logs, and exposes a tail an agent can read without drowning.

```bash
tools task run --session web -- bun dev
tools task sessions
tools task logs --session web -t 100        # last 100 lines
tools task logs --session web --grep error
tools task tail --session web               # follow live
tools task get --session web                # state, files, flags cheat sheet
tools task wait --session web --exit-on-match "ready in"
tools task clean
tools task dashboard
```

Because `task` records the real exit code, it also solves the pipeline problem: `mytool | head`
reports `head`'s status, not the tool's.

### 🩺 Debugging Master

[`src/debugging-master/README.md`](src/debugging-master/README.md)

```bash
tools debugging-master start --session fix-auth-bug
tools debugging-master get -l dump,error --last 5
tools debugging-master expand d2 --query 'data.user.email'
tools debugging-master snippet
tools debugging-master diff --session auth-fail --against auth-pass
tools debugging-master tail
tools debugging-master cleanup --blocks      # remove the @dbg blocks from source
tools debugging-master cleanup --clean-logs  # archive the session logs
```

Instrumentation is temporary by design: `dbg.dump()`, `dbg.timerStart()` / `dbg.timerEnd()`,
`dbg.checkpoint()`, `dbg.snapshot()`, and `dbg.assert()` go in, and `cleanup` takes them out
again. `cleanup` is opt-in on purpose: bare `cleanup` does nothing, you pick `--blocks`,
`--clean-logs`, or both. Logs read back at three levels of detail, from a compact timeline to
full data with JMESPath projections. TypeScript and PHP are instrumented directly, browsers
over HTTP.

### 💾 Clone-aware disk usage

```bash
tools du clonesize ~/Projects                # real footprint, clones counted once
tools du clones ~/Projects                   # which trees share blocks
tools du volume                              # per-volume accounting
tools du bench                               # the benchmark harness
```

On APFS, `bun install` uses `clonefile(2)`, so twenty worktrees can share one physical copy of
`node_modules`. Plain `du` counts those bytes twenty times. This tool counts them once.

> 🛑 Before changing anything under `src/du/`, read `.claude/docs/benchmarks-du.md` and append
> a dated section for the change. The native core is syscall-bound and sits in the hot loop of
> multi-million-file scans, so an unmeasured feature is a silent regression.

### 🔌 MCP Manager

[`src/mcp-manager/README.md`](src/mcp-manager/README.md)

```bash
tools mcp-manager                            # interactive
tools mcp-manager config                     # edit the unified config
tools mcp-manager list                       # every server across every provider
tools mcp-manager sync                       # unified config -> providers
tools mcp-manager sync-from-providers        # providers -> unified config
tools mcp-manager enable github
tools mcp-manager disable github
tools mcp-manager install github
tools mcp-manager show github
tools mcp-manager backup-all
tools mcp-manager rename old new
```

Supported providers: Claude (`~/.claude.json`, global and per-project), Gemini Code Assist
(`~/.gemini/settings.json`), Codex (`~/.codex/config.toml`), and Cursor (`~/.cursor/mcp.json`).
The unified config is `~/.genesis-tools/mcp-manager/config.json`. Every write is backed up
first, shown as a diff, and reverted automatically if you reject it.

### 🎨 npm Package Diff

[`src/npm-package-diff/README.md`](src/npm-package-diff/README.md)

```bash
tools npm-package-diff react 18.0.0 18.2.0
tools npm-package-diff lodash 4.17.20 4.17.21 --filter "**/*.js"
tools npm-package-diff express 4.17.0 4.18.0 --patch express.patch
tools npm-package-diff @types/node 18.0.0 20.0.0 --format html -o report.html
tools npm-package-diff typescript 4.9.0 5.0.0 --use-delta
tools npm-package-diff webpack 4.46.0 5.88.0 --stats --sizes
```

Default filter is `**/*.d.ts`, which is usually what you want when checking whether an upgrade
breaks types. Formats: `terminal`, `unified`, `html`, `json`, `side-by-side`. Package managers
npm, yarn, pnpm, and bun are all supported.

> ✅ Both versions are installed with `--ignore-scripts`, on every package manager. Comparing
> two versions of an arbitrary package therefore never runs that package's lifecycle scripts.

### 🗣️ Say

[`src/say/README.md`](src/say/README.md)

```bash
tools say "Build finished"
tools say "Timer done" --app timer --wait
tools say "Loud and clear" --volume 60%
tools say --voice                            # list voices for the current provider
tools say voices                             # every voice, grouped by provider
tools say config                             # interactive profile manager
```

Configuration is per app. `--app <name>` loads that profile, unset fields inherit from
`default`, and the config lives at `~/.genesis-tools/say/config.json`.

Four rules that changed from older builds:

-   `--save` persists only the flags you passed explicitly, and it needs a target profile. With
    `--app` it saves there. In a TTY without `--app` it asks which profile. In a non-TTY without
    `--app` it errors.
-   `--save` with no message text saves only. It does not speak, and it does not open the
    interactive mode.
-   `--mute` and `--unmute` need `--save` to persist. They are no longer standalone
    state-writing commands.
-   `--unset <fields>` ignores those profile fields for one run, or deletes them from the saved
    profile when combined with `--save`.

Speech is fire-and-forget by default: it plays in a detached process and the command returns.
Pass `--wait` to block.

### ▶️ YouTube

[`src/youtube/README.md`](src/youtube/README.md)

```bash
tools youtube transcribe https://www.youtube.com/watch?v=dQw4w9WgXcQ
tools youtube channels add @somechannel
tools youtube channels sync
tools youtube videos list
tools youtube videos search "pricing"        # across titles, descriptions, transcripts
tools youtube download <video-or-url>
tools youtube pipeline <video-or-url>        # takes targets, not a "run" subcommand
tools youtube queue add <targets...>
tools youtube queue list
tools youtube ask "what did they say about pricing?" --channel @somechannel
tools youtube analyze <video-or-url>
tools youtube transcripts export <targets...>
tools youtube ui up                          # web UI (up/down/status/logs/open)
tools youtube mcp                            # MCP server
tools youtube extension build                # browser extension
```

Targets are interchangeable everywhere: a video ID, a full URL, or an `@handle`. Captions are
used when they exist, with AI transcription as the fallback.

### ⏸️ Hold-AI

[`src/hold-ai/README.md`](src/hold-ai/README.md)

A WebSocket hold/release pair with no `index.ts`, so both halves are addressed by path:

```bash
tools hold-ai/server        # terminal 1: collects your messages, opens an editor
tools hold-ai/client        # terminal 2: what the AI runs to block
```

Type messages, save and exit to send them. Send `OK` on its own to release the AI.

---

## 🗂️ Where things are stored

| Path | Contents |
|------|----------|
| `~/.genesis-tools/logs/<YYYY-MM-DD>.log` | Day-stamped pino JSON logs from every tool. First stop when anything misbehaves. |
| `~/.genesis-tools/<tool>/` | Per-tool config and cache, for example `say/config.json`, `mcp-manager/config.json`, `scripts/`. |
| `~/.genesis-tools/ai/config.json` | AI accounts, defaults, and aliases (version 4 schema). |
| `~/.genesis-tools/security/vault.json` | AES-256-GCM credential vault. Config stores references into it, never plaintext. |
| `~/.genesis-tools/claude-code/sessions/<id>.json` | Files modified per Claude Code session, written by the plugin hooks. |
| `.claude/azure/` | Per-project Azure DevOps config and downloaded work items. |

Tools that keep durable state use SQLite with a migration runner. Pending migrations are
applied on every read-write open and applied IDs are tracked in a `_migrations` table, so a
fresh database is almost never the right fix for anything.

---

## 🌐 Web servers and ports

Ports are not hardcoded per tool. The canonical registry is
[`src/utils/ui/dashboards.ts`](src/utils/ui/dashboards.ts), which holds browser dashboards in
`DASHBOARDS` and non-browser listeners (HTTP APIs, extensions, proxies) in `WEB_SERVICES`.
Ports must be unique across both, and `findPortConflicts()` enforces it.

| Port | Service |
|------|---------|
| 3000 | Personal Dashboard |
| 3042 | Dev Dashboard (also the boards API) |
| 3069 | Claude History Browser |
| 3071 | Clarity Timelog |
| 3072 | REAS Analyzer |
| 3073 | Shops CZ |
| 3074 | YouTube Web UI |
| 7243 | Log Viewer (debugging-master plus task) |
| 7251 | DevDashboard Cloud |
| 8317 | AI Proxy |
| 9876 | YouTube Server |
| 9877 | YouTube Extension |

Bring them all up or down together with `tools dashboards up|down|restart|status`.

---

## 🧪 Development

### Running tests

```bash
bun run test                     # the wrapper, always use this
bun scripts/test.ts <paths>      # same wrapper, specific paths
bun run test:e2e                 # end-to-end suites
bun run test:coverage
```

> 🛑 Never run bare `bun test`. The wrapper stat-checks the dependency tree first (about 1ms)
> and reinstalls when it is missing, partial, or stale, then hands off to `bun test` with argv,
> output, and exit code untouched. This matters inside a **git worktree**, where any `bunx`
> call creates a partial `node_modules/` that shadows the parent checkout's complete one. Bare
> `bun test` then fails across a hundred unrelated files with errors like
> `Cannot find module 'parse5/lib/common/doctype'`, which looks exactly like your branch broke
> the world.

Working in an isolated worktree adds two more requirements. Verify the base commit first
(`git log --oneline -1`), because worktrees are often cut from `origin/master` rather than the
feature branch you were briefed on. Then run `bun install` in the worktree, or its imports
resolve against the main repo's dependency tree and fabricate failures.

### Lint, format, typecheck

```bash
bun run lint                     # biome check .
bun run lint:fix                 # biome check --write .
bun run format                   # biome format --write .
bun run tsgo                     # tsgo --noEmit
bun run typecheck:all            # plus the dashboard tsconfig
```

Formatting is Biome with a 120-column line width and 4-space indent. Imports are sorted by
module specifier, named imports are sorted case-insensitively inside the braces, and the
pre-commit hook runs `biome check --write --staged`.

### Adding a tool

Create `src/<name>/index.ts`. That is the whole registration step.

The conventions that keep a tool consistent with the rest:

-   Parse arguments with `commander`, and end the entrypoint with
    `await runTool(program, { tool })` from `@genesiscz/utils/cli`.
-   Put business logic in `src/<name>/lib/`. The CLI commands, HTTP routes, and MCP tool
    modules are all thin adapters over it. A behaviour must never exist in a route that the
    CLI cannot reach, or the other way round.
-   Log through `logger` from `@genesiscz/utils/logger` for diagnostics, and `out` for anything
    the user reads. `out.result()` and `out.print()` are the only writers to stdout.
-   Never read `process.env` directly. Use `env` from `@genesiscz/utils/env`.
-   Use `SafeJSON` from `@genesiscz/utils/json` instead of the `JSON` global. It tolerates
    comments and trailing commas.
-   Check `isInteractive()` before prompting, and fall back to a flag with `suggestCommand()`
    when there is no TTY.
-   Helpers that other tools could use belong in `src/utils/`, not in the tool folder.

Templates for both prompt libraries live in `.claude/docs/tool-template.md`. Before writing
web UI, read `.claude/docs/design-system.md`.

### Guardrails in CI

-   `scripts/ci/logging-guard.sh` enforces the logging convention repo-wide: no default,
    extension, relative-path, or renamed import of the logger module, no serialized results
    dumped through `logger.*`, and no reintroduced transitional shims.
-   `scripts/ci/ai-credentials-guard.sh` fails the build on argument-less provider
    constructors, bare `@ai-sdk` singletons outside `src/utils/ai/providers/`, and any
    `new Storage("ai")` outside the AI config layer.
-   `bun run check:ui-palette` rejects raw palette colors in app code, where theme tokens
    belong.

### A rule worth repeating

**A diagnostic must never mutate.** If the name says it inspects (`doctor`, `test`, `probe`,
`health`, `check`, `status`, `list`, `show`, `--dry-run`), it may read durable state and report
on it, and nothing else. No writes, no token rotation, no cache mint that changes what a later
process sees. When a diagnostic finds a problem it prints the fix command, it does not apply
the fix. Two commands in this repo once spent single-use OAuth refresh tokens purely by
diagnosing an account, which meant checking a credential could break it.

---

<a href="https://www.star-history.com/#genesiscz/GenesisTools&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=genesiscz/GenesisTools&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=genesiscz/GenesisTools&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=genesiscz/GenesisTools&type=Date" />
 </picture>
</a>

---

<div align="center">

  ### 🌟 Built with ❤️ by developers, for developers

  <p>
    <a href="https://github.com/genesiscz/GenesisTools">⭐ Star this repo</a> •
    <a href="https://github.com/genesiscz/GenesisTools/issues">🐛 Report Bug</a> •
    <a href="https://github.com/genesiscz/GenesisTools/pulls">✨ Contribute</a>
  </p>

</div>
