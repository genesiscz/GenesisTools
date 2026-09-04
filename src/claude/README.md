# Claude Tool (`tools claude`)

Claude-focused utilities for local Claude Code workflows:

- Search and summarize conversation history
- Resume past sessions
- Sync skills to Claude Desktop
- Inspect Claude usage/quota
- Manage Claude auth/config
- Migrate Claude assets to Codex (`migrate-to codex`)
- Reopen a set of sessions as cmux workspaces (`cmux`)
- Run Claude Code on a non-Anthropic model through ai-proxy (`proxy`)

---

## Quick Start

```bash
# General help
tools claude --help

# History search
tools claude history "mcp manager"

# Resume session
tools claude resume

# Claude usage
tools claude usage

# Migrate Claude assets to Codex (interactive wizard)
tools claude migrate-to codex

# Reopen recent sessions as cmux panes
tools claude cmux

# Anthropic start inside tmux (alias: run). On --resume <query>, the tmux
# session is named from the conversation title. A bound ttyd is renamed too.
tools claude start work --tmux --resume "auth callback"
```

`--tmux` applies to `tools claude start` / `run` for Anthropic accounts. A slash target (`account/provider`) still goes to `proxy` and ignores `--tmux`. If you are already inside tmux, this renames the current session instead of nesting a new one.

---

## `proxy` — Claude Code on a proxied model

Launches Claude Code against a model served by `tools ai-proxy` (Grok, GitHub Copilot,
OpenRouter, xAI) instead of api.anthropic.com. The proxy answers the Anthropic Messages API
natively; see `src/ai-proxy/README.md` for the translation.

```bash
tools claude proxy martin/grok -m 4.5        # <account>/<provider> plus a model filter
tools claude proxy work/xai/grok-4.6         # or a full proxy model id
tools claude run martin/grok -m 4.5          # `run` routes here when the name has a slash
tools claude proxy martin/grok --list        # list matching models, launch nothing
tools claude proxy martin/grok -- -c         # args after -- go to claude
```

`[target]` is an `<account>/<provider>` prefix or a full proxy id; `-m/--model` filters inside it
(every whitespace-separated token must appear, so `-m "composer fast"` works). Several matches
open a picker in a TTY and fail with the list otherwise.

A **full id on a known account launches even when the catalog does not list it**, with a warning.
The proxy advertises a curated list but routes any id whose account exists, so
`martin/grok/grok-4.6` answered chat while `ai-proxy models` still hid it. A typo in the account
or provider segment still fails locally rather than becoming an upstream 404.

The proxy is started if it is not already answering; `--no-start` turns that into an error
instead. The launch clears `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` from the child
environment — either one would outrank the proxy token and silently bill the real Anthropic
account.

`tools claude start` (alias `run`) is unchanged for Anthropic accounts. The split is the slash: no
Anthropic account name has one, every ai-proxy target does.

---

## `cmux` — reopen sessions as workspaces

Pick recent Claude Code sessions and rebuild them as cmux panes, each one resuming under the
account it originally ran as. Built for the machine-died case, and for pulling a set of
threads back up on purpose.

```bash
tools claude cmux                       # pick from the 12 most recently ACTIVE sessions, any project
tools claude cmux --last 30             # reach further back
tools claude cmux --this-project        # only this directory's project
tools claude cmux --dry-run             # print the plan, touch nothing
tools claude cmux snapshot before-reboot
tools claude cmux restore before-reboot
tools claude cmux list                  # saved snapshots
tools claude cmux tree                  # live window → workspace → pane → surface map, with session ids
tools claude cmux open-session <id> --workspace workspace:1   # resume as a new pane there
tools claude cmux send <id> "run the tests"   # type into the session's own pane
tools claude cmux send <id> "/compact" --no-enter --dry-run
```

`tree` (`--json` for machines) enumerates every cmux window and annotates each surface with
the Claude Code session it hosts, from the refs journal plus the `· 8hex` tab-title marker.
`open-session` resumes one session at a chosen level: `--window` makes a new workspace,
`--workspace` a new pane, `--workspace --pane` a new tab, `--workspace --surface` types the
resume command into that surface (`--no-enter` queues it). The command comes from the same
builder restore uses, so the pinned account and auth mode survive.

`send` types text into the pane a session already occupies, resolving `<id>` in stages:
the refs journal first, then an exact id, an id prefix, the tab title, the workspace, and
finally the working directory. A weak match with more than one candidate is refused rather
than guessed at, because typing into the wrong agent session is worse than not typing;
`--first` overrides that for the non-weak cases. `--no-enter` leaves the text in the prompt
without submitting it, and `--dry-run` prints the pane it would type into and stops.

Each pane runs `cd <session cwd> && tools claude start <account> -- --resume <id>`. The
`--resume` sits after `--` so claude gets the id verbatim; before it, `tools claude start`
would treat the id as a search query and prompt.

### Layout

Sessions group into one workspace per project (`--no-per-project` to merge them), and each
workspace holds an even grid:

| Flag | Effect |
|---|---|
| `--layout capped` (default) | Grid capped at `--per-workspace` panes (4); the rest spill into `project 2`, `project 3` |
| `--layout grid` | One workspace, every session a pane — cmux clamps at its minimum pane size past ~8 |
| `--layout tabs` | Fill the cap in panes, then stack the overflow as extra tabs inside them |

Other flags: `--account <name>` forces one account on every pane, `-a` auto-picks for panes
with no recorded account, `--no-enter` queues each command at the prompt instead of running
it, `--new-window` builds in a fresh cmux window, `-y` skips the picker.

### The account pin

Nothing in Claude Code's transcripts records which account a session ran as, so it is
recorded at session start by `hooks/record-session-account.ts` in the **genesis-tools
plugin** — no settings.json editing, it ships with the plugin's other SessionStart hooks.

The hook reads `TOOLS_CLAUDE_ACCOUNT` and `TOOLS_CLAUDE_AUTH` (exported by
`tools claude start`). Auth is `token` (long-lived `CLAUDE_CODE_OAUTH_TOKEN`) or
`keychain` (`--keychain` injects that account's secondary login into the macOS
keychain for the session). Do not infer keychain from a missing OAuth env: Claude
Code strips that secret from hook children. `--resume` after `--` still goes to
claude verbatim. Pre-fix pins that claimed `auth: keychain` without a trusted
source resume on the token path.

```bash
tools claude cmux pins           # what has been recorded, newest first
```

Only sessions started after the hook landed have pins. Sessions without one show as
`unpinned` and ask which account to use when their pane launches (or take `--account` /
`-a`). Plugin edits need a push plus `/plugin update` before Claude Code picks them up.

---

## `migrate-to codex`

Interactive migration wizard for moving/syncing Claude assets into Codex-compatible locations.

### What it discovers

- **Skills**
  - Project: `./.claude/skills/*/SKILL.md`
  - Project plugins: `.claude-plugin/marketplace.json` + `plugins/*/.claude-plugin/plugin.json`
  - Global: `~/.claude/skills/*/SKILL.md`
- **Commands**
  - Project: `./.claude/commands/**/*.md`
  - Plugin command markdown folders from plugin manifests
  - Global: `~/.claude/commands/**/*.md`
- **Instructions**
  - Project and global `CLAUDE.md`

### Target mapping

- **Skills** -> Codex skills folders:
  - Project: `./.agents/skills/`
  - Global: `~/.codex/skills/`
- **Commands** -> Codex prompt files:
  - Project: `./.codex/prompts/`
  - Global: `~/.codex/prompts/`
- **Instructions** (`CLAUDE.md`) -> `AGENTS.md`
  - Project scope: `./AGENTS.md`
  - Global scope: `~/.codex/AGENTS.md`

### Wizard behavior

- `ESC` goes back one step (instead of cancelling immediately)
- Existing-target conflicts are resolved interactively:
  - show diff (`src/utils/diff.ts` helper)
  - overwrite
  - skip
  - rename target path
- Steps:
  1. Choose source scope (`project`, `global`, `both`)
  2. Choose components (`skills`, `commands`, `instructions`)
  3. Choose target scope (`project`, `global`, `both`)
  4. Choose transfer mode (`symlink` or `copy`)
  5. Choose naming strategy (`prefixed` or `preserve`)
  6. Confirm plan

### Modes

- **symlink** (recommended): always-in-sync
- **copy**: one-time snapshot

### CLI options

```bash
tools claude migrate-to codex [options]
```

| Option | Description |
| --- | --- |
| `--source <scope>` | Source scope: `project`, `global`, `both` |
| `--target <scope>` | Target scope: `project`, `global`, `both` |
| `--components <list>` | Comma list: `skills,commands,instructions` |
| `--mode <mode>` | `symlink` or `copy` |
| `--name-style <style>` | `prefixed` or `preserve` |
| `--force` | Overwrite existing destination entries |
| `--dry-run` | Show planned actions without writing |
| `--list` | Print discovered assets and exit |
| `-y, --yes` | Skip final confirmation |
| `--non-interactive` | Skip wizard and run from flags |

### Examples

```bash
# Guided migration
tools claude migrate-to codex

# See what would be migrated
tools claude migrate-to codex --list

# Global sync via symlinks (non-interactive)
tools claude migrate-to codex \
  --source global \
  --target global \
  --components skills,commands \
  --mode symlink \
  --non-interactive \
  -y

# Instructions only, preview
tools claude migrate-to codex \
  --source project \
  --target project \
  --components instructions \
  --mode copy \
  --dry-run \
  --non-interactive
```
