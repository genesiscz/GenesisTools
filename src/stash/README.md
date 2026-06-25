# tools stash

Global cross-project code-overlay manager. `git stash` × JetBrains Shelf × `quilt`.

## Quick start

```bash
# In Project A — capture a debug-logger overlay
tools stash save debug-logger --all

# In Project B (sibling clone) — apply it
cd ../project-b
tools stash apply debug-logger

# Later, surgical removal with diff review
tools stash unapply debug-logger
```

## Storage

- Patches: bare git repo at `~/.genesis-tools/stash/store/`
- Index: SQLite at `~/.genesis-tools/stash/index.db`
- In-progress sessions: JSON at `~/.genesis-tools/stash/state/`
- Logs: `~/.genesis-tools/logs/<day>.log`

## Commands

See `tools stash --help` or the agent skill at `.claude/skills/stash/SKILL.md`.

## Design

See `.claude/plans/2026-06-24-StashTool-spec.md` for full design rationale (region marker format, state machine, sibling-clone detection, etc.).