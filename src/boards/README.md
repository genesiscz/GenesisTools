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
| `operator [name]` | Show or set the operator identity attributed to your board writes. |

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
tools boards push [--dir <path>] [--title <title>] [--source <source>] [--base <url>] [--actor <name>]
```

Requires `tools boards init` to have run first. `--title`/`--source` are persisted back into
`.boards.json` for next time.

### board-from-set — create a board and import the pushed set

```bash
tools boards board-from-set [--slug <s>] [--title <t>] [--dir <path>] [--base <url>] [--actor <name>]
```

Creates a board (slug defaults to the set key, lowercased) — or reuses it if it already
exists — then imports the current set's images as cards in a serpentine layout.

### operator — the identity attributed to your writes

```bash
tools boards operator                # prints local + server-default identity
tools boards operator <name> [--base <url>]
```

Persists `<name>` both locally (`~/.genesis-tools/boards/operator`) and as the server's
default (`PUT /api/boards/operator`), then that name attributes `push`/`board-from-set`
writes via the `X-Board-Actor` header (or pass `--actor <name>` on either command to
override just that one write). Falls back to the literal `"operator"` if never set.

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
- An expired-but-unreaped-holder conflict prints `⚠ boards scope held by expired listener
  <session> → retry with --takeover to steal the expired lease` and exits `2`. Pass
  `--takeover` to steal it immediately instead of waiting for the next automatic reap —
  it only ever steals an EXPIRED lease (past TTL); a live holder always wins.
- A sustained outage (≥120s unreachable) prints `⚠ boards unreachable for <n>s — listener
  degraded` (re-emitted at most every 10 minutes) and `✓ boards reachable again` on recovery.
- SIGINT/SIGTERM releases the lease (`DELETE /api/boards/work/listeners/:id`) before exiting 0,
  which immediately reverts any work the listener had claimed.
- An MCP client's `boards_wait_for_work` called anonymously (no session) never leases, so it
  freely coexists with a live `watch` listener on the same scope — it just drains whatever's open.

### Staged → dispatch: how annotations reach `watch`/`wait_for_work`

Annotations don't necessarily go straight to `open` (the status this listener/MCP surface
picks up). A user's REPLY on an `in_review` or `resolved` thread — and a reject verdict —
re-stage it to `staged`, held until the user presses the board's "Send to Claude" bar
(`POST /api/boards/:slug/dispatch`), which flips every `staged` annotation to `open` in one
shot and wakes any waiting `watch`/`wait_for_work` listener. Replies on a `working` thread
are left alone (an active worker isn't interrupted). The same staged→dispatch gate holds
answered AI-expression-layer questions (§ below) off the work wire until dispatch too.

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

`boards_list_work`'s items carry an enriched shape beyond the bare id/status: `intentOther`
(the custom label when `intent:"other"`), `boardTitle`, and the source `setRef`/`file` — so an
agent orienting on a fresh work item rarely needs a follow-up `boards_get_annotation` call.

---

## AI expression layer (compose / arrange / questions)

Beyond the fix-loop above, boards are also a PRESENTATION surface: `boards_compose_board`
places a whole batch of markdown/viz/section/question cards in one call (never one card per
call), `boards_arrange` auto-layouts them server-side (13 modes, `save:true` for a
self-maintaining section), `boards_scrape_board` reads a whole board back as a structured
digest (optionally scoped to one journey `section`, or diffing two sections pairwise), and
`boards_ask_board`/the board's own UI let a question get answered with one click instead of
prose — answers are STAGED like annotations, released onto the work wire by the same
"Send to Claude" dispatch. Call `boards_get_templates` once per new board for compose-ready
skeletons (QA session, iteration review, decision map, dashboard, presentation deck) instead
of inventing structure. Full tool schemas are self-documenting via MCP `tools/list`; this
README stays CLI-focused.

**Known divergences from vitrinka** (the reference implementation this was ported from):
`boards_wait_for_work` claims a real lease keyed `session=hostname:pid` (vitrinka's own MCP
tool waits anonymously — GT's CLI `watch` needs a real lease to coordinate with other watchers,
so the MCP tool inherited the same mechanism for consistency); `CompareDeck`'s reject verdict
stages the thread (`status → "staged"`) rather than vitrinka's reply-only rejection UX, since
GT kept a dedicated reject affordance on pending attempts.

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
