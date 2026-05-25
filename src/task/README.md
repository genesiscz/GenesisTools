# `tools task`

PTY-aware command wrapper with ordered JSONL log capture for agents and humans.

## What / Why

Run interactive dev servers (Metro, Vite, etc.) with full TTY fidelity while capturing grep-friendly logs. Shell redirection (`2>&1 | tee own.log`) still works — the run banner goes to stderr, child output to stdout.

## Quick start

```bash
# Run with capture (auto PTY when stdin is a TTY)
tools task run --session metro -- npx react-native start

# Agent onboarding — read this first
tools task get --session metro

# Read last 100 lines
tools task logs --session metro --lines 100

# Live follow
tools task tail --session metro --follow

# Grep-safe
tools task logs --session metro --raw | grep BUNDLE
```

## I/O contract

| Goes to **stdout** | Goes to **stderr** |
|---|---|
| `--jsonl` records | Run banner |
| `--raw` log text | Tips / navigation hints |
| Default `logs`/`tail` content | `get` info panel |
| Child pass-through on `run` | Exit summary |

**WHY:** Pipes and `grep` only see stdout. Tips on stderr never break `| grep` or `| tee`.

## Piping examples

```bash
tools task logs --session metro --raw | grep BUNDLE
tools task logs --session metro --jsonl | rg '"text".*error'
tools task logs --session metro --stderr --raw | grep -i warning
tools task tail --session metro --follow
tools task logs --session metro --tail --follow
```

## On-disk files

`~/.genesis-tools/task/sessions/<name>.{jsonl,log,err.log,meta.json}`

- **`.jsonl`** — canonical ordered stream (monotonic `seq`)
- **`.log` / `.err.log`** — ANSI-stripped mirrors for grep
- **`.meta.json`** — session metadata

## Run modes

| Mode | Trigger |
|---|---|
| PTY | `--tty` or auto (stdin TTY) |
| Pipe | `--no-tty` or auto (no stdin TTY) |

## vs shell `tee`

Use `task` when you need ordered stdout/stderr interleaving, seq navigation, agent-friendly `get`, and dashboard integration. Use plain `tee` when you only need a single combined file.
