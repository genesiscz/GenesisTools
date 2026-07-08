# tools boards

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Runtime](https://img.shields.io/badge/Runtime-Bun-orange?style=flat-square)

> **Push a directory of screenshots as a versioned set, spin up an annotation board from it, and listen for live review work as a zero-token-idle background process.**

Talks HTTP only, to `http://127.0.0.1:3042` by default (the loopback dev-dashboard server) —
no database/file access, no auth tokens needed.

---

## Quick Start

```bash
tools boards init --project my-app                  # writes .boards.json
tools boards add ./screenshot.png --route /home
tools boards push                                    # tar+push as a new set version
tools boards board-from-set                          # create/reuse the board, import cards

tools boards watch                                   # zero-token-idle listener, blocks
tools boards watch --board my-board --once           # single check, for scripting/CI
```

---

## Commands

| Command | Purpose |
|---------|---------|
| `init` | Create (or print) the sticky set config for this capture directory. |
| `add <file>` | Copy a screenshot into the capture root and append it to the manifest. |
| `push` | Tar+push the capture root as a new set version. |
| `board-from-set` | Create (or reuse) a board and import the current shot set. |
| `watch` | Long-poll for open annotation work; print one line per new-or-changed item. |

### init — create the sticky set config

```bash
tools boards init [--project <name>] [--branch <name>] [--key <key>] [--kind <kind>] [--dir <path>]
```

Writes `.boards.json` into the capture root (default `<cwd>/.screenshots`), defaulting
`--project` to the git repo's basename and `--branch` to the current git branch. Idempotent:
running it again just prints the existing config. Also appends the capture root to
`.git/info/exclude` (never `.gitignore`) so screenshots stay untracked without dirtying the repo.

### add — capture a screenshot into the set

```bash
tools boards add <file> [--route --label --title --note --action --dir]
```

Copies `<file>` into the capture root (basename collisions get a `-2`, `-3`, ... suffix) and
appends an entry to `manifest.json`.

### push — tar+push the capture root as a new set version

```bash
tools boards push [--dir <path>] [--title <title>] [--source <source>] [--base <url>]
```

Requires `tools boards init` to have run first. `--title`/`--source` are persisted back into
`.boards.json` for next time.

### board-from-set — create a board and import the pushed set

```bash
tools boards board-from-set [--slug <s>] [--title <t>] [--dir <path>] [--base <url>]
```

Creates a board (slug defaults to the set key, lowercased) — or reuses it if it already
exists — then imports the current set's images as cards in a serpentine layout.

### watch — the zero-token-idle listener

```bash
tools boards watch [--board <slug> | --project <p> [--branch <b>] | --all] [--once] [--base <url>] [--takeover]
```

Long-polls `/api/boards/work/wait` and prints one line per new-or-changed open annotation:

```
№17 [fix] my-board: tighten the spacing on the header row
```

**stdout is the contract** — a background monitor (e.g. `Monitor`) watches these lines to
decide whether to wake an idle agent. Silence means healthy + idle. Diagnostics go to stderr.

- No flag → scope inferred from the cwd's git project + current branch.
- `--once` → single wait cycle (`timeout=1`) then exit: `0` if it announced anything, `3` if idle.
- A live-holder conflict (HTTP 409 on the leased scope) prints `⚠ boards scope held by live
  listener <session>` to stdout and exits `2`.
- A sustained outage (≥120s unreachable) prints `⚠ boards unreachable for <n>s — listener
  degraded` (re-emitted at most every 10 minutes) and `✓ boards reachable again` on recovery.
- `--takeover` is accepted for parity with the server's query param but is a no-op — expired
  leases are reaped automatically at the top of every wait.
- SIGINT/SIGTERM releases the lease (`DELETE /api/boards/work/listeners/:id`) before exiting 0,
  which immediately reverts any work the listener had claimed.
- An MCP client's `boards_wait_for_work` called anonymously (no session) never leases, so it
  freely coexists with a live `watch` listener on the same scope — it just drains whatever's open.

---

## Listening from Claude Code

`watch`'s stdout is a wake signal, not a work queue — draining still goes through the MCP
tools (which carry the full capsule per item, not just the one-line announcement):

```text
Monitor({ command: "tools boards watch --board my-board", persistent: true })
→ on each stdout line, drain with boards_wait_for_work({ board: "my-board", timeoutSec: 1 }) until idle.
```

Scope every `list_work`/`wait_for_work` call to the board (or project+branch) you're working
in — an unscoped call surfaces every board's queue, and items belonging to other boards/sessions
should be left alone.

---

## Environment variables

- `BOARDS_BASE_URL` — override the dev-dashboard base URL (default `http://127.0.0.1:3042`).
  Every command also accepts an explicit `--base <url>` flag (`watch`, `push`, `board-from-set`).

## Manual smoke test

```bash
tools dev-dashboard agent --port 3113 &
BOARDS_BASE_URL=http://127.0.0.1:3113 tools boards init
BOARDS_BASE_URL=http://127.0.0.1:3113 tools boards add ./shot1.png --label "home"
BOARDS_BASE_URL=http://127.0.0.1:3113 tools boards push
BOARDS_BASE_URL=http://127.0.0.1:3113 tools boards board-from-set
BOARDS_BASE_URL=http://127.0.0.1:3113 tools boards watch --once
```
