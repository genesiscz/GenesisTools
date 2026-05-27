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

Reusing a name that already has a `.jsonl` on disk **does not wipe** the old session. The run is assigned a suffixed id such as `metro-2026-05-26_14-30-22`, printed immediately on stderr before the banner:

```text
note: session "metro" already exists — using "metro-2026-05-26_14-30-22"
task-session-id: metro-2026-05-26_14-30-22
```

Use `tools task get --session <full-id>` or pick the suffixed name from `tools task sessions` (see **Related:** in `get`).

When **`--session` is omitted**, `get` / `logs` / `tail` auto-resolve: explicit `--session` flag → fuzzy match → sole active session → error if ambiguous. Use `tools task sessions` to list all.

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

## vs shell `tee`

Use `task` when you need ordered stdout/stderr interleaving, seq navigation, agent-friendly `get`, and dashboard integration. Use plain `tee` when you only need a single combined file.
