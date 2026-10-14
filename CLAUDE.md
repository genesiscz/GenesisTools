# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

GenesisTools is a TypeScript CLI toolkit that runs on Bun, with no build step. A tool is a folder `src/<tool>/` holding `index.ts` or `index.tsx` (the tool name is the folder name), or a single `src/<tool>.ts` file. The `tools` executable lists them, or runs `tools <tool> [args]` through `bun run` with inherited stdio. Shared code lives in `src/utils/`, which is the `@genesiscz/utils` package.

## Area rules: read them before you work in an area

The detailed rules live in area files. Claude Code loads an area file by itself the first time you read, write or edit a matching file with the Read, Write or Edit tool, or view a single file with `cat`, `head` or `rg <pattern> <file>`. A search alone loads nothing (the Grep tool, `rg` over a folder, `cat` piped into another command), so the genesis-tools plugin's `area-rules` hook adds the area file when a search or a shell command touches the area. Without that plugin, or in another harness, check before you change code in an area, or answer a question about it from search results, that its area file is in your context. If it is not, read it.

- Any TypeScript (`**/*.ts`, `**/*.tsx`): `.claude/rules/code.md`. Environment variables, Biome, code style, types, waits and polls, diagnostics that must not mutate.
- TypeScript under `src/` or `scripts/`: `.claude/rules/tools.md`. Tool structure and CLI patterns, the shared utilities in `src/utils/`, logging and `out`, spawning a tool or calling its library, ports, databases.
- Tests (`*.test.ts`), and before you add a test file: `.claude/rules/tests.md`.
- AI, accounts, secrets, cost, agent history (`src/utils/ai/`, `src/utils/security/`, `src/utils/agent-sessions/`, `src/ai-proxy/`, `src/ask/`, `src/claude/`, `src/codex/`): `.claude/rules/ai.md`.
- Models and pricing (the catalog, the proxy ledger, Claude request rules, Codex and Grok model lists, the handoff-to rankings): `.claude/rules/models.md`. Where each model fact lives, and the checklist for a new model.
- Web UI (`*.tsx`, `src/*/ui/`, `src/dashboard/`, `src/dev-dashboard/`): `.claude/rules/web-ui.md`.
- macOS app, notifications, privacy grants (`src/macos/`, `src/utils/macos/`, `src/notify/`): `.claude/rules/macos.md`. Window rules for the Swift app (`src/macos/GenesisTools/`): `.claude/rules/macos-app.md`.
- The personal-data probe and the git hooks: `.claude/rules/placeholder-check.md`.
- Browser automation (`src/chrome-devtools/`, `src/utils/chrome-devtools/`, which another repo vendors): `.claude/rules/chrome-devtools.md`. The plugin (`plugins/`, `.claude-plugin/`): `plugins.md`. CI, guards and git hooks (`.github/`, `scripts/ci/`, `.githooks/`): `ci.md`. Dependencies (`package.json`, `bun.lock`): `dependencies.md`.
- The GenesisKit markdown viewer and its git components (`GenesisKit/Markdown/`, `GenesisKit/Diff/`, the GenesisTools `--markdown` face): `.claude/rules/markdown-viewer.md` (two hosts and their installs, testing without the user's windows, line numbering, git option order).
- Compression (`src/utils/compress/`, `src/compress/`, `scripts/benchmarks/compress/`): `.claude/rules/compress.md` (Bun 1.3.13 reads only the first zstd frame through `node:zlib`, verify before removing, the 30% read budget, readers that open either form).
- One folder each: `.claude/rules/du.md` (`src/du/`, benchmarks before any change), `say.md` (`src/say/`, per-app profiles), `database.md` (`src/utils/database/`, `src/utils/storage/`, any `*migration*.ts`), `claude-sdk.md` (`src/utils/claude/`, Agent SDK types), `audio.md` (`src/utils/audio/`, `src/transcribe/`), `azure-devops.md` (`src/azure-devops/`, ADO API).

A new rule goes into the area file it belongs to, or into a new `.claude/rules/<topic>.md` with a `paths:` list of globs. Do not add a CLAUDE.md to a subfolder: one rule file can cover several folders, and one folder can have several rule files. Only the sub-apps with a root of their own keep one (`apps/eve/`, `DevDashboard/mobile/`, `src/dashboard/apps/web/.claude/`). Only a rule that every session needs, whatever it touches, goes into this file.

## Running tools

```bash
tools                       # interactive tool picker
tools <tool-name> [args]    # run one tool
tools <tool-name> --readme  # print its README
```

- 🛑 `tools` on PATH runs the MAIN checkout. In a worktree, run `./tools <tool-name> [args]` from the worktree root: it runs the worktree's code through the app launcher, so privacy grants and preloads still apply. From code, start a tool with `execTool` / `execToolInteractive` from `@genesiscz/utils/cli`, never with `Bun.spawn(["tools", ...])`.
- End-of-task notification: `tools say "<task> done" --app claude`. Voice and volume come from the saved `claude` profile.

## Tests

- **Use `bun run test` (or `bun scripts/test.ts <paths>`), never bare `bun test`.** In a worktree, bare `bun test` fails across a hundred unrelated files because of a partial `node_modules/`; the wrapper repairs the dependency tree first.
- A run that stops making progress is killed after 15 minutes and prints `[test] suite STALLED` instead of `[test] suite complete`. A killed run is never a finished one.
- Tests never use real account names, emails or orgs. Use invented fixtures (`work`, `personal`, `alice@example.com`).
- Read `.claude/rules/tests.md` before you add a test file: every new file costs CI runner time before it asserts anything.

## Before every `git push`: the personal-data probe

Run `bash scripts/ci/placeholder-check.sh`. The pre-push hook runs it first, and a hit blocks the push. Its needle list is local only (`~/.genesis-tools/placeholder-check/markers.txt`): never copy it into the repo, tests, commit messages or this file. Details: `.claude/rules/placeholder-check.md`.

## 🛑 Hard rules for agents working in an isolated worktree

Every teammate/subagent given its own worktree MUST, before ANY other work:

1. **Verify the base commit.** Isolated worktrees are often cut from `origin/master`, NOT the campaign/feature branch you were briefed on. Run `git log --oneline -1`; if the briefed base commit is not an ancestor, `git fetch origin <branch> && git reset --hard <base-sha>`. Building on the wrong base silently invalidates every anchor in your brief.
2. **Run `bun install` in the worktree.** A worktree without its own `node_modules` resolves imports against the MAIN repo's dependency tree and fabricates failures that look like "the branch broke the world" (verified repeatedly; see also Tests above). Install once, yourself: `./tools` never installs by itself in a linked worktree (`TOOLS_AUTOINSTALL=1` opts in), because every fresh install writes new native binaries that macOS checks at their first start, and with several worktrees that check queued for minutes (2026-10-14).
3. **Never bare `bun test`** — always `bun run test` (the wrapper repairs the dependency tree first).

Skipping any of these has cost real sessions hours; there are no exceptions.

## Data and side effects

- `~/.genesis-tools/claude-history/index.db` holds Claude, Codex and Grok history, plus historical `usage_snapshots` and `spend_snapshots`. Never remove it as a disposable cache, never clear observation tables during a history rebuild, and never run unscoped history SQL across providers.
- A diagnostic (`doctor`, `test`, `probe`, `health`, `check`, `status`, `list`, `show`, `--dry-run`) never mutates durable state and never spends a single-use credential such as an OAuth refresh token. Details: `.claude/rules/code.md`.
- An empty result from a permission-gated tool (Calendar, Reminders, Contacts, Full Disk Access) is never proof of empty data. Run `tools macos permissions` first: it exits 1 while a grant is missing.
- When a tool misbehaves, read `~/.genesis-tools/logs/<today>.log` (day-stamped pino JSON) and `rg` it for the tool name or the error before you form a hypothesis. A day older than a week is `<date>.log.zst` (seekable zstd, written by the daily pass): search it with `rg -z <pattern> <file>` (needs the `zstd` CLI) or `tools compress cat <file> | rg <pattern>`.

## Git branch mechanics

`tools git merged` decides merged-ness (by content: squash, rebase and recompose all fool git's own checks); `tools git rebase-cascade` moves a parent with its children; `tools git base` names the base branch and the rule that chose it; `tools git config` reads the per-repo `genesis-tools.config.json`. The `gt:git` plugin skill is the guided workflow on top. Typed git output for any tool: `createGit()` readers and the `porcelain` bundles in `src/utils/git/porcelain.ts`; never re-parse `status` or `for-each-ref` by hand.

- **Commit messages:** a title line only, no per-file breakdown in the body, focused on the why.
- **Commit scopes follow one vocabulary**: `(GenesisHub, widgets)`, `(GenesisHub, settings)`, `(GenesisKit)`, `(GenesisKit, permissions)`, `(Clicky)`, `(skills, ux)`, `(scripts, native)`, `(ai, history)`, `(dashboards, dev-dashboard)`, `(tools)` for many areas; no PR number in a subject except `fix(<areas>): #485 followup - …`. The rules live in `scripts/git/commit-scopes.ts`; the `commit-msg` hook prints the corrected subject, and `bun scripts/git/check-commits.ts origin/master..HEAD` checks a branch.

## Installation & Setup

```bash
# Initial setup (requires Bun)
bun install && ./install.sh
source ~/.zshrc  # or ~/.bashrc

# The install script adds GenesisTools to PATH by modifying shell config files
```
