# tools hub

The agent hub of GenesisTools.app: one window for your Claude, Codex and Grok sessions, their worktrees, your PRs and
MRs, an activity feed, an inbox and AI usage. `tools hub` opens the window (it builds the app first when it is missing
or older than its Swift sources). The subcommands are the hub's data doors: the window calls them, and you or an agent
can call them too, mostly with `--json`.

## Quick start

```bash
tools hub                                    # open the hub window; a running hub comes forward instead
tools hub open --pr owner/repo#42            # open the hub on one PR's review
tools hub board                              # every live agent session, its phase and its prompt
tools hub triage --mine                      # my open PRs, ready ones first
tools hub timeline --range today --needs-me  # what waits for me today
tools hub nav open '#42' --note "the PR whose tests fail"   # an agent opens a place, and the person can go Back
```

## Commands

`tools hub --help` lists every group, and `tools hub <group> <command> --help` shows every flag. Most commands take
`--json`. The groups below are ordered by job.

### The window

```bash
tools hub [open] [flags]          # open the hub window (open is the default command)
tools hub status [--json]         # exit 0 when GenesisTools.app with the review window is installed, else 1
tools hub nav open|list|configure # the navigation history (see "History" below)
tools hub link <commit> [--repo]  # print the hub link for a commit or a range
tools hub dev monitor             # stream the app's hangs, stalls, frame drops, crashes and command deadlines
```

#### Open the hub at a place

```bash
tools hub open --mode prs                        # sessions|worktrees|prs|inbox|timeline|agents|usage (default sessions)
tools hub open --session <id or prefix> --tab changes    # tab: transcript|changes|files|decisions
tools hub open --agent <id> --session <parent>   # one sub-agent or worker in the Agents mode
tools hub open --pr owner/repo#42                # a PR or MR: 42, owner/repo#42, group/app!12, or its page URL
tools hub open --pr owner/repo#42 --reveal src/x.ts      # that file in the PR's review
tools hub open --pr owner/repo#42 --commit 4e7a3bc       # that commit selected in the PR's review
tools hub open --repo owner/repo --commit 4e7a3bc        # a commit with no PR, in its project's diff
tools hub open --repo owner/repo --commit 4e7a3bc..9f1c2d0   # a run of commits, both ends included
tools hub open --repo ~/Projects/app --commit 4e7a3bc
tools hub open --worktree ~/Projects/app         # the Worktrees mode on that checkout
tools hub open --worktree cleanup                # the Worktrees cleanup panel (cleanup-blocked: with blocked ones)
tools hub open --no-activate                     # open behind the window in front, without focus
tools hub open --no-build                        # never build; fail when the app is missing or stale
```

`--commit` takes 7 to 40 hex characters, or `<from>..<to>`, a run of commits with both ends included (with `--pr` or
`--repo`). A prefix is enough, because the hub matches it against the PR's full shas. `open --help` names only the
single sha, but the range passes the same check (`isHubCommitSha` in `src/hub/lib/pr-ref.ts`). `--worktree` takes a
checkout path, or `cleanup` or `cleanup-blocked`, which open the Worktrees cleanup panel instead of a checkout
(`cleanup-blocked` also shows the worktrees that cannot be removed). The PR and repository forms have these separate
outcomes:

| Link inputs | Outcome |
| --- | --- |
| `pr` + `commit`, commit belongs to the PR | Select that commit in the PR diff. |
| `pr` + `commit`, commit absent from the PR | Show the whole PR and a missing-commit notice. |
| `repo` + `commit` | Open the commit in the project's Worktrees diff. |

A missing PR commit does not trigger a project-diff lookup. To open that commit in its project instead, use `--repo`
with `--commit` and omit `--pr`.

`--repo` names an absolute checkout path, an explicit relative checkout path (`.`, `./app`, `../app`), or a forge path
(`owner/repo`, `group/sub/app`). The CLI resolves relative checkout paths. Forge paths map to checkouts under the repo
roots (`tools hub pr projects` lists them).

Panels and overlays that `open` can show at once:

| Flag | Opens |
| --- | --- |
| `--filter <text>` | the session list, filtered (also searches every project's history) |
| `--palette [text]` | the command palette (⌘K), for example `'gt pr 424'` |
| `--find [text]` | find in files (⌘⇧F) |
| `--session-search [text]` | the transcript search over every session (⌥⌘F) |
| `--digest` | the Today digest (⌥⌘D) |
| `--rules` | the notification rules panel |
| `--prompts` | the prompt library picker (⌘⇧P) |
| `--handoff` | the handoff composer for `--session` (or the selected session) |
| `--usage-section [s]` | the Usage mode at a section (list below) |
| `--usage-session <id>` | the Usage mode at one session (with `--usage-harness`) |
| `--usage-account <a>` | the Usage mode with this account selected (repeatable) |

- `--usage-section` takes `limits`, `spend`, `waste`, `attribution`, `efficiency`, `plans`, `agents` or `session`.
- `--usage-harness` is `claude`, `codex` or `grok`. `--usage-all-accounts` selects every account.

`--print-url` carries only the place flags that "Links" below lists (`--mode`, `--session`, `--pr`, `--filter`, the
Usage flags and the rest). The overlay flags (`--palette`, `--find`, `--session-search`, `--digest`, `--rules`,
`--prompts`, `--handoff`) are not link keys: a printed link drops them, and they open only through `tools hub open`.

#### History: Back, Forward and who went where

The hub keeps a log of every place it showed, with who took it there: `user` (a click, a key or a menu in the hub),
`agent`, or `link` (a link or `tools hub open` that named nobody). An agent adds why. The top-left arrows (⌘[ and ⌘])
walk it, and the clock button beside them (⌘Y) lists it, newest first. A click hops to any entry. A new place never
replaces the old one: Back always returns.

**Agents open things with `nav open`, not `open`**, so the person sees why and can go back:

```bash
tools hub nav open '#563' --note "the PR whose Swift suite fails"
tools hub nav open --repo ~/Projects/app --commit 4e7a3bc --note "the commit that moved the focus"
tools hub nav open 'genesis-tools://hub?pr=owner%2Frepo%2342&commit=4e7a3bc' --note "why"
tools hub nav list [--json] [--limit 20]
tools hub nav configure --keep 300               # keep the newest 300 entries and prune now
```

`nav open` takes a hub link, a PR ref or page, a commit sha or a `<from>..<to>` run of commits (with `--pr` or
`--repo`), a checkout folder, or the `open` flags (`--mode`, `--session`, `--agent`, `--tab`, `--reveal`,
`--worktree`, `--no-activate`, `--no-build`). It records the entry in the hub's own database
(`~/.genesis-tools/hub/data.db`), then opens the hub on it. `--actor` defaults to `agent` inside an agent session (its
id goes in as `--from`), else `link`. `--print-url` prints the link with the actor, note and session instead of
opening and recording, in the same two forms as `open --print-url` (see "Links").

Settings → Hub → History sets how many places are kept (200 by default) and whether an agent's place is shown at once
(the default) or only added to History. Every entry writes one `hub nav:` line to the day log. `nav record` is the
app's own door for storing an entry; you do not need it.

#### Links

`--print-url` prints the link for the place flags instead of opening:

```bash
tools hub open --print-url --pr 'owner/repo#42' --commit 4e7a3bc
# with the genesis-hub router preset on (see below):
#   https://<link host>/hub?pr=owner%2Frepo%2342&commit=4e7a3bc
# without it:
#   genesis-tools://hub?pr=owner%2Frepo%2342&commit=4e7a3bc
```

It prints the `https://` router link when `tools browser-router presets enable genesis-hub` is on and the router
serves `/hub` on this Mac, and the `genesis-tools://` link otherwise (`hubPrintUrl` in `src/hub/lib/open.ts`).

A `genesis-tools://hub?…` link opens the hub where it points, with or without the browser router. Its keys are the
`open` flags without dashes: `mode`, `session`, `agent`, `pr`, `reveal`, `commit`, `repo`, `tab`, `filter`,
`worktree`, `decision`, `question`, the Usage place (`usage-section`, `usage-session`, `usage-harness`,
`usage-account`, and `usage-all-accounts=1`), and for the history `actor` (user, agent, link), `note`, `from` (the
agent's session) and `nav` (an entry `nav open` stored). The list is `HubLink.linkKeys` in
`src/macos/GenesisTools/Sources/Host/HubLink.swift`. Every other key is dropped: a link shows a place, it never runs a
command. The `#` of a PR ref must be written `%23`.

Through the browser router, the same query on the link host opens the hub as well, so a terminal or a chat that only
makes `https://` links clickable works too:

```bash
tools browser-router presets enable genesis-hub
# https://<link host>/hub?pr=owner%2Frepo%2342&commit=4e7a3bc
#   opens genesis-tools://hub?pr=owner%2Frepo%2342&commit=4e7a3bc
```

`tools hub link <commit>` is the way to write a commit link. It asks the forge which PR or MR holds the commit (GitHub
`commits/{sha}/pulls`, GitLab `repository/commits/{sha}/merge_requests`) and prints a link into that PR, else into the
commit's project. It takes a range too (`<from>..<to>`). `--repo` names the checkout, the forge project or a checkout
folder name under the repo roots (default: this folder's). `--fresh` asks the forge again instead of reusing its answer
from the last minutes. `--json` adds the PR, the candidates and notes.

### Agents and sessions

```bash
# every live Claude, Codex and Grok session: phase, stuck verdict, prompt, sub-agents
tools hub board [--json]
tools hub board send <key> <text...> [--timing now|next-turn|later] [--idempotency-key <k>]
# end the running turn with the TUI's Esc key (refused while a dialog is open)
tools hub board esc <key>
tools hub board stop <key> --pid <pid> [--yes]   # end the session's process tree (SIGTERM, then SIGKILL)
tools hub agents [--since 24h] [--limit 50] [--session <id>] [--agent <id>] [--json]
tools hub agents mail --session <id> --agent <id>          # one teammate's mail: received, sent, not delivered yet
tools hub agents counts --session <id> --ids <a,b>         # tool calls, last activity and size of a few agents
tools hub procs [--orphans] [--energy] [--json]  # agent CLIs with their process trees: CPU, memory, age, orphans
tools hub procs --stop <pid> [--grace 5]         # SIGTERM a tree, SIGKILL after the grace period
tools hub procs --stop-orphans [--yes]           # stop every orphan tree (asks first)
tools hub stuck check [--session <ids...>]       # agents that look stuck: a call waiting too long, or a loop
tools hub stuck config [--tool-minutes 10] [--repeats 5] [--max-age-hours 6] [--active-minutes 30] [--reset]
tools hub insights <session> [--max-cache-age <s>]   # per-prompt tokens, list-price cost, tool analytics, stuck verdict
tools hub handoff <session> [--last 5]           # a markdown handoff of a range of prompts, from the transcript alone
tools hub search <query...> [--provider claude,codex,grok] [-p <project>] [--since <date>] [--until <date>] [-l 30]
tools hub approvals [--json]                     # tool calls that wait for allow or deny
tools hub approvals answer <id> --verdict allow|allow-always|deny [--reason <text>]
# what waits on the Mac's Touch ID: vault and AI account windows, rm requests
tools hub gates [--json]
tools hub gates raise <id>                       # bring that window to the front (or open an rm request's window)
```

- `board` keys come from `tools hub board`. `board stop` refuses a session that now runs under another pid than the
  one you pass. `board send --timing later` queues the message.
- `stuck` thresholds: a call waiting `--tool-minutes` (10) is stuck, `--repeats` (5) identical calls in a row is a
  loop, a call older than `--max-age-hours` (6) belongs to a dead session, and a loop counts only while its last call
  is at most `--active-minutes` (30) old. Long tools (`Agent`, `Task`, `Workflow`, `Monitor`) never count as waiting
  too long. `stuck check --tool-minutes` and `--repeats` change one run only.
- `handoff` makes no model call. `--from <n>` and `--to <n>` pick prompts by the `#N` the transcript shows. `--out
  <dir>` writes `handoff-<id>-p<from>-<to>.md`, `--copy` copies it, and `--post` posts it to the handoff store (its
  open items become tasks; `--owner` and `--project` go with `--post`). `--title`, `--cwd`, `--branch` and
  `--account` fill the resume line.
- `search` reads each provider's indexed history; `--limit` is per provider and in total (default 30, at most 200).
- `approvals answer` presses the pane's keys through cmux, or uses a Codex worker's control channel.

#### Saved prompts

```bash
tools hub prompts list                                   # most used first, with their variables
tools hub prompts add review "Review {{pr}} on {{branch}}" --description "a quick review"
tools hub prompts prepare review --session <id> --var pr=42   # render only: each variable's value and source
tools hub prompts send review --session <id> [--dry-run]      # type it into the session's cmux pane
tools hub prompts remove review
```

`{{name}}` marks a variable. `branch`, `pr`, `cwd`, `project` and `session` fill themselves from the session's folder.
A multi-line prompt goes into a file, and a one-line pointer to it is typed. `add --file <path>` (or `-`) reads the
text from a file or stdin, and `--replace` overwrites a prompt of the same name and keeps its use count.

### Activity and reports

```bash
tools hub timeline [--range hour|24h|today|yesterday|7d|30d] [--needs-me] [--author all|me|others] [--json]
tools hub timeline --since 09:00 --until 12:00 --kinds commit,push,pr
tools hub timeline detail --kind commit --id commit:<sha> --repo ~/Projects/app
tools hub digest [--date today|yesterday|YYYY-MM-DD] [--markdown] [--export [--folder <path>]] [--no-prs]
tools hub digest config --folder ~/Notes/Daily         # where --export writes; --clear forgets it
tools hub forecast [--provider anthropic-sub|openai-sub|grok-sub] [--account <name>]
# harnesses, accounts ranked by headroom, repos to start an agent in
tools hub launch [--json]
tools hub glance [--json]                              # what waits for you, the fleet and the closest limit
tools hub watching [--json]                            # every watch on the Mac: Monitor, domains, shops, TradingView
tools hub watching mute monitor <id> [--minutes 120]   # 0 lifts the mute; only Monitor watchers can be muted
```

`watching` also has a Hotels source, which always shows no rows and a note: the hotels tool is not on this branch yet.

- `timeline` shows sessions, commits, pushes, PR events, review comments, decisions and CI results, 300 events a page
  (`--limit`, at most 1000). `--before <iso>` takes the previous page's `nextBefore`. `--since` takes `HH:MM` today, an
  ISO date (local midnight) or an ISO time, and overrides `--range`. `--kinds` takes `session.start`, `session.turn`,
  `commit`, `push`, `pr`, `thread`, `decision` and `ci`. `--no-prs` skips the PR list, the one network call.
- `timeline detail` is what one Activity row folds open to. `--kind` is one of `session`, `commit`, `push`, `pr`,
  `thread`, `decision`, `ci`, and `--id` is the row's id. It takes `--repo`, `--pr`, `--session`, `--from`, `--since`,
  `--until` and `--file` (one file of a commit) as the kind needs.
- `digest` covers one day: sessions, commits, files changed, PRs opened and merged, decisions posted and answered.
- `forecast` says when each AI account's 5-hour window (where it has one) and weekly window run out at the recent burn
  rate. It reads recorded usage snapshots only and never fetches. `launch` also reads cached readings only.

### PRs and reviews

The `pr` group serves the hub's PRs mode and review window. It talks to GitHub through `gh` and to GitLab through
`glab`. Most write commands find the PR from the checkout's branch (`--repo`, default the current directory) or take
`--pr <url or <repoPath>#<n>>` for a detached review worktree.

Read only:

```bash
tools hub pr list ~/Projects/app [--state open|merged|all] [--mine] [--limit 30] [--query <q>]
tools hub pr show <url or ~/Projects/app#42> [--head <sha>]  # body, commits, checks, merge state
tools hub pr projects                                       # every GitHub/GitLab project cloned under the repo roots
tools hub pr find [--repo .] [--branch <name>]              # the PR/MR of the checked-out branch
# review threads with positions, authors, reactions, my drafts
tools hub pr threads [--repo .]
tools hub pr versions [--repo .]                            # every push: head, merge base, time, pusher, commits
tools hub pr sessions --repo ~/Projects/app --branch feat/x # agent sessions that touched the PR
tools hub pr check-log <check url> [--lines 150]            # the failing part of a CI check's log
# ready to merge? threads, CI, last review vs last push, conflicts
tools hub pr readiness <refs...>
tools hub pr fetch ~/Projects/app#42 [--head <sha>]         # the PR head into refs/genesis/pr/42/, no checkout
# checkout, branch, origin pages and (with --pr) the PR, as JSON
tools hub repo <paths...> [--pr]
tools hub triage [--mine] [--limit 30]                      # open PRs with readiness, threads and CI, ready ones first
tools hub triage checks <pr url>                            # a PR's checks and the log tail of its first failed one
```

- `pr list --query` searches on the host: `author:<name>` or `@<name>`, `#123` or `!123` for that PR or MR in any
  state, other words match title and description, and a bare `123` is both. GitLab pages past 100.
- `pr sessions` always scans fresh from the CLI. `--max-cache-age <s>` serves a cached match at most that old. Its
  `--help` description says "cached 60 s", but 60 s is only the library default for a caller that passes no age; the
  CLI passes 0 unless you give `--max-cache-age`.
- `pr readiness` caches per head SHA: append `@<headSha>` to a ref when you know the head.
- `pr fetch` changes no branch, tag or working tree.

Write:

```bash
tools hub pr reply --thread <id> --body-file reply.md [--draft]       # published at once, or pending with --draft
tools hub pr draft add --path src/cart.ts --line 14 [--start-line 10] [--side additions|deletions] --body-file c.md
tools hub pr draft update <draftId> --body-file c.md
tools hub pr draft delete <draftId>
tools hub pr comment --path src/cart.ts --line 14 --body-file c.md    # a NEW comment, visible at once
tools hub pr resolve <threadId> [--unresolve]
tools hub pr publish [--approve | --request-changes] [--body-file summary.md]
tools hub pr fix --threads <id,id> [--session <id>] [--dry-run]       # send threads to the branch's agent session
tools hub pr fix-check --check <check url> --name <check name> [--dry-run]
```

- **`pr publish` publishes ALL your drafts as one review that everyone sees.** It is a COMMENT review unless
  `--approve` or `--request-changes` (the latter GitHub only). On GitLab it is a bulk publish, and `--approve` also
  approves the MR.
- `--body-file -` reads stdin. A published comment cannot be changed with `draft update` or `draft delete`.
- `pr fix` and `pr fix-check` never write to the PR. They write a task file, send it to the best live session that
  worked on the branch (or `--session`), and focus its cmux pane. `--no-send` only writes the task and prints the
  prompt (to start a new agent), `--no-focus` skips the pane focus, and `--no-activate` focuses without raising cmux.

#### Review proposals

An agent writes a review as a proposal (a verdict, draft comments anchored to lines, and its analysis), and the person
accepts, edits or rejects each draft in the review window. The `genesis-tools:review-proposal` plugin skill writes them.

```bash
tools hub proposal push review.json --open       # validate and store (or - for stdin); keeps decisions already made
tools hub proposal list [--provider github --host github.com --project owner/repo --number 42]
tools hub proposal show <key> [--json]           # markdown (json2md), or the stored JSON
tools hub proposal decide <pr url> <draft id> accepted|edited|rejected|proposed [--body-file edited.md]
tools hub proposal publish <pr url> [--approve | --comment] [--drafts-only]
tools hub proposal discard <pr url>              # reject every draft not sent yet
```

**`proposal publish` posts the accepted and edited drafts and publishes them as one review** with the agent's verdict
(or `--approve`, or `--comment`). `--drafts-only` posts the drafts and stops; publish them later with `pr publish`.

### Notifications

```bash
tools hub notify status                          # config, last poll, each repo's backoff, request rate, recent events
tools hub notify set --repo ~/Projects/app --repo-enabled on   # watch this repo (none is watched by default)
tools hub notify set --interval 5 --only-mine on --event ciPassed=on
tools hub notify set --repo ~/Projects/app --repo-enabled off  # stop watching it
tools hub notify set --enabled on|off            # the master switch (on by default)
tools hub notify poll [--dry-run] [--force]      # one poll now
tools hub notify test [--pr owner/repo#42]       # one test notification whose click opens the hub
tools hub notify install | uninstall             # the hub-pr-notify daemon task
tools hub notify events                          # the event names and what each one posts
tools hub rules list
tools hub rules add --kind idle --minutes 20 [--project app] [--label "idle agent"]
tools hub rules add --kind context --percent 80
tools hub rules set <id> --enabled off
tools hub rules rm <id>
tools hub rules test                             # what would notify now; posts and saves nothing
tools hub rules run                              # evaluate and post what is new (what the daemon tick does)
tools hub ping add <board key> [--label <text>]  # push to the phone when this session's turn ends
tools hub ping rm <board key>
tools hub ping check                             # what the minute daemon task runs
```

- A poll reads only the repos you turned on one by one with `--repo <path> --repo-enabled on`. The watch list starts
  empty, so a poll with no watched repo does nothing and reports "no repo is watched".
- PR events: `thread` (new review threads), `reviewRequested`, `ciFailed`, `ciPassed`, `botReview` (a review bot
  finished) and `merged`. All are on by default except `ciPassed`. A repo polls every 3 minutes by default
  (`--interval`, 1 to 60). `--event` and `--interval` with `--repo` set that repo only; `--reset-repo-events` and
  `--reset-repo-interval` make it follow the global switches again. `--bots <logins>` adds logins that count as review
  bots.
- Rule kinds: `idle` (`--minutes` without activity), `decision`, `ciFailed` (`--match` filters by
  `owner/repo#number`) and `context` (`--percent` of the model's context window). `--project` scopes idle, decision
  and context rules. In `rules set`, `''` clears a scope, filter or label.
- `ping add` registers the `hub-ping-when-done` daemon task, which runs `ping check` every minute. A push carries the
  agent's last lines, and the watch is removed after it.

### Worktrees

```bash
tools hub worktrees list [repos...] [--older-than <days>] [--base <ref>] [--live-minutes 30]
tools hub worktrees size <paths...>              # clone-aware size and the floor of what removing frees
tools hub worktrees remove <paths...> [--yes]    # git worktree remove, never --force; branches stay
tools hub worktrees move-aside <paths...> [--yes]
```

A worktree is removable when it is merged, clean, has no stash and nothing runs in it. An agent session written in the
last `--live-minutes` (30) still uses its folder. `remove` and `move-aside` re-check every path before they act.
`move-aside` deletes nothing: it runs `git worktree move` into `/tmp/<YYYYMMDD>-agents-removals/hub-worktrees`
(cleared at reboot), logs each move in `~/.genesis-tools/hub/moved-aside.jsonl`, and prints the restore command.
`size` uses the `tools du` core.

### Phone and personal

These feed the phone app and its widgets.

```bash
# the morning brief: when to leave, weather, the night's work, decisions, resets
tools hub brief [--refresh] [--push]
tools hub brief config --from <place> --to <place> --leave-after 07:00 --window 2 --at 06:00 --since 18:00
tools hub brief config --no-commute              # ask Waze nothing
tools hub brief schedule | unschedule            # the daily hub-morning-brief daemon task
tools hub wake [--json]                          # the wakeup relay the phone uses to wake this Mac
tools hub timesheet [--date 2026-05-04]          # the Clarity week of a date: tasks, hours per day, unmapped time
tools hub timesheet fill --revision <hash> [--yes]   # write that week, if it still matches the revision you saw
# a page as Markdown, or a video queued for transcription, into today's inbox note
tools hub vault clip <url> [--note <text>]
tools hub vault append "<text>" [--folder <path>] [--name <note>]
tools hub vault config [--folder Inbox] [--prefix "Phone inbox"]
tools hub memos [--json]                         # Voice Memos turned into todos, a note and an agent task
tools hub memos scan                             # transcribe and split the memos since the last scan
tools hub memos act <id> reminders|note|agent [--session <board key>]
tools hub memos install                          # the hub-memo-scan daemon task, every 10 minutes
# an uploaded photo onto the widget shelf and a session's draft
tools hub snap <path> --session <id> --provider claude|codex|grok
```

- The brief defaults: built at 06:00, the overnight window starts at 18:00 the day before, departures from 07:00 over 2
  hours. `--refresh` asks Waze once (through `tools waze`).
- `timesheet` uses the Clarity dashboard's own server functions, so the phone, the dashboard and `tools clarity fill`
  plan the same rows.
- `vault` writes into the Obsidian vault the dev dashboard is configured with (`obsidianVault`). The default inbox is
  the `Inbox` folder, one `Phone inbox` note a day.
- The first `memos scan` only primes the list, so old memos are never offered.

### GenesisTools.app doors

The app calls these. You rarely need them by hand.

```bash
tools hub serve [--no-idle]                      # the resident hub server on a unix socket
tools hub serve --status [--json]                # the running server's health; exit 1 when none answers
tools hub serve --drain                          # let it finish its calls and exit (the hub starts the new code)
tools hub config get [--json]
tools hub config set --pr-lookup-cache-seconds 60    # how long repo --pr caches its lookup; 0 turns it off
tools hub nav record ...                         # the app stores one History entry
tools hub widget ...                             # the notch and side widget's data, media and outgoing messages
```

`tools hub widget` is not listed in `tools hub --help`, but `tools hub widget --help` works. Its commands:

- `snapshot`, `watch` (`--restart-on-code-change` exits with status 75 when the loaded code changes, so the widget
  restarts it), `discover`, `pin <session> --provider`, `show-decision <session> <number>`, `context <id> --key`,
  `call --input`, `prepare <id>`, `dispatch`, `readback --input`.
- `tasks list|create|edit|update`: local tasks from the decisions TODO ledger. `edit` and `update` need the
  `--revision`, `--state`, `--updated-at`, `--session` and `--provider` that `list` showed.
- `voice-notes list|add|incoming-path|record|show|edit|transcribe|discard`: private local recordings and editable
  transcripts. `transcribe --provider` takes `deepgram`, `openai`, `xai` or `elevenlabs`.
- `shelf list|import|image|video|capture|remove|attachment|attach`: captures and files staged before you pick an inbox
  recipient.
- `--state-root <directory>` moves the widget's state (default `~/.genesis-tools/hub/widget`).

## How it works

- **The window** is the hub part of GenesisTools.app. `tools hub` builds the app when it is missing, older than its
  Swift sources, or built without the hub part (about a minute on a cold build), then starts it through Launch Services
  (`open -n`), so the hub lives in your login session and not under the terminal. A hub that already runs takes the
  new flags and comes forward.
- **The resident server** (`tools hub serve`) answers the app's frequent calls (`agents`, `forecast`, `procs`, `stuck
  check`, `repo`, `proposal list`, `pr show`, `nav`, some `widget` calls) over `~/.genesis-tools/hub/server/hub.sock`,
  so the app does not start a `tools` process per call. It also serves a few reads of other tools (`meetings`,
  `ai sessions`, `question inbox`). It is started when nothing listens on the socket (at most once per 5 minutes),
  exits after 10 minutes with no connection, and drains above 512 MB of memory. Once a minute it checks whether the
  code it loaded changed, and drains itself when it did, so it restarts on new code within a minute. `serve --drain`
  restarts it at once.
- **What it calls**: `gh` and `glab` for PRs and MRs (`--mine` means the logged-in user), cmux to type into session
  panes, `tools daemon` for the scheduled tasks (`hub-pr-notify`, `hub-ping-when-done`, `hub-morning-brief`,
  `hub-memo-scan`), the notification channels of `tools notify` for pushes, `tools waze` for the commute, `tools macos
  voice-memos transcribe` for memos, `tools fetch` (a page to Markdown) and `tools youtube queue add` (a video queued
  for transcription) for `vault clip`, and the shared agent history in `~/.genesis-tools/claude-history/index.db` for
  `search` and `forecast`. `digest` is built from the timeline and the decision log.
- **Permissions**: `memos` reads Voice Memos, which needs Full Disk Access for GenesisTools.app. `tools` runs through
  the app, so the grant is the app's, and the daemon task needs it too. Check with `tools macos permissions`.
- **Costs**: `memos scan` splits each memo with an AI model, and `widget voice-notes transcribe` uses the speech
  provider you pick. Both spend from the configured AI account. `insights` shows list-price cost but calls no model;
  `handoff`, `forecast` and `launch` call no model either.

Data lives in `~/.genesis-tools/hub/`:

| Path | Holds |
| --- | --- |
| `config.json` | hub settings (keys below) |
| `data.db` | the hub's SQLite store (the History log); one file per Mac |
| `notify.json` | the PR notification config |
| `notify-state.json`, `rules-state.json` | poll state and rule state |
| `stuck.json` | the stuck thresholds |
| `prompts.json` | saved prompts |
| `prompts-sent/` | multi-line prompts that were typed as a pointer |
| `fix-threads/` | task files from `pr fix` and `pr fix-check` |
| `ping-watches.json`, `memo-actions.json` | phone watches and memo state |
| `brief/latest.json` | the last morning brief |
| `pr-lookup-cache.json`, `cache/` | PR lookup and other caches |
| `moved-aside.jsonl` | the `worktrees move-aside` log |
| `server/hub.sock` | the resident server's socket |
| `widget/` | the widget's state, shelf, voice notes and roster cache |

`config.json` keys: `prLookupCacheSeconds`, `notificationRules`, `digestFolder`, `brief` and `vaultInbox`.

Review proposals live in `~/.genesis-tools/review/proposals/`. The History log first lived in `hub/navigation.db`
(2026-10-25); the hub copies it into `data.db` once and renames the old file aside. A new hub feature that keeps rows
adds its migrations to `src/hub/lib/data-db.ts` instead of opening another SQLite file.

## Configuration

- `tools hub config set --pr-lookup-cache-seconds <n>`: how long `repo --pr` caches the PR lookup, keyed by branch and
  head commit (default 60; 0 turns it off).
- `notify set`, `rules`, `stuck config`, `brief config`, `digest config` and `vault config` each own their keys (see
  above).
- In GenesisTools.app, Settings → Hub sets the History limit and how an agent's place is shown.
- `GENESIS_HUB_SERVER=0` keeps a CLI command from asking the resident server first.
- `GENESIS_HUB_SERVER_MAX_MB` (default 512): the server drains and exits above this memory footprint.

## For agents

- Use `tools hub nav open ... --note "<why>"` to show the person a place, never plain `tools hub open`, so the History
  says why and Back works.
- Write commit links with `tools hub link <sha>`, never by hand.
- `tools hub status` is the gate before review work: exit 0 when the app with the review window is installed, else 1.
- The `genesis-tools:review-proposal` plugin skill reviews a PR and pushes the result with `tools hub proposal push`.
- `pr publish` and `proposal publish` post where everyone sees them. Ask the person first.
- While you change GenesisTools.app, keep `tools hub dev monitor` running under the Monitor tool. It prints one line
  per event: a hang, a layout loop, an error, a link-relay problem, a new crash report, a stall or frame drop of
  500 ms or more (`--min-stall-ms` filters both), a main-thread span of 400 ms or more (`--min-slow-main-ms`), and a
  profiling line (CLI timers and whole command runs from `tools config profiling`) of 1000 ms or more
  (`--min-profile-ms`). It reads the files every 500 ms (`--interval-ms`) and prints at most one batch per 10 s
  (`--min-delay-ms`). `--from-start` replays what the logs already hold, then follows them, and `--json` prints one
  object per event.
- The monitor also reads the failures log of the day: a `deadline` record (a command a tool ran through `Executor`
  that outlived its bound) is an event with the command that shows it (`tools genesis-tools logs show <id>`); no
  other failure kind is. At start it prints one summary of what happened since a monitor last ran (the last 24 h on
  a first run): command deadlines, failed tool runs, hang captures and crash reports, each with the command or
  folder that lists them. `--no-summary` turns it off; with `--json` it is one `{ kind: "summary" }` object. The
  time of the last run is in `~/.genesis-tools/hub/dev-monitor-state.json`.
- Most commands take `--json`. `pr list`, `pr show`, `pr projects` and `repo` always print JSON. Commands that
  cache take `--max-cache-age <seconds>` (default: always fetch fresh); `--fresh` and `--no-cache` stay for old
  callers.

## Troubleshooting

- **`tools hub` takes a minute.** The app was missing, stale, or built without the hub part, so it was built first.
  `--no-build` fails at once instead and prints the build command.
- **A running hub must restart after a rebuild.** Kill it by its pid (`MacOS/GenesisTools --hub`) if the build did not
  reap it, then run `tools hub open --no-activate` with the flags it had. Never use a `pkill -f` pattern: on 2026-09-24
  one also killed other agents' snapshot runs.
- **A link opens the hub in the wrong place.** Only the keys in "Links" count, and a PR's `#` must be `%23`.
- **`memos scan` finds nothing.** The first scan only primes the list. Later, check the Full Disk Access grant with
  `tools macos permissions`.
- **No PR notifications.** Run `tools hub notify status` for the master switch, the last poll and each repo's
  backoff, `tools hub notify poll --dry-run` to see what a poll would post, and `tools hub notify install` when the
  daemon task is missing. A poll that says "no repo is watched" needs
  `tools hub notify set --repo <path> --repo-enabled on`, and "notifications are off" needs
  `tools hub notify set --enabled on`.
- **The app's calls are slow or the server misbehaves.** `tools hub serve --status` shows its health, and
  `tools hub serve --drain` makes the next call start fresh code. After a code change you rarely need `--drain`: the
  server restarts by itself within a minute.

## Related

- [tools browser-router](../browser-router/README.md): the `genesis-hub` preset for `https://` hub links
- [tools github](../github/README.md) and [tools gitlab](../gitlab/README.md): the forges behind `pr`
- [tools cmux](../cmux/README.md): the panes that `board send`, `prompts send` and `pr fix` type into
- [tools daemon](../daemon/README.md): runs the scheduled hub tasks
- [tools notify](../notify/README.md): the channels that hub pushes go through
- [tools macos](../macos/README.md): app builds, permissions and Voice Memos
- [tools question](../question/README.md): the decisions and inbox the hub shows
- [tools claude](../claude/README.md) and [tools codex](../codex/README.md): the sessions the hub lists
- [tools fetch](../fetch/README.md) and [tools youtube](../youtube/README.md): what `vault clip` uses for pages and
  videos
- [tools du](../du/README.md), [tools waze](../waze/README.md), [tools clarity](../clarity/README.md),
  [tools dev-dashboard](../dev-dashboard/README.md)
