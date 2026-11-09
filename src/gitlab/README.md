# tools gitlab

A GitLab CLI for any instance, self-hosted included. It works on one merge request at a time (its threads,
your drafts, a review in either direction, labels), on many MRs at once (a stale-MR cleanup, MRs that touch a
file), on your inbox, and on activity per user or per project. Nothing about the instance is built in: the
host, the token and the project come from flags, the environment, `glab` and the git checkout you stand in.

## Quick start

The tool needs a host and a token once: run `glab auth login --hostname gitlab.example.com`, or export
`GITLAB_HOST` and `GITLAB_TOKEN`. Then, inside a checkout whose `origin` is on that host:

```bash
# The MR: title, author, branches, state, threads, my pending drafts
tools gitlab pr 42

# Since you last looked: reviews on your MRs, MRs you review, threads waiting for you
tools gitlab inbox

# Someone reviewed my MR: every unresolved thread with the code at its anchor
tools gitlab pr 42 review --receive --md

# I review someone else's MR: hunks, threads, my drafts, affected MRs, gates
tools gitlab pr 57 review --give --md

# Reply in a thread as a draft (publish later with `comments publish --apply`)
tools gitlab pr 42 comments reply 3f9c2d1 --body-file reply.md

# What I did on GitLab in the last 7 days, per local day
tools gitlab activity user --days 7
```

## Commands

```text
pr <iid>                      the MR (same as `pr <iid> show`)
pr <iid> review [facts]       facts for a review: --receive or --give
pr <iid> review skeleton      write the judgements file of a review
pr <iid> review check         check a filled judgements file
pr <iid> review render        the report from the judgements file
pr <iid> comments [list]      threads with author, anchor and state
pr <iid> comments drafts      my pending drafts, each anchor verified
pr <iid> comments reply       reply in a thread as a draft
pr <iid> comments add         a new draft, on a line or top-level
pr <iid> comments delete      delete pending drafts of mine
pr <iid> comments resolve     resolve or reopen threads
pr <iid> comments publish     submit my drafts as one review (dry run until --apply)
pr <iid> comments post        post what the judgements file decided (dry run until --apply)
pr <iids> labels              add or remove labels on one MR or a comma list
pr touching <files...>        open MRs whose diff changes these files
pr stale <step>               the stale-MR sweep and two-phase cleanup (16 steps)
inbox [mark]                  what changed since you last looked; `mark` moves the mark only
activity user [events]        one user's events per local day
activity user commits         one user's commits across every project, since a date
activity project              one project's commits per month, with a maintainer leaderboard
```

How the arguments work:

- `<iid>` is `42`, `!42`, or the MR URL (`https://gitlab.example.com/group/web-app/-/merge_requests/42`). The
  URL also sets `--host` and `--project`. `labels` and `comments add` also take a comma list (`12,34`).
- The MR comes first, then the verb. The verb may also come first when it names a group: `pr review 42 --give`
  is `pr 42 review --give`, and `pr comments 42` is `pr 42 comments`.
- A bare group runs its default leaf: `pr 42` runs `show`, `pr 42 review` runs `facts`, `pr 42 comments` runs
  `list`, and `activity user` runs `events`. `pr 42 review --help` prints the group's help. A bare `pr` prints
  its help too.
- Every `pr <iid>` command, `pr touching`, `pr stale preflight`, `inbox` and `activity project` take
  `--host <url>` and `--project <group/name or id>`. See [How it works](#how-it-works) for the order they
  resolve in. `activity user` takes `--host` only (its `--project` is a filter), and the `pr stale` steps after
  `preflight` read both from the sweep JSON.

### One MR: `pr <iid>`

```bash
tools gitlab pr 42          # the MR in six lines, then the next step
tools gitlab pr 42 --json   # the MR object plus me, threads, unresolved and myDrafts
```

The text form shows the title, the URL, the author (marked `(you)` when you wrote it), the branches, the
state (and `draft`), the merge status, conflicts, the head sha, the update time and the labels. Then it gives
the thread count with the unresolved count, and the count of my pending drafts. It ends with the next step:
`pr 42 review`, with `--receive` when you wrote the MR and `--give` when someone else did.

### Review facts: `pr <iid> review --receive | --give`

Two modes. `--receive`: someone reviewed my MR. `--give`: I review someone else's MR. With no mode flag the
tool picks one: when the token's owner wrote the MR it is `--receive`, otherwise `--give`. stderr names the
mode it picked. An option of one mode passed to the other is an error
(`--repo <checkout> belongs to the --give mode.`), never ignored. Both modes are read-only on GitLab (GET
requests only). In git they only fetch: `refs/merge-requests/<iid>/head` when a thread's commit is missing
from the checkout (`--receive --no-anchors` skips that), and every open MR branch with
`--give --impact-source git`. They never change a local branch, HEAD or the working tree.

**Receiving a review** (`--receive`):

```bash
tools gitlab pr 42 review --receive --cwd ~/Projects/app        # discussions JSON (the default)
tools gitlab pr 42 review --receive --cwd ~/Projects/app --md   # the report with code excerpts
tools gitlab pr 42 review --receive --llm                        # one line per thread, with ids
tools gitlab pr 42 review --receive --expand T01,T03             # those threads in full
```

- **Output.** stdout is the discussions JSON by default (`review.fetch.format` in the config changes the
  default). `--md` (or `--format md|both`) renders each unresolved thread with the MR tip, the reviewer's
  frozen view when it differs, and a divergence label: `unchanged`, `changed at the anchor` (the likely "already
  fixed"), `changed nearby`, `changed elsewhere`, `deleted`, `renamed` or `unavailable` (the reviewer's sha is
  gone after a force push, or the files API failed; not proof that the file was deleted). `--format` with no
  value asks.
- **Files.** Every run writes the JSON to `$TMPDIR/gitlab-review-<iid>.json` (or `--out <file>`). A JSON or
  markdown run also writes a JSON Schema of it to `<out>.schema.json` (`--no-schema-file` skips it), and a
  markdown run writes the report to `<out>.md` (`--no-report-file` skips it). The `--llm` and `--expand` views
  write only the JSON. `--schema-format schema|skeleton|typescript|none` prints the inferred schema.
- **Code.** `--cwd <checkout>` gives the code excerpts. `--context-lines <n>` sets the lines around each anchor
  (default `review.fetch.contextLines`, 3). `--no-anchors` skips the API fallback for the reviewer's frozen view;
  views whose sha is in local history still come from git.
- **Terminal.** In a terminal it asks to confirm first (`--no-confirm` skips the prompt), shows status lines,
  and the markdown report goes only to its file. Piped or redirected, status goes to stderr and the result to
  stdout.

**Giving a review** (`--give`):

```bash
tools gitlab pr 57 review --give --repo ~/Projects/app      # facts JSON (the default)
tools gitlab pr 57 review --give --md                        # the numbered report
tools gitlab pr 57 review --give --llm                       # compact view with ids
tools gitlab pr 57 review --give --expand F03,T01            # those ids in full, from the saved facts
tools gitlab pr 57 review --give --proposal-skeleton --agent claude > /tmp/review-57.json
tools gitlab pr 57 review --give --mine-only --threads --md  # critique your own comments
```

- **Diff.** From local git when the checkout has both the base and the head commits (`--context-lines`,
  default 8), else from GitLab's diffs API. Every line carries its old-side and new-side number.
- **Checkout.** `--repo <checkout>` (or `--cwd`). The default is the current checkout when `--project` is not
  given. File links point at the worktree that has the MR's source branch checked out. The report warns when
  there is none or it is behind the MR head. `--worktree <dir>` uses that directory as the MR worktree even
  when its HEAD is on another branch.
- **Impact.** Other open MRs that add an import of a module this MR deletes or renames (relative,
  root-relative, and `@/` or `~/` aliased imports), or that change the same files. `--impact-source api` (the
  default, or `review.impactSource`) reads the diffs of at most 50 other open MRs from GitLab, the most
  recently updated first (`--impact-limit <n>` changes that), and warns when the result is partial.
  `--impact-source git` needs a checkout: it fetches every open MR branch into `refs/remotes/origin/*` and
  diffs locally, with no cap and no diff that GitLab collapsed. `--no-impact` skips the scan.
- **Gates.** The `review.gates` of the config (see [Configuration](#configuration)). With none configured
  there is no gates section. `review.runner: "parallel"` prints one block that starts every gate as a
  background `tools task` session and then prints each exit code. It uses shell arrays, so it needs bash or
  zsh, not a plain POSIX `sh`. When `tools` is not on PATH, that block lists each command instead. A gate
  whose `{tests}` finds no test file is replaced by a note.
- **Your comments.** Every pending draft of yours (`D`) in full: its body, whether it replies to a thread or
  opens one, where it sits in the diff (added, context or removed line) and the code around the anchor. Then
  every thread you started (`Y`) in full. `--mine-only` prints only that, skips the impact scan, and writes
  `...-drafts.json` and `.md`.
- **Threads.** `--threads` adds every unresolved diff thread in full after the checklist, as `--receive`
  renders it: all notes, the MR tip and the reviewer's view. With `--mine-only` it is the re-review view: your
  comments and the conversations they join.
- **Output.** stdout is the facts JSON by default. `--md` (or `--print`) is the numbered report (rendered with
  json2md). `--llm` is a compact view with ids (`F01` files, `T01` threads, `Y01` your threads, `D01` your
  drafts, `M01` affected MRs). `--format summary` prints nothing on stdout, only the summary lines on stderr.
  `--expand F03,T01` prints those ids in full from the saved facts (`--refresh` collects them again). The
  `--llm` view ends with that expand command, `--out` included, so it reads the facts this run saved.
- **Files.** Every collecting run writes `$TMPDIR/gitlab-pr-<project>-<key>-<iid>.json` and `.md`, where
  `<key>` is a hash of the host and the project, so two hosts never share a file. `--out <file>` puts the
  report there and the JSON beside it. Both paths are printed on stderr.
- **Proposal skeleton.** `--proposal-skeleton` prints a review proposal pre-filled from the facts (provider,
  host, project, number, branches, `baseSha`, `headSha`, `repoPath`, every thread with its `resolved` state)
  for the GenesisTools.app review window. An agent adds the verdict and the drafts. `--agent <name>` fills
  `author.agent` (default `$GENESIS_TOOLS_AGENT`, else `agent`). The `gt:review-proposal` skill says how to
  fill the proposal and push it with `tools hub proposal push`.

### Stable ids

Every file, thread, draft and affected MR gets an id that is kept per MR: `F03` files, `T01` threads others
started, `Y02` threads I started, `D04` my drafts, `M01` affected MRs, and `N01` new findings in a judgements
file. A second run gives the same thread the same id. Each id travels with the GitLab id it names (the
`discussion …` or `draft …` in a heading), so a stale id cannot reach the wrong thread. The map lives in
`review-ids/` (see [Files](#files)).

### Judgements: `review skeleton | check | render`, `comments post`

An agent writes its judgement of a review into ONE judgements file per MR, in the report's own labels.
Everything generated (excerpts, links, quoted comments) stays out of it and is added by `render`.

```bash
tools gitlab pr 57 review skeleton --give --file MR57-judgements.md   # every item's heading, empty fields
tools gitlab pr 57 review check --give --file MR57-judgements.md      # exit 1 with the item and line of each error
tools gitlab pr 57 review render --give --file MR57-judgements.md --open      # full layout
tools gitlab pr 57 review render --give --file MR57-judgements.md --digest    # chat view
tools gitlab pr 57 comments post --give --file MR57-judgements.md --do D01,N01   # dry run; add --apply
```

````markdown
# T03 The lock stays off · discussion 0539a97f0000 · src/auth/lock.ts:83
- Verdict: Valid [95%]
- Proposal: Accept
- Rationale:
  - The guard returns early while a browser is open: src/auth/lock.ts:83
- Action: reply
- Proposed draft reply:

```markdown
Fixed in the next push.
```

# N01 Early return skips the cleanup
- Severity: ⚠️ should fix
- Anchor: src/auth/lock.ts:91 (new) `    return;`
- Verdict: Bug [85%]
- Action: comment
- Proposed draft comment:
…
````

- **Modes.** `--receive` judges the threads on my MR. `--give` judges my own comments on someone else's MR and
  adds new findings. With neither flag the mode is picked by author, as for `facts`.
- **The file.** The default is one file per MR in the temp folder:
  `$TMPDIR/gitlab-review-<key>-<iid>-judgements.md`. `skeleton` refuses to overwrite it without `--force`.
- **JSON.** The same file can be JSON (`--file x.json`, or `review skeleton --format json`). Without `--file`,
  `skeleton --format json` writes `$TMPDIR/gitlab-review-<key>-<iid>-judgements.json`. The default of `check`,
  `render` and `comments post` is the `.md` file, so pass them `--file` with that `.json` path. `--print`
  writes the skeleton to stdout instead of the file. Every command reads either form, and broken JSON is
  repaired and reported. Both forms go through `md2json` or the JSON reader, which accept hand edits whose
  meaning stays clear (bold keys, `*` bullets, any heading level, `t3` for `T03`, a reply left outside its
  fence) and report each repair.
- **Items.** `T` threads others started (receive), `D` my pending drafts and `Y` threads I started (give), and
  `N01…` new findings. The heading's `discussion …` or `draft …` is checked against the MR, so an id from an
  older run cannot reach another thread.
- **Actions.** `T`: reply, reply-resolve, none. `Y`: reply, none. `D`: keep, reword, move, delete. `N`:
  comment, none.
- **Anchors** carry the text of the line. `check` refuses a line outside the diff, or a line whose text
  differs, and names the line where that text really is.
- **`check`** also wants a `[NN%]` badge on every verdict, the text each action sends, and the configured
  `review.draftRules`.
- **`render`** writes the full layout beside the judgements file as `-report.md` (`--out` moves it; a path
  equal to the judgements file is refused), or prints `--digest` (one card per item), `--item T03,D01`, or
  `--proposal` (the proposal JSON for `tools hub proposal push -`). It runs `check` first: warnings go to
  stderr, and any error exits 1 with nothing rendered. Quoted comments are never shortened. Text meant to be
  posted is a fenced block indented by three spaces (display only). `--open` opens the layout on macOS, in
  Genesis Markdown when it is installed, else in the default app. `--repo` names the checkout for file links
  and code views. Without it, render uses the worktree that has the MR's source branch checked out, else the
  current directory with a warning. `--context-lines <n>` sets the lines around each anchor (default
  `review.fetch.contextLines`), and the layouts never show fewer than 10.
- **Signature.** An answer in my own thread is signed `[NN%] <agent>:` from its badge, and `--proposal` puts
  the same name into `author.agent`. `--agent` sets it (default `$GENESIS_TOOLS_AGENT`, else `Opus`). A
  review merged from two models names both, for example `--agent "Opus and Fable"`.
- **`comments post`** runs the items' actions as drafts (`--do T01,D03,N01`), or posts answers into my own
  threads (`--answers D05`, for a D draft that `publish` turned into a thread). A dry run lists each step.
  `--apply` posts them, stops at the first failure, reads every result back and records it in the ledger, so a
  rerun skips what already landed.

### Threads and drafts: `pr <iid> comments`

```bash
tools gitlab pr 42 comments --unresolved            # same as `comments list`; --mine, --author <u>, --json
tools gitlab pr 42 comments drafts                  # my pending drafts with where each one landed; --json
tools gitlab pr 42 comments reply 3f9c2d1 --body-file reply.md
tools gitlab pr 42 comments reply 3f9c2d1 --body-file reply.md --now --resolve
tools gitlab pr 42 comments add --file src/api/client.ts --line 34 --body-file note.md
tools gitlab pr 42 comments add --top-level --body-file note.md
tools gitlab pr 42 comments delete 501              # draft ids from `comments drafts`
tools gitlab pr 42 comments resolve 3f9c2d1         # --unresolve reopens
tools gitlab pr 42 comments publish --expect D01,D02 --apply
```

- **`reply <thread>`** takes the full discussion id or a unique prefix. GitLab allows one pending draft per
  thread per author, so a second reply updates my draft on that thread instead of failing. `--append` adds to
  the draft instead of replacing it. `--now` publishes at once, and `--resolve` resolves the thread after the
  reply.
- `--append` and `--resolve` exist only on `reply`. On one MR, `comments add --now` is refused before any
  request is made, because a top-level `--now` once left a private draft and exited 0.
- **`add`** writes a draft anchored to `--file` and `--line` (a line of the new file), or a `--top-level`
  draft. The anchor is checked before anything is sent.
- **Bodies.** Prefer `--body-file` over `--body` for anything with newlines or backticks. `![alt](local.png)`
  images in the file are uploaded to the project first. The thread or line is checked before the upload,
  because an upload cannot be taken back.
- **`publish`** submits every pending draft of mine as one review. It is a dry run until `--apply`.
  `--expect <ids>` (D ids or draft ids) refuses when the pending set differs, and refuses an id that this MR's
  id map does not know.

### Many MRs: comma lists, `labels`, `touching`

```bash
# Batch writes: always try --dry-run first
tools gitlab pr 12,34,56 comments add --top-level --body "Please rebase onto main." --dry-run
tools gitlab pr 12,34,56 comments add --top-level --body "Please rebase onto main." --now
tools gitlab pr 12,34 labels --add Stale --remove "Needs review" --dry-run

# Open MRs that touch a file (exact path or path suffix)
tools gitlab pr touching bun.lock package.json
```

- **`comments add` with a comma list** takes only `--top-level` and posts at once, with no drafts: add `--now`,
  or `--dry-run` to see the plan. On one MR, `--now` and `--dry-run` are refused (one MR gets a draft). Every
  posted comment goes into `comment-batch.jsonl`, and a (project, MR, text) already there is skipped. Failed
  MRs are printed as a comma list to retry, and the exit code is 1.
- **`labels`** takes `--add` and `--remove` (repeatable or comma-separated), on one MR or a comma list. It
  refuses labels the project does not have unless `--create-missing`. `--dry-run` fetches the current labels
  and prints the planned result. `--out <file>` writes the per-MR before and after record as JSON. Every
  applied change goes into `label-batch.jsonl`. When any MR failed, it prints
  `Failed iids (retry these): …` and the exit code is 1.
- **`touching`** asks GitLab GraphQL. Progress goes to stderr, the result to stdout; `--json` for JSON.

### Inbox: `inbox`

```bash
tools gitlab inbox                 # everything since the last check, then the mark moves
tools gitlab inbox --peek          # the same list, the mark stays
tools gitlab inbox --since 2026-10-22T08:00 --role reviewer
tools gitlab inbox --peek --all-projects --json
tools gitlab inbox mark            # catch up without reading (--at <time> sets the mark)
```

- **What it lists.** Your MRs and the MRs you review (as a reviewer, or because you commented in the last
  `--lookback-days`, default 30), each with new comments by others, pushed commits, approvals and withdrawn
  approvals, a merge or a close, and, on your MRs only, a failed pipeline. Threads whose last word is someone
  else's. Pending to-dos. `--role author|reviewer|all` (default `all`) narrows it.
- **Scope.** One project by default (`--project`, `GITLAB_PROJECT`, the configured default, the origin
  remote). `--all-projects` reads every project. Each scope keeps its own mark, so a one-project check never
  moves the all-projects mark.
- **The mark** lives in `inbox.json` next to the config: per host, user and scope, the time of the last check
  and the highest note id seen on each MR. A note counts as new when its id is above the MR's mark, so a skewed
  clock cannot hide a comment. An MR seen for the first time uses the time. The first check covers the last
  24 hours. `--peek` and `--since <time>` leave the mark where it is.
- **Waiting for you.** An unresolved thread whose last note is someone else's: on your own MR any thread, on
  another MR one you wrote in. The link points at that last note.
- **Never a partial mark.** When any request fails, the list says so on stderr, the command exits 1, and the
  mark stays. Role-filtered checks also leave the shared mark unchanged. Pending to-dos and open waiting
  threads stay visible across checks.
- The next step for one MR is `pr <iid> comments`.

### Activity: `activity user`, `activity project`

```bash
# One user's events per local day (comments, pushes, approvals, merges); the default user is the token's owner
tools gitlab activity user --days 7
tools gitlab activity user --from 2026-09-01 --to 2026-09-30 --format md --detail --output september.md
tools gitlab activity user --user alice --action pushed --tz Europe/London

# Who did what since a date, across every project they pushed to
tools gitlab activity user commits --user alice --since 2026-09-01 --out alice.md

# One project, grouped by month, with a maintainer leaderboard
tools gitlab activity project --project group/web-app --since 2026-01-01
```

- **`activity user`** (the `events` leaf) counts per action, commit totals and links per local day.
  `--from` and `--to` are inclusive local days (`--to` defaults to today). Without `--from`, `--days <N>`
  (default 7) ends at `--to`. `--tz <zone>` sets the time zone (default: the system zone). `--format
  text|md|json` (default `text`), `--detail` adds a per-event timeline, and `--output <path>` writes a file.
  `--action` and `--target-type` filter on the server. `--project` only filters: events of every project are
  read. `--max-pages <N>` (default 50 pages of 100 events) stops early and reports the truncation.
- **Local days.** GitLab's `after` and `before` filters are exclusive and date-only, and events carry UTC
  times, so an event at 23:30 in Central Europe lands on the next UTC day. The query window is widened by two
  days on each side, and the range is applied after converting each event to its local day. stderr always
  states how many events were fetched and how many fell in the range, so an empty day can be told apart from a
  failed or truncated fetch.
- **`activity user commits`** needs `--user` and `--since`. It writes a day-by-day Markdown report (or `--json`)
  to stdout or `--output`/`--out`. It walks `/users/<id>/events` (which paginates reliably) to find every push,
  then compares each push to list its commits. That avoids the GitLab bug where
  `/projects/<id>/repository/commits?all=true` returns the same page for every `?page=N`. `--concurrency`
  (default 8) sets the parallel fetches.
- **`activity project`** needs `--since` (inclusive); `--until` is exclusive (default: now). It walks every
  branch with `ref_name`, `since` and `with_stats`, then deduplicates by SHA, which avoids the same `?all=true`
  bug. `--concurrency` (default 8) sets the parallel diff fetches, `--branch-concurrency` (default 6) the
  parallel branch walks. Markdown by default, `--json` for raw JSON, `--output`/`--out` for a file.

### Stale-MR cleanup: `pr stale`

A read-only sweep, an agent review, then a cleanup that writes to one MR at a time after approval.

```bash
tools gitlab pr stale preflight --out sweep.json --cwd ~/Projects/app   # facts + empty review fields
tools gitlab pr stale merge sweep.json --review slice-1.json             # copy filled reviews in
tools gitlab pr stale render sweep.json --out note.md                    # Markdown note
tools gitlab pr stale recheck sweep.json                                 # content check again, what moved
tools gitlab pr stale post sweep.json --iid 42 --draft                   # one MR, private draft note
tools gitlab pr stale publish sweep.json --iid 42
tools gitlab pr stale apply-labels sweep.json --dry-run
tools gitlab pr stale followup sweep.json --after-days 7                 # phase 2: who reacted
tools gitlab pr stale close sweep.json --iid 42 --delete-branch
tools gitlab pr stale manifest sweep.json                                # every MR we wrote to, live status
tools gitlab pr stale closed-bug sweep.json --dry-run                    # closed bug, open MR
```

The sweep JSON records the host, the project and the checkout (`repoRoot`), so later steps need no `--host`
or `--project`. `recheck`, `shipped-detail` and `closed-bug` use that checkout unless `--cwd <dir>` names
another one. The steps:

- **`preflight`** collects every open MR with its git distance, notes, author activity and work item into a
  JSON with empty review fields. `--out` is required. `--review-min-age <days>` (default 90) sets
  `needsReview=true` on older MRs, and `--inactive-after <days>` (default 30) marks an author without a GitLab
  event for that long as inactive. It runs `git fetch origin --prune --quiet` in the checkout (`--cwd`, default
  the git root of the current directory).
- **`merge <json>`** copies review fields in by iid from slice files (`{iid: review}`) or a previous sweep.
  `--review` is required and repeatable; `--out` defaults to overwriting the JSON in place.
- **`mark-review <json> --iid <n>`** flags MRs for review regardless of age, for example young MRs whose
  change already reached the release target.
- **`render <json>`** renders the filled JSON as a Markdown note (`--out`, default stdout). `--ado <id>` adds
  work-item ids to the front matter, `--title` sets the title. It refuses MRs with empty review fields unless
  `--allow-unfilled`, and refuses to overwrite an existing `--out` unless `--force`, so a reviewed note is
  never lost by accident.
- **`recheck <json>`** runs the content check again and compares every filled MR and its work item with the
  sweep snapshot. It refreshes `shipped`, `labelConflicts` and `closedBug` in the JSON and is read-only on
  GitLab. It also runs `git fetch origin --prune --quiet`. Filters: `--iid`, and `--recommendation` with one
  of `CLOSE`, `ASK AUTHOR`, `REBASE-NEEDED` or `KEEP`.
- **`shipped-detail <json> --iid <n>`** is the exhaustive content check of ONE MR: every significant added line
  of every file against the environment refs. It prints the lines that are NOT on the release target (UAT,
  else production; `--show`, default 40) and writes the result into the JSON as `shipped`.
- **`post <json> --iid <n>`** posts the drafted comment of ONE reviewed MR and records the note URL. It refuses
  when the MR or its work item changed since the sweep (`--force` posts anyway). `--draft` creates a GitLab
  draft note instead (visible only to its author until published), and with `--draft`, `--author <username>`
  drafts every reviewed, not yet posted MR of that author. `--dry-run` prints the draft.
- **`publish <json> --iid <n>`** publishes the GitLab draft notes of ONE MR (the review draft from
  `post --draft` and any side-comment drafts) and records the note URLs.
- **`apply-labels <json>`** applies the `review.labels` field that each pending reviewed MR has in the sweep
  JSON (or one `--iid`), logging the labels before and after. It is not a key of the config file.
  `--dry-run` prints the planned table.
- **`side-comment <json>`** writes one templated side note per selected MR (`--key` and `--template` are
  required; `{author}` becomes `@username`, `{iid}` and `{title}` the MR). Select with `--iid` (repeatable) or
  `--missing-work-item` (MRs whose title and description hold no id matching `workItems.idPattern`), and
  exclude with `--skip-author`. When the sweep comment already exists on the MR, the text is appended to it in
  place; otherwise a new note is created (a draft note with `--draft`). It is keyed, so a rerun never posts
  twice. `--dry-run` prints the plan.
- **`closed-bug <json>`**: every open MR whose work item (Bug by default, `--type` to change; the parent when
  the MR names a Task) is still Closed on a live read gets the exhaustive content check and one comment saying
  where the fix is (released, part, test only, nowhere, unknown). The comment is appended to our sweep comment
  when it exists, else a new note (a draft note with `--draft`). Keyed `closedBug`, so a rerun never posts
  twice. `--select new|posted|all` (default `all`), `--skip-author`, `--show` prints every text, and
  `--dry-run` runs the checks and writes the facts into the JSON but sends nothing.
- **`sync-note <json>`** brings published sweep comments up to date with the review text in the JSON: the note
  body becomes the current `draftComment` plus whatever was appended after the original post (side texts
  stay). It uses the comment ledger to know the original text. `--iid`, `--dry-run` (shows the changed lines).
- **`reconcile <json>`** restores `postedNoteUrl`, labels, `closedAt` and `draftNoteId` of every reviewed MR
  from the ledgers and live GitLab, for a JSON whose operational fields were lost. Read-only on GitLab.
- **`manifest <json>`** rebuilds the sweep manifest: every MR we wrote to, fetched live, with what we sent,
  whether our stale label is still on, what the author did since, and a status per MR. It writes
  `<json>` with a `-manifest` suffix (or `--out`), and compares itself with the previous manifest. Read-only
  on GitLab. Filters: `--iid`, `--status` (repeatable), `--ignore-author`; `--dry-run` prints the table only.
- **`followup <json>`** is the phase 2 list: every notified MR (posted comment or applied label), what moved
  since, and which are close candidates after `--after-days` (default 7) of silence. Read-only on GitLab.
- **`close <json> --iid <n>`** closes ONE notified MR and records `closedAt`. It refuses an MR with activity,
  or one notified less than `--after-days` (default 7) ago, unless `--force`. `--delete-branch` deletes the
  source branch on origin afterwards; that is refused when the branch is protected or another open MR still
  uses it. `--dry-run` shows the activity check.

Rules of the cleanup: `post`, `publish` and `close` run only after an explicit approval of that one MR, and
`apply-labels` only after its dry-run table was approved. In `followup`, `close` and `manifest`, notes by the
token's owner never count as a reaction, and `--ignore-author <username>` (repeatable) adds more such users.

**Content check, not history.** `shipped` samples the lines an MR branch adds (up to 10 files, 8 significant
lines per file) and looks for them in the environment branches, because squash merges, rebases and rewritten
integration branches make ancestry (`git merge-base --is-ancestor`, `git cherry`) say "never merged" for code
that shipped. A ref counts as `present` when more than 80% of the sampled lines are in it; below that the
change is only partly there. Lock files, snapshots and data JSON never count; `package.json` does, because a
version bump is the change in an upgrade MR. `shipped-detail` checks every line instead of a sample.

## How it works

**Host, token and project** resolve in this order:

- Host: `--host <url>`, then `GITLAB_HOST`, then a fork's default host (see below), then `glab config get host`.
  Without any, the error lists the three ways to set one.
- Token: `GITLAB_TOKEN`, then `glab config get token --host <hostname>`, then
  `glab auth token --hostname <hostname>`. Without any, the error links the token page of that host with the
  `api` scope filled in and lists every source it tried. The token is resolved once per host per process.
- Project: `--project <group/name or id>`, then `GITLAB_PROJECT`, then the `origin` remote of the current
  checkout when its host matches. A fork's default project comes before the origin remote when the command
  names no checkout, and after it when it does.

The host is normalised to `https://host`. A host without a scheme gets `https://`, and a relative root such
as `https://gitlab.example.com/gitlab` is kept, so self-hosted installs work. An explicit `http://` is kept
too, but the tool refuses to send the token over it to anything but loopback (`localhost`, `127.0.0.1`,
`::1`).

**Requests.** REST v4 for everything except `pr touching`, which uses GraphQL. A GET is retried up to three
attempts, with an exponential backoff from 250 ms, on 408, 429, 5xx and connection failures, and times out
after 30 s. A PUT or DELETE (a note edit, a resolve, a draft delete, a label change) takes the same retries
and times out after 15 s. A POST also times out after 15 s, and it is sent once: GitLab can commit a POST and
still answer 502, or commit it after the client timeout, and a retry then created a second note or draft. The
GraphQL request of `pr touching` times out after 60 s and is not retried.

**Pagination that does not lie.** The tool follows `X-Next-Page`. GitLab filters some endpoints by visibility
after it builds a page (`/users/:id/events` does), so a page can hold 99 of 100 items while more pages exist.
Without the header, a short page is the last one, and a page that repeats the previous one means `page` is
ignored, so the walk ends there. `merge_requests/:iid/draft_notes` is such an endpoint.

**Git.** `pr review` reads the checkout with `git diff`, `cat-file` and `worktree list`. It fetches only
`refs/merge-requests/<iid>/head` when a thread's commit is missing, and every open MR branch with
`--impact-source git`. `pr stale preflight` and `pr stale recheck` run `git fetch origin --prune --quiet` in
the checkout. No command changes a local branch, HEAD or the working tree.

**Work items.** When `workItems.idPattern` is set, `pr stale` reads Azure DevOps work items through
`tools azure-devops workitem <id> -f json`, run in the checkout so that tool finds its own organisation
config there. It bypasses that tool's cache, because cleanup decisions need the live state. Off by default.

**Other tools.** `tools hub pr` and the GenesisTools.app review window read and write GitLab MRs through this
tool's library. `tools hub proposal push` takes the proposals that `--proposal-skeleton` and
`render --proposal` print. Nothing here costs money, and the tool needs no macOS permissions.

### Files

Everything durable lives in `~/.genesis-tools/gitlab/`:

- `config.json`: the configuration below.
- `inbox.json`: the inbox marks.
- `comment-batch.jsonl`: every comment the batch and stale paths posted, the dedup ledger.
- `label-batch.jsonl`: every label change, with before and after.
- `review-ledger/<key>-<iid>.json`: what `comments post` landed.
- `review-ids/<key>-<iid>.json`: the id map of each MR.

Each `<key>` is a short hash of the host and the project, so two hosts never share a file. Working files go
to `$TMPDIR`: the receive JSON
(`gitlab-review-<iid>.json`), the give facts (`gitlab-pr-<project>-<key>-<iid>.json` and `.md`), and the
default judgements file (`gitlab-review-<key>-<iid>-judgements.md`, or `-judgements.json` from
`review skeleton --format json` without `--file`).

## Configuration

`~/.genesis-tools/gitlab/config.json`, every key optional. A missing file means the defaults, and the
defaults are neutral: English texts, ISO dates, no work-item lookups, production is the project's default
branch.

```json
{
    "language": "en",
    "dateStyle": "iso",
    "messages": { "closedBug.askUnknown": "- Is the fix in production?" },
    "workItems": {
        "idPattern": "(?<!\\d)(\\d{6})(?!\\d)",
        "urlTemplate": "https://dev.azure.com/example/web/_workitems/edit/{id}",
        "environmentField": "Custom.Environment",
        "mergeRequestField": "Custom.MergeRequest"
    },
    "stale": {
        "label": "Stale",
        "mergeLabelPattern": "^(NOT\\s+)?merged into (\\S+)$",
        "environments": { "uat": "staging", "production": null, "releasePrefix": "release/", "test": "develop" },
        "draftCommentGuide": null,
        "instructionsExtra": null,
        "noteTags": [],
        "contentCheckNote": null
    },
    "review": {
        "gates": [
            { "label": "types", "command": "bunx tsgo --noEmit" },
            { "label": "unit tests", "command": "bun test {tests}", "exclude": "mobile/**" }
        ],
        "runner": "list",
        "fetch": { "format": "json", "contextLines": 3 },
        "nextSteps": []
    }
}
```

Top level:

- `language` (default `en`): texts written onto MRs, `en` or `cs`.
- `dateStyle` (default `iso`): `iso` (2026-09-08) or `dmy` (8.9.2026) in reports and comments.
- `messages` (default `{}`): overrides any comment template by key, with `{name}` placeholders. An unknown key
  is an error that lists the known keys.

`workItems`:

- `idPattern` (default `null`): a regular expression whose first group is an Azure DevOps work-item id in an
  MR title, branch or description. It turns on lookups through `tools azure-devops workitem`.
- `urlTemplate` (default `null`): the link, with `{id}`, for items that cannot be read.
- `environmentField`, `mergeRequestField` (default `null`): reference names of custom fields read from the
  work item (the environment it was tested on, an MR URL typed into it).

`stale`:

- `label` (default `Stale`): the label the cleanup adds and follows.
- `mergeLabelPattern` (default above): labels that claim a merge state, checked against the content,
  case-insensitive.
- `environments.uat`, `environments.test` (default `null`): branches of those environments.
- `environments.production` (default `null`): the production branch; `null` means the default branch.
- `environments.releasePrefix` (default `null`): dated release branches (`release/2026-09-10`). The newest one
  whose date is not in the future is production, and wins over `production`.
- `draftCommentGuide` (default `null`): replaces the draft-comment guidance in the preflight instructions.
- `instructionsExtra` (default `null`): appended to the preflight instructions (house style, where evidence
  lives).
- `noteTags` (default `[]`): extra front-matter tags of the rendered note.
- `contentCheckNote` (default `null`): appended to the note's explanation of the content check.

`review`:

- `gates` (default `[]`): checks that `review --give` lists for the reviewer to run. Each has `label` and
  `command`; `{files}` becomes the matching changed files, and `{tests}` the changed test files plus the test
  next to each changed source file. Optional `when` is a glob over changed paths: the gate is listed only when
  a changed file matches. Optional `exclude` is a glob removed from `{files}` and `{tests}`.
- `runner` (default `list`): `list` prints the gate commands one after another. `parallel` starts each gate
  as a background `tools task` session, then prints every exit code.
- `fetch.format` (default `json`): what `review --receive` prints when neither `--format` nor `--md` is given,
  `json`, `md` or `both`.
- `fetch.contextLines` (default `3`): `review --receive --context-lines` when the flag is not given.
- `nextSteps` (default `[]`): extra bullets under "Next steps" in the `--receive` report; `{iid}` becomes the
  MR iid.
- `impactSource` (default `api`): the default of `--impact-source`, `api` or `git`.
- `worktreeHint` (default `null`): replaces the "create a worktree" advice when no worktree has the MR branch;
  `{branch}` and `{iid}` are filled in.
- `draftRules` (default: none): what `review check` enforces in text that goes to the MR. `bannedWords`
  (`[{ "word", "instead" }]`), `forbidDashes`, and `ownThreadForbidden` (empty by default: phrases that address
  nobody in a thread you started; a hit only warns, it never blocks).

The file is read once per process and checked strictly: a wrong type, an invalid regular expression, or a
section that is not an object (`"stale": false`) is an error, never silently ignored.

**Environment variables:** `GITLAB_HOST`, `GITLAB_TOKEN`, `GITLAB_PROJECT` (see
[How it works](#how-it-works)), and `GENESIS_TOOLS_AGENT`, the agent name that signs reviews.

### Company-specific defaults for a fork

`lib/defaults.ts` holds the defaults this copy runs with. Upstream it is `NEUTRAL_DEFAULTS` from
`lib/neutral-defaults.ts`, so every field below is empty. A fork that always talks to one instance replaces
that one file:

- `host`: used after `GITLAB_HOST`, before glab's default host.
- `project`: used after `GITLAB_PROJECT`; before the origin remote when the command names no checkout, after
  it when it does.
- `storageName` (upstream `gitlab`): the folder under `~/.genesis-tools` for `config.json` and the ledgers.
- `token.name` (upstream `genesis-tools`), `token.newTokenUrl`: the token creation link in the setup help.
- `token.extraCommands`, `token.extraStoreHints`: more token sources after glab's, and more "store it" lines.
- `legacyLedgerProject`: the project of ledger lines written before they carried one.
- `config`: laid over the built-in config defaults; the user's `config.json` still wins.

Tests assert against `NEUTRAL_DEFAULTS` and `NEUTRAL_CONFIG`, never the seam.

## For agents

- **JSON.** `pr <iid> --json`, `comments list --json`, `comments drafts --json`, `touching --json`,
  `inbox --json`, `activity user --format json`, `activity user commits --json`, `activity project --json`.
  `review` prints JSON by default in both modes. The result goes to stdout, progress and summaries to stderr.
- **Exit codes.** 0 on success. 1 on any error, with `Error: <message>` on stderr. `review check` exits 1 with
  the item and the line of every error, and `review render` exits 1 when that check fails. `inbox` exits 1
  when any request failed (the mark stays). A batch `comments add` and `labels` exit 1 when any MR failed, and
  print the failed iids to retry.
- **Safe by default.** `comments publish` and `comments post` are dry runs until `--apply`. Batch writes and
  `labels` take `--dry-run`. The `pr stale` writes go one MR at a time after an approval.
- **`--llm`** is a compact view for a person who asks for it; its help says to use it only then.
- **Signing.** Set `GENESIS_TOOLS_AGENT` so reviews and proposals carry the right agent name.
- **The plugin skill** [`gt:review-proposal`](../../plugins/genesis-tools/skills/review-proposal/SKILL.md) says
  how to fill a review proposal from these facts and push it to the GenesisTools.app review window.

**Scripting.** `@app/gitlab/lib/mr` wraps one MR for scripts. `mr(iid, { host, project, cwd })` returns an
object with `discussions()`, `drafts()`, `diffRefs()`, `reply()`, `replyNow()`, `resolve()`, `draftOnLine()`,
`draftNote()`, `note()`, `deleteDraft()`, `publishDrafts()`, `unanchoredDrafts()` and `replyMany()`.

```ts
import { mr } from "@app/gitlab/lib/mr";

const review = mr(42, { project: "group/web-app" });
for (const thread of await review.discussions({ unresolved: true })) {
    await review.reply(thread.id, "Fixed in the latest push.");
}
await review.publishDrafts();
```

## Troubleshooting

- **`No GitLab host configured.`** Pass `--host`, export `GITLAB_HOST`, or run
  `glab auth login --hostname <host>` once.
- **`No GitLab token found for <host>.`** Open the link in the message (the `api` scope is filled in), then
  run `glab auth login --hostname <host>` or export `GITLAB_TOKEN`. The "Looked in" list shows what each source
  answered. Some glab versions print their help and exit 0 for `glab auth token`; the tool checks that the
  output looks like a token (one word of 20 or more characters), so that help is never used as one.
- **`Refusing to send a GitLab token over http: …`** Use an `https://` host. Only loopback hosts may use
  plain HTTP.
- **`No GitLab project. The origin remote points at …`** The checkout's `origin` is on another host. Pass
  `--project`, export `GITLAB_PROJECT`, or run inside a checkout of that host.
- **`--repo <checkout> belongs to the --give mode.`** An option of the other review mode. Drop it, or pass the
  mode flag you meant.
- **`A comma list of MRs posts at once (no drafts)`**, or **``--now and --dry-run on `comments add` are for a
  comma list of MRs.``** Batch comments need `--now` or `--dry-run`, and top-level or anchored notes on one MR
  are drafts: publish them with `comments publish --apply`.
- **A write answered 502 or timed out.** It may still have landed, and the tool does not resend a POST. Check
  `comments drafts` or the MR before you run it again.
- **`gitlab config: …`** The config file has a wrong type, an unknown message key, an invalid regular
  expression, or a section that is not an object. The message names the field.
- **An activity day looks empty.** Read the stderr line: it states how many events were fetched and how many
  fell in the range, and a `--max-pages` truncation is reported there.
- **`pr stale render` refuses to write.** The `--out` file exists; pass `--force` to overwrite it.

## Related

- [`tools github`](../github/README.md): the GitHub counterpart.
- [`tools azure-devops`](../azure-devops/README.md): the work items that `pr stale` reads when
  `workItems.idPattern` is set.
- [`tools hub`](../hub/README.md): `hub proposal push` and the review window, and `hub pr`, which uses this
  tool's library.
- [`tools task`](../task/README.md): runs the gates as background sessions with `review.runner: "parallel"`.
- [`tools json2md`](../json2md/README.md): renders the markdown reports.
