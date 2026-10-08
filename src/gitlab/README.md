# GitLab

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **GitLab CLI for any instance. One MR: `gitlab pr <iid> review|comments|labels`. Many MRs: `gitlab pr stale|touching`. People and projects: `gitlab activity user …`, `gitlab activity project …`.**

Talks to the GitLab REST and GraphQL APIs directly. Nothing about the instance is built in: the host, the token and the project are resolved from flags, the environment, `glab` and the git checkout you stand in.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Any instance** | `--host`, `GITLAB_HOST`, or glab's default host; self-hosted and relative-root installs work |
| **Zero-config auth** | Reuses the token glab stores for that host; `GITLAB_TOKEN` overrides |
| **Project from origin** | Project-scoped commands read the `origin` remote when it points at the resolved host |
| **Per-day activity** | `activity user` groups one user's events per local day, with links; the window is widened so late-evening events land on the right day |
| **Activity reports** | `activity user commits` and `activity project` avoid the GitLab `?all=true` pagination bug |
| **Pagination that does not lie** | Follows `X-Next-Page`; GitLab can return a short page while more pages exist, and some endpoints ignore `page` entirely |
| **One MR first** | `gitlab pr <iid> <verb>`: the MR comes first, then what to do with it. `<iid>` is `42`, `!42`, a comma list, or the MR URL (which also gives the host and project) |
| **Receiving a review** | `pr <iid> review --receive` returns the MR's discussions as JSON; `--md` renders unresolved threads with the local code and the reviewer's frozen view |
| **Giving a review** | `pr <iid> review --give` gathers what a reviewer of someone else's MR needs: numbered hunks, file checklist, existing threads, your drafts, open MRs this one breaks or overlaps, configured gates; JSON, markdown, a compact `--llm` view, or a review-proposal skeleton for the GenesisTools.app review window. No mode flag: your own MR is `--receive`, anyone else's `--give` |
| **Comments** | `pr <iid> comments reply` folds into the one pending draft GitLab allows per thread instead of failing; `publish` is a dry run until `--apply` and can check the pending set with `--expect` |
| **Judgements** | An agent judges a review in one markdown file per MR: `review skeleton` writes every item's heading, `review check` proves it complete (text-checked anchors, badges, house rules), `review render` gives the full report or a chat digest, `comments post` turns the decisions into drafts with a ledger and a read back |
| **Stable ids** | Every file, thread, draft and affected MR gets an id kept per MR (`F03`, `T01` threads by others, `Y02` threads I started, `D04` my drafts, `M01`), and each id travels with the GitLab id it names, so a stale id cannot reach the wrong thread |
| **Batch writes** | `pr <iids> comments add --top-level --now` and `pr <iids> labels` keep a ledger, dedupe, and log before/after |
| **Stale-MR cleanup** | `pr stale` collects facts, lets an agent review, renders a note, then posts, labels and closes one MR at a time |

---

## Quick Start

```bash
# What you did on GitLab last week, per local day (comments, pushes, approvals, merges)
tools gitlab activity user --days 7
tools gitlab activity user --from 2026-09-01 --to 2026-09-30 --format md --detail --output september.md

# Who did what since a date, across every project they pushed to
tools gitlab activity user commits --user alice --since 2026-09-01 --out alice.md

# One project, grouped by month, with a maintainer leaderboard
tools gitlab activity project --project acme/web-app --since 2026-01-01

# Open MRs that touch a file (exact path or path suffix)
tools gitlab pr touching bun.lock package.json

# One MR: title, author, branches, state, threads, my drafts
tools gitlab pr 42

# Receiving a review on my MR !42: JSON, or the report with code excerpts
tools gitlab pr 42 review --receive --cwd ~/code/web-app
tools gitlab pr 42 review --receive --cwd ~/code/web-app --md

# Giving a review on someone else's MR !57: facts JSON, report, compact view, drill-down, proposal skeleton
tools gitlab pr 57 review --give --repo ~/code/web-app
tools gitlab pr 57 review --give --md
tools gitlab pr 57 review --give --llm
tools gitlab pr 57 review --give --expand F03,T01
tools gitlab pr 57 review --give --proposal-skeleton --agent claude > /tmp/review-57.json
tools gitlab pr 57 review --give --mine-only --threads --md   # critique your own comments

# Judging a review: one file per MR, checked, rendered, then posted as drafts
tools gitlab pr 57 review skeleton --give --file MR57-judgements.md
tools gitlab pr 57 review check --give --file MR57-judgements.md
tools gitlab pr 57 review render --give --file MR57-judgements.md --open      # full layout
tools gitlab pr 57 review render --give --file MR57-judgements.md --digest    # chat view
tools gitlab pr 57 comments post --give --file MR57-judgements.md --do D01,N01   # dry run; add --apply

# Threads, draft replies, new comments, publish
tools gitlab pr 42 comments --unresolved
tools gitlab pr 42 comments reply 3f9c2d1 --body-file reply.md
tools gitlab pr 42 comments add --file src/api/client.ts --line 34 --body-file note.md
tools gitlab pr 42 comments drafts
tools gitlab pr 42 comments publish --expect D01,D02 --apply

# Batch writes (always try --dry-run first)
tools gitlab pr 12,34,56 comments add --top-level --body "Please rebase onto main." --dry-run
tools gitlab pr 12,34 labels --add Stale --remove "Needs review" --dry-run
```

---

## Host, token and project

| What | Order |
|------|-------|
| Host | `--host <url>` → `GITLAB_HOST` → `glab config get host` → error with setup help |
| Token | `GITLAB_TOKEN` → `glab config get token --host <hostname>` → `glab auth token --hostname <hostname>` → error that links the token page of that host with the `api` scope filled in |
| Project | `--project <group/name or id>` → `GITLAB_PROJECT` → the `origin` remote of the current checkout, when its host matches → error |

The host is normalised to `https://host` (an explicit `http://` and a relative root such as `/gitlab` are kept). The token is resolved once per host per process.

### Company-specific defaults for a fork

`lib/defaults.ts` holds the defaults this copy runs with; upstream it is `NEUTRAL_DEFAULTS` from `lib/neutral-defaults.ts`, so every step below is skipped. A fork that always talks to one instance replaces that one file:

| Field | Effect |
|-------|--------|
| `host` | Used after `GITLAB_HOST`, before glab's default host |
| `project` | Used after `GITLAB_PROJECT`: before the origin remote when the command names no checkout, after it when it does |
| `storageName` | Folder under `~/.genesis-tools` for `config.json` and the ledgers |
| `token.name`, `token.newTokenUrl` | Token creation link in the setup help |
| `token.extraCommands`, `token.extraStoreHints` | More token sources after glab's, and more "store it" lines |
| `legacyLedgerProject` | Project of ledger lines written before they carried one |
| `config` | Laid over the built-in config defaults; the user's `config.json` still wins |

Tests assert against `NEUTRAL_DEFAULTS` and `NEUTRAL_CONFIG`, never the seam.

---

## Commands

`<iid>` is `42`, `!42` or the MR URL. A comma list (`12,34`) is accepted where it says so.

| Command | Description |
|---------|-------------|
| `pr <iid>` | The MR: title, author, branches, state, merge status, labels, thread and draft counts; `--json` |
| `pr <iid> review --receive` | Discussions JSON (default); `--md` (or `--format md\|both`) renders each unresolved thread with the MR tip, the reviewer's view when it differs, and a divergence label; `--llm` one line per thread, `--expand T01,T03` those threads in full |
| `pr <iid> review --give` | Facts for reviewing someone else's MR (see below); `--md`, `--llm`, `--format summary`, `--expand <ids>`, `--proposal-skeleton`, `--mine-only` |
| `pr <iid> review skeleton` | Write the judgements file: every judgeable item's heading (id, `discussion …` or `draft …`, anchor) and empty fields; `--force` starts over |
| `pr <iid> review check` | Check a filled judgements file; exit 1 with the item and line of every error |
| `pr <iid> review render` | The full layout to a file (`--out`, `--open`), or `--digest`, `--item <ids>`, `--proposal` (for `tools hub proposal push -`). Runs the `check` first: warnings go to stderr, and any error exits 1 with nothing rendered |
| `pr <iid> comments` | Threads with author, anchor and state; `--mine`, `--author`, `--unresolved`, `--json` |
| `pr <iid> comments drafts` | My pending drafts with where each one landed |
| `pr <iid> comments reply <thread>` | Draft reply in a thread (full id or unique prefix), or `--now` with `--resolve` |
| `pr <iid> comments add` | Anchored draft (`--file --line`) or top-level draft (`--top-level`); a comma list of MRs with `--top-level --now` posts on each, skipping a (project, MR, text) already in the ledger |
| `pr <iid> comments delete <draft…>` | Delete pending drafts of mine |
| `pr <iid> comments resolve <thread…>` | Resolve threads; `--unresolve` reopens them |
| `pr <iid> comments post` | Run the judgements file's actions as drafts (`--do T01,N01`), or answers into my own threads (`--answers D05`); a dry run until `--apply`, then read back; a ledger skips what already landed |
| `pr <iid> comments publish` | Submit every pending draft of mine; a dry run until `--apply`, refuses when `--expect <ids>` (D ids or draft ids) differs from the pending set |
| `pr <iids> labels --add/--remove <label>` | Change labels on one MR or a comma list; refuses unknown labels unless `--create-missing` |
| `pr touching <file…>` | Open MRs whose diff touches the files |
| `pr stale <step>` | The stale-MR workflow below |
| `activity user [--from/--to/--days]` | One user's events per local day: counts per action, commit totals, links; `--tz`, `--project` filter, `--format text\|md\|json`, `--detail` timeline |
| `activity user commits --user <u> --since <date>` | Day-by-day report of a user's commits across projects (Markdown or `--json`) |
| `activity project --since <date>` | Monthly commit report and maintainer leaderboard for one project |

### `pr stale`

A read-only sweep, an agent review, and a cleanup that writes only one MR at a time after approval.

```bash
tools gitlab pr stale preflight --out sweep.json --cwd ~/code/web-app   # facts + empty review fields
tools gitlab pr stale merge sweep.json --review slice-1.json             # copy filled reviews in
tools gitlab pr stale render sweep.json --out note.md                    # Markdown note
tools gitlab pr stale recheck sweep.json                                 # content check again, what moved
tools gitlab pr stale post sweep.json --iid 42 --draft                   # one MR, private draft note
tools gitlab pr stale publish sweep.json --iid 42
tools gitlab pr stale apply-labels sweep.json --dry-run
tools gitlab pr stale followup sweep.json --after-days 7                  # phase 2: who reacted
tools gitlab pr stale close sweep.json --iid 42 [--delete-branch]
tools gitlab pr stale manifest sweep.json                                # every MR we wrote to, live status
tools gitlab pr stale closed-bug sweep.json --dry-run                    # closed bug, open MR
```

Other steps: `reconcile`, `sync-note`, `shipped-detail`, `side-comment`, `mark-review`. The sweep JSON records the host and project, so later steps need no `--host` or `--project`.

**Content check, not history.** `shipped` samples the lines an MR branch adds and looks for them in the environment branches, because squash merges and rebases make ancestry say "never merged" for code that shipped.

### `pr <iid> review --give`

The reviewer's twin of `--receive`. Read-only: GETs on GitLab, and `git diff` / `cat-file` / `worktree list` in the checkout.

- **Diff**: from local git when the checkout has both the base and head commits (`--context-lines`, default 8), else from GitLab's diffs API. Every line carries its old- and new-side number.
- **Checkout**: `--repo <checkout>` (or `--cwd`; default: the current checkout when `--project` is not given). File links point at the worktree that has the MR's source branch checked out; the report warns when there is none or it is behind the MR head. `--worktree <dir>` uses that directory as the MR worktree even when its HEAD is on another branch.
- **Impact**: other open MRs that add an import of a module this MR deletes or renames (relative, root-relative and `@/` or `~/` aliased imports), or change the same files. `--impact-source api` (default) reads the diffs of at most 50 other open MRs from GitLab, the most recently updated first (`--impact-limit <n>` changes that), and warns when the result is partial. `--impact-source git` needs a checkout: it fetches every open MR branch into `refs/remotes/origin/*` and diffs locally, with no cap and no diff GitLab collapsed. `--no-impact` skips the scan.
- **Gates**: the `review.gates` from the config, below. None configured, no gates section. `review.runner: "parallel"` prints one block that starts every gate as a background `tools task` session and then prints each exit code (needs a POSIX shell). When `tools` is not on PATH, that block lists each command instead. A gate whose `{tests}` finds no test file is replaced by a note.
- **Your comments**: every pending draft of yours (`D`) in full: its body, whether it replies to a thread or opens one, where it sits in the diff (added, context or removed line) and the code around the anchor; then every thread you started (`Y`) in full. `--mine-only` prints only that, skips the impact scan and writes `...-drafts.json` and `.md`.
- **Threads**: `--threads` adds every unresolved diff thread in full after the checklist, as `--receive` renders it: all notes, the MR tip and the reviewer's view. With `--mine-only` it is the re-review view: your comments and the conversations they join.
- **Output**: stdout is the facts JSON by default; `--md` (or `--print`) the numbered report (json2md); `--llm` a compact view with ids (`F01` files, `T01` threads, `Y01` your threads, `D01` your drafts, `M01` affected MRs); `--format summary` nothing, only the summary lines on stderr; `--expand F03,T01` prints ids in full from the saved facts (`--refresh` collects again). Ids are kept per MR, so a second run gives the same thread the same id. Every collecting run writes `$TMPDIR/gitlab-pr-<project>-<key>-<iid>.json` and `.md` (`<key>` is a hash of the host and project, so two hosts never share a file), or the report at `--out <file>` with the JSON beside it, and prints both paths on stderr.
- **Proposal skeleton**: `--proposal-skeleton` prints a review proposal pre-filled from the facts (provider, host, project, number, branches, `baseSha`, `headSha`, `repoPath`, every thread with its `resolved` state). An agent adds the verdict and drafts. The `gt:review-proposal` skill says how to fill the proposal and push it with `tools hub proposal push`.

### Judgements: `review skeleton | check | render`, `comments post`

The agent writes its judgement of a review into ONE judgements file per MR (markdown, or JSON, see below), in the report's own labels. Everything generated (excerpts, links, quoted comments) stays out of it and is added by `render`.

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

- **JSON**: the same file can be JSON (`--file x.json`, or `review skeleton --format json`; `--print` writes the skeleton to stdout). Every command reads either form; broken JSON is repaired and reported. Both forms go through `md2json` / the JSON reader, which accept hand edits whose meaning stays clear (bold keys, `*` bullets, any heading level, `t3` for `T03`, a reply left outside its fence) and report each repair.
- **Items**: `T` threads others started (receive), `D` my pending drafts and `Y` threads I started (give), `N01…` new findings. The heading's `discussion …` / `draft …` is checked against the MR, so an id from an older run cannot reach another thread.
- **Actions**: `T` reply, reply-resolve, none; `Y` reply, none; `D` keep, reword, move, delete; `N` comment, none.
- **Anchors** carry the text of the line: `check` refuses a line outside the diff, or a line whose text differs, and names the line where that text really is.
- **`check`** also wants a `[NN%]` badge on every verdict, the text each action sends, and the configured `review.draftRules`.
- **`render`**: quoted comments are never shortened; text meant to be posted is a fenced block indented by three spaces (display only). An answer in my own thread is signed `[NN%] <agent>:` from its badge (`--agent`, default `Opus`).
- **`comments post`**: a dry run lists each step; `--apply` posts them as drafts, stops at the first failure, reads every result back and records it in the ledger. A D draft that `publish` turned into a thread is answered with `--answers D05`.

---

## Configuration

`~/.genesis-tools/gitlab/config.json`, every key optional. The defaults are neutral: English texts, ISO dates, no work-item lookups, production is the project's default branch.

```json
{
    "language": "en",
    "dateStyle": "iso",
    "messages": { "closedBug.askUnknown": "- Is the fix in production?" },
    "workItems": {
        "idPattern": "(?<!\\d)(\\d{6})(?!\\d)",
        "urlTemplate": "https://dev.azure.com/acme/web/_workitems/edit/{id}",
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

| Key | Default | Meaning |
|-----|---------|---------|
| `language` | `en` | Texts written onto MRs: `en` or `cs` |
| `dateStyle` | `iso` | `iso` (2026-09-08) or `dmy` (8.9.2026) in reports and comments |
| `messages` | `{}` | Override any comment template by key, `{name}` placeholders |
| `workItems.idPattern` | `null` | Regex whose first group is an Azure DevOps work-item id in MR title, branch or description; enables lookups through `tools azure-devops workitem` |
| `workItems.urlTemplate` | `null` | Link for items that cannot be read |
| `workItems.environmentField` / `mergeRequestField` | `null` | Custom field reference names read from the work item |
| `stale.label` | `Stale` | Label the cleanup adds and follows |
| `stale.mergeLabelPattern` | see above | Labels that claim a merge state; checked against the content |
| `stale.environments.uat` / `test` | `null` | Branches of those environments |
| `stale.environments.production` | `null` | Production branch; `null` means the default branch |
| `stale.environments.releasePrefix` | `null` | Dated release branches (`release/2026-09-10`); the newest past one is production |
| `stale.draftCommentGuide` | `null` | Replaces the draft-comment guidance in the preflight instructions |
| `stale.instructionsExtra` | `null` | Appended to the preflight instructions (house style, where evidence lives) |
| `stale.noteTags` | `[]` | Extra front-matter tags of the rendered note |
| `stale.contentCheckNote` | `null` | Appended to the note's explanation of the content check |
| `review.gates` | `[]` | Checks `pr <iid> review --give` lists for the reviewer to run: `label`, `command` (`{files}` becomes the matching changed files, `{tests}` the changed test files plus the test next to each changed source file), optional `when` glob over changed paths (a gate with `when` is listed only when a changed file matches), optional `exclude` glob removed from `{files}` and `{tests}` |
| `review.fetch.format` | `json` | What `pr <iid> review --receive` prints when neither `--format` nor `--md` is given: `json`, `md` or `both` |
| `review.fetch.contextLines` | `3` | `pr <iid> review --receive --context-lines` when the flag is not given |
| `review.nextSteps` | `[]` | Extra bullets under "Next steps" in the `--receive` report; `{iid}` becomes the MR iid |
| `review.runner` | `list` | `list`: the gate commands one after another. `parallel`: each gate as a background `tools task` session, then every exit code |
| `review.impactSource` | `api` | Default of `--impact-source`: `api` or `git` |
| `review.worktreeHint` | `null` | Replaces the "create a worktree" advice when no worktree has the MR branch; `{branch}` and `{iid}` are filled in |
| `review.draftRules` | none | What `review check` enforces in text that goes to the MR: `bannedWords` (`[{ word, instead }]`), `forbidDashes`, `ownThreadForbidden` (optional, empty by default: phrases that address nobody in a thread you started; a hit only warns, it never blocks) |

Ledgers of writes live next to the config: `comment-batch.jsonl`, `label-batch.jsonl`, `review-ledger/` (what `comments post` landed) and `review-ids/` (the id map of each MR).

---

## Scripting

`@app/gitlab/lib/mr` wraps one MR for scripts:

```ts
import { mr } from "@app/gitlab/lib/mr";

const review = mr(42, { project: "acme/web-app" });
for (const thread of await review.discussions({ unresolved: true })) {
    await review.reply(thread.id, "Fixed in the latest push.");
}
await review.publishDrafts();
```

---

## Related tools

- `tools github` — the GitHub counterpart
- `tools azure-devops` — work items that `pr stale` reads when `workItems.idPattern` is set
