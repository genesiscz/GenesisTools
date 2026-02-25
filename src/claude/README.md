# Claude Tool (`tools claude`)

Claude-focused utilities for local Claude Code workflows:

- Search and summarize conversation history
- Resume past sessions
- Sync skills to Claude Desktop
- Inspect Claude usage/quota
- Manage Claude auth/config
- Migrate Claude assets to Codex (`migrate-to codex`)

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
```

---

## `migrate-to codex`

Interactive migration wizard for moving/syncing Claude assets into Codex-compatible locations.

### What it discovers

- **Skills**
  - Project: `./.claude/skills/*/SKILL.md`
  - Project plugins: `.claude-plugin/marketplace.json` + `plugins/*/.claude-plugin/plugin.json`
  - Global: `~/.claude/skills/*/SKILL.md`
- **Commands**
  - Project: `./.claude/commands/*.md`
  - Plugin command markdown folders from plugin manifests
  - Global: `~/.claude/commands/*.md`
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
