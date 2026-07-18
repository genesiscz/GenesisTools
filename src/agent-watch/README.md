# agent-watch

Notify when background AI agents **finish**, **stall**, or **need your input** — instead of you tabbing back to check on them.

```bash
tools agent-watch                 # live watch (default), notify via terminal
tools agent-watch status          # one-shot table of every tracked agent
tools agent-watch list            # discovered agents (id + source)
```

## What it watches

| Source | Files | Finish detection | Input detection |
|---|---|---|---|
| `task` | `~/.genesis-tools/task/sessions/*.jsonl` (+ `*.meta.json` sidecar) | trailing `exit` line, sidecar `exitCode`, or dead pid | — |
| `claude` | `~/.claude/projects/*/*.jsonl` transcripts | trailing `result` record | trailing `AskUserQuestion` tool use, or an ended turn (`stop_reason: end_turn`) |
| `workflows` | `~/.claude/projects/**/subagents/workflows/**` | — (mtime only, v1) | — |

States: `RUNNING`, `FINISHED`, `STALLED` (no output past `--stall-timeout`), `AWAITING-INPUT`.

## Notifications

Fires only on a **state transition** into a notable state (`FINISHED` / `STALLED` / `AWAITING-INPUT`). In continuous mode the first sweep just seeds the baseline silently — states that were already notable before you started never replay as a storm. With `--once` (cron mode) currently-notable agents inside the active window DO fire; that is the point of a single shot.

Channels ride the existing `notify` stack (`dispatchNotification`, app `agent-watch`): `--notify terminal,say,telegram` or `none`. Channel *configuration* (telegram token, voice) lives in the shared notify config — a channel disabled there stays silent even when requested here.

## Flags

- `--stall-timeout <seconds>` — silence before `STALLED` (default 120)
- `--sources <names>` — `task,claude,workflows` (default all)
- `--active <minutes>` — ignore agents whose last activity is older (watch default **60**; status/list default 0 = show all)
- `--poll <seconds>` — re-sweep cadence; the poll is load-bearing, a stall produces no fs events (default 5)
- `--once` — single pass then exit (cron-friendly)
- `--json` — machine output on stdout (status snapshot / one event per notification)

## Design

Two pure, injected-time cores carry the logic — `classifyAgentState` (exit → question → dead-pid → stale → running) and `shouldNotify` (transition gate) — everything else is thin glue: source adapters, a chokidar tail + poll re-sweep watcher, three commands. Tests are hermetic (temp dirs, stubbed notifier, injected clocks).

## Caveats

- Claude "ended turn" = `AWAITING-INPUT`: an interactive session you simply walked away from counts as waiting for you — that is the intended semantic, scoped by `--active`.
- Workflow dirs have no finish detection in v1: an untouched dir past the timeout reads `STALLED`; completed workflows age out of the active window.
- Permission prompts that never reach the transcript (OS dialogs) are invisible to the `claude` source.
