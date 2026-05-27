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
tools task logs --session metro --tail 100

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

- **`.jsonl`** — canonical ordered stream (monotonic `seq`); plain text for agents (`logs` / `tail` / `get`)
- **`.ui.jsonl`** — dashboard-only ANSI mirror (same `seq`); never read by CLI tools
- **`.log` / `.err.log`** — ANSI-stripped mirrors for grep
- **`.meta.json`** — session metadata

## Session names

A session name is the file stem under `~/.genesis-tools/task/sessions/`. There are two distinct reuse paths:

**1. Implicit reuse (no `--session` flag).** When you previously ran `tools task run -- npx react-native start` with no `--session`, `tools task get` / `logs` / `tail` will fuzzy-resolve to the most recent matching session. If no exact match, the run is assigned a timestamp-suffixed id (`metro-2026-05-26_14-30-22`) printed on stderr before the banner:

```text
note: session "metro" already exists — using "metro-2026-05-26_14-30-22"
task-session-id: metro-2026-05-26_14-30-22
```

**2. Explicit reuse (you passed `--session foo` and `foo` already exists).** This is **append mode**: the new run continues writing into the existing `.jsonl` and `.log` files, with `seq` continuing from the prior last value. You'll see:

```text
warn: reusing existing session "foo" (append mode)
info: last seq 1234; new lines continue from 1235
info: tail live output: tools task tail --session foo --follow
info: clear older lines: tools task get --session foo --clear-older-than-seq 1234
```

Append mode is useful when re-running the same logical task (e.g. `lint`, `tsc`) and you want one rolling log per check-name. Use `--clear-older-than-seq N` on `get` to drop the prior run's lines if you want a clean slate without renaming the session.

When **`--session` is omitted**, `get` / `logs` / `tail` auto-resolve: explicit flag → fuzzy match → sole active session → error if ambiguous. Use `tools task sessions` to list all.

## Run modes

| Mode | Trigger | Stream order in JSONL | Stream attribution |
|---|---|---|---|
| PTY | `--tty` or auto (stdin TTY) | Single merged terminal stream — matches what you see on screen | **Merged** — all lines recorded as `stdout`; `--stderr` filters return nothing |
| Pipe | `--no-tty` or auto (no stdin TTY) | **Arrival order** at the capture layer (monotonic `seq`), not guaranteed to match the child’s write order | Separate `stdout` / `stderr` in JSONL — use `--stdout` / `--stderr` filters |

### Pipe mode and buffering (read this)

In **pipe mode**, stdout and stderr are separate OS pipes. The child process often **block-buffers stdout** when it is not attached to a TTY (stderr is usually unbuffered). A script that *writes* stdout → stderr → stdout in a loop may **flush** as stdout chunk, then all stderr, then remaining stdout — exactly what you see in JSONL.

`tools task` records lines in the order chunks **arrive** from the pipes (via `Promise.race` on both readers). That order is **stable and monotonic** (`seq` 1…N) but is **not** a faithful replay of interleaved write order inside a block-buffered child.

For Metro/Vite/interactive dev servers, prefer **PTY mode** (default when stdin is a TTY). Use pipe mode for CI/agents without a TTY; use `--stderr` / `"out":"stderr"` in JSONL for stream attribution, not write-order archaeology.

## Log window defaults

`logs` defaults to the **last 50 lines** in a TTY; `tail` shows the last 10 before follow. When stdout is **not** a TTY (pipes, agents), both default to **`--all`** so nothing is silently truncated.

Use `--head N` / `--tail N` for windows, `--head X --tail Y` for first+last with an elision marker, or `--all` for the full session. `--grep PAT` implies `--all` unless you also pass `--head` / `--tail`.

```bash
tools task logs --session metro --all --raw | grep TOKEN
tools task logs --session metro --from-seq 1 --jsonl | rg error
tools task logs --session metro --head 5 --tail 5 --raw
```

## Dashboard auto-start

The dashboard at `http://localhost:7243` is **NOT** automatically started by `tools task run`. To launch it:

```bash
tools task dashboard up         # foreground (Ctrl+C to stop)
tools task dashboard open       # open in browser (starts if not running)
```

If you see :7243 listening when you did not start it, another GenesisTools dashboard is sharing the port — see `src/utils/ui/dashboards.ts` for the canonical registry.

## Wait for a session

Block on session completion or a pattern. Replaces the `until grep -qE …; sleep 5; done` polling idiom.

```bash
# Wait for dev server "ready" sentinel, max 60s
tools task wait --session metro --exit-on-match "Bundled" --timeout 60

# Wait for session to exit, propagate exit code
tools task wait --session jest --propagate-exit

# Or follow live and exit with the child's code when the session ends
tools task tail --session jest --follow --propagate-exit
```

Exit codes: 0 on match or normal exit (without `--propagate-exit`), child's code with `--propagate-exit`, 124 on timeout.

## Retention

Sessions older than `sessionRetentionDays` (default **30**) are GC'd on the next `tools task run` when `gcOnRunStart` is true (default). Configure interactively or via flags:

```bash
tools task config                              # print current config (JSON)
tools task config --session-retention-days 14  # example: shorter retention
tools task config --gc-on-run-start off        # disable opportunistic GC
```

Config file (same values): `~/.genesis-tools/task/config.json`. Manually: `tools task clean --all`, or `tools task clean --session <name>`.

## vs shell `tee`

Use `task` when you need ordered stdout/stderr interleaving, seq navigation, agent-friendly `get`, and dashboard integration. Use plain `tee` when you only need a single combined file.
