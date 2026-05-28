---
name: task
description: >-
  Run interactive CLI commands (Metro, Vite, dev servers) with PTY capture and
  agent-friendly log tail. Use when the user wants to run a long-lived process
  with log capture, grep session logs, follow live output, or inspect session state.
---

# `tools task`

PTY-aware command wrapper with ordered JSONL capture.

## Agent workflow

1. **`tools task get --session <name>`** — first command; shows state, files, flags cheat sheet
2. **`tools task logs --session <name> --raw | grep PAT`** — grep-safe log read
3. **`tools task tail --session <name> --follow`** — live follow

## Key rules

- **`get`** → stderr only (don't pipe)
- **`logs`/`tail`** → use `--raw` or `--jsonl` for piping stdout
- Hints always use long flags (`--follow`, not `-f`)
- Storage: `~/.genesis-tools/task/sessions/<name>.jsonl`

## Commands

| Command | Purpose |
|---|---|
| `task run --session NAME -- CMD` | Foreground run + capture |
| `task get --session NAME` | Session info panel |
| `task logs --session NAME` | Read logs (add `--tail --follow` for live) |
| `task tail --session NAME --follow` | Live follow |
| `task sessions` | List sessions |
| `task clean --session NAME` | Remove session files |
| `task dashboard open` | Open unified dashboard |

## Examples

```bash
tools task run --session metro -- npx react-native start
tools task get --session metro
tools task logs --session metro --lines 100 --raw | grep BUNDLE
tools task tail --session metro --follow
```

See `tools task --readme` for full documentation.
