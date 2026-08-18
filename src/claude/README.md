# Claude Tool (`tools claude`)

Claude-focused utilities for local Claude Code workflows:

- Search and summarize conversation history
- Resume past sessions
- Sync skills to Claude Desktop
- Inspect Claude usage/quota
- Manage Claude auth/config
- Migrate Claude assets to Codex (`migrate-to codex`)
- Reopen a set of sessions as cmux workspaces (`cmux`)

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
```

---

## `cmux` — reopen sessions as workspaces

Pick recent Claude Code sessions and rebuild them as cmux panes, each one resuming under the
account it originally ran as. Built for the machine-died case, and for pulling a set of
threads back up on purpose.

```bash
tools claude cmux                       # pick from the 12 most recently ACTIVE sessions
tools claude cmux --last 20 --all-projects
tools claude cmux --dry-run             # print the plan, touch nothing
tools claude cmux snapshot before-reboot
tools claude cmux restore before-reboot
tools claude cmux list                  # saved snapshots
```

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
recorded at session start by a hook:

```bash
tools claude cmux hook install   # adds a SessionStart hook to ~/.claude/settings.json
tools claude cmux hook           # status + how many pins exist
```

The hook writes `session id → account` (plus model, cwd and cmux workspace) to
`~/.genesis-tools/claude-code/session-pins.jsonl`. It only knows about sessions started
after it was installed; sessions without a pin show as `unpinned` and ask which account to
use when their pane launches.

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
