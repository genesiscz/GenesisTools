# GitLab

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **GitLab CLI for any instance: per-day activity, activity reports, MR review threads and drafts, batch comments and labels, open MRs by file, and a two-phase stale-MR cleanup.**

Talks to the GitLab REST and GraphQL APIs directly. Nothing about the instance is built in: the host, the token and the project are resolved from flags, the environment, `glab` and the git checkout you stand in.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Any instance** | `--host`, `GITLAB_HOST`, or glab's default host; self-hosted and relative-root installs work |
| **Zero-config auth** | Reuses the token glab stores for that host; `GITLAB_TOKEN` overrides |
| **Project from origin** | Project-scoped commands read the `origin` remote when it points at the resolved host |
| **Per-day activity** | `activity` groups one user's events per local day, with links; the window is widened so late-evening events land on the right day |
| **Activity reports** | `analyze-user` and `analyze-project` avoid the GitLab `?all=true` pagination bug |
| **Pagination that does not lie** | Follows `X-Next-Page`; GitLab can return a short page while more pages exist, and some endpoints ignore `page` entirely |
| **Review threads** | `fetch-review` returns the MR's discussions as JSON; `--md` renders unresolved threads with the local code and the reviewer's frozen view |
| **Reviewing an MR** | `pr review` gathers what a reviewer of someone else's MR needs: numbered hunks, file checklist, existing threads, your drafts, open MRs this one breaks or overlaps, configured gates; JSON, markdown, a compact `--llm` view, or a review-proposal skeleton for the GenesisTools.app review window |
| **Draft replies** | `draft-reply` folds into the one pending draft GitLab allows per thread instead of failing |
| **Batch writes** | `batch-comment` and `batch-label` keep a ledger, dedupe, and log before/after |
| **Stale-MR cleanup** | `stale-branches` collects facts, lets an agent review, renders a note, then posts, labels and closes one MR at a time |

---

## Quick Start

```bash
# What you did on GitLab last week, per local day (comments, pushes, approvals, merges)
tools gitlab activity --days 7
tools gitlab activity --from 2026-09-01 --to 2026-09-30 --format md --detail --output september.md

# Who did what since a date, across every project they pushed to
tools gitlab analyze-user --user alice --since 2026-09-01 --out alice.md

# One project, grouped by month, with a maintainer leaderboard
tools gitlab analyze-project --project acme/web-app --since 2026-01-01

# Open MRs that touch a file (exact path or path suffix)
tools gitlab search-by-file --file bun.lock --file package.json

# Review threads of MR !42: JSON, or the report with code excerpts
tools gitlab fetch-review 42 --cwd ~/code/web-app
tools gitlab fetch-review 42 --cwd ~/code/web-app --md

# Review someone else's MR !57: facts JSON, report, compact view, drill-down, proposal skeleton
tools gitlab pr review 57 --repo ~/code/web-app
tools gitlab pr review 57 --md
tools gitlab pr review 57 --llm
tools gitlab pr review 57 --expand f3,t1
tools gitlab pr review 57 --proposal-skeleton --agent claude > /tmp/review-57.json

# Threads, draft replies, publish
tools gitlab discussions 42 --unresolved
tools gitlab draft-reply 42 --discussion 3f9c2d1 --body-file reply.md
tools gitlab draft-reply 42 --file src/api/client.ts --line 34 --body-file note.md
tools gitlab drafts 42 --publish

# Batch writes (always try --dry-run first)
tools gitlab batch-comment 12,34,56 --comment "Please rebase onto main." --dry-run
tools gitlab batch-label 12,34 --add Stale --remove "Needs review" --dry-run
```

---

## Host, token and project

| What | Order |
|------|-------|
| Host | `--host <url>` → `GITLAB_HOST` → `glab config get host` → error with setup help |
| Token | `GITLAB_TOKEN` → `glab config get token --host <hostname>` → `glab auth token --hostname <hostname>` → error that links the token page of that host with the `api` scope filled in |
| Project | `--project <group/name or id>` → `GITLAB_PROJECT` → the `origin` remote of the current checkout, when its host matches → error |

The host is normalised to `https://host` (an explicit `http://` and a relative root such as `/gitlab` are kept). The token is resolved once per host per process.

---

## Subcommands

| Command | Description |
|---------|-------------|
| `activity [--from/--to/--days]` | One user's events per local day: counts per action, commit totals, links; `--tz`, `--project` filter, `--format text\|md\|json`, `--detail` timeline |
| `analyze-user --user <u> --since <date>` | Day-by-day report of a user's commits across projects (Markdown or `--json`) |
| `analyze-project --since <date>` | Monthly commit report and maintainer leaderboard for one project |
| `batch-comment <iids> --comment <text>` | Post the same comment on many MRs; skips a (project, MR, text) already in the ledger |
| `batch-label <iids> --add/--remove <label>` | Change labels on many MRs; refuses unknown labels unless `--create-missing` |
| `fetch-review <iid>` | Discussions JSON (default); `--md` (or `--format md\|both`) renders the per-thread report with local and frozen code views |
| `pr review <iid>` | Facts for reviewing an MR (see below); `--md`, `--llm`, `--expand <refs>`, `--proposal-skeleton` |
| `discussions <iid>` | Threads with author, anchor and state |
| `draft-reply <iid>` | Draft reply, anchored draft (`--file/--line`), top-level draft, or `--now` with `--resolve` |
| `drafts <iid>` | Pending drafts with where each one landed; `--publish`, `--delete <id>` |
| `search-by-file --file <path>` | Open MRs whose diff touches the file |
| `stale-branches <step>` | The stale-MR workflow below |

### `stale-branches`

A read-only sweep, an agent review, and a cleanup that writes only one MR at a time after approval.

```bash
tools gitlab stale-branches preflight --out sweep.json --cwd ~/code/web-app   # facts + empty review fields
tools gitlab stale-branches merge sweep.json --review slice-1.json             # copy filled reviews in
tools gitlab stale-branches render sweep.json --out note.md                    # Markdown note
tools gitlab stale-branches recheck sweep.json                                 # content check again, what moved
tools gitlab stale-branches post sweep.json --iid 42 --draft                   # one MR, private draft note
tools gitlab stale-branches publish sweep.json --iid 42
tools gitlab stale-branches apply-labels sweep.json --dry-run
tools gitlab stale-branches followup sweep.json --after-days 7                  # phase 2: who reacted
tools gitlab stale-branches close sweep.json --iid 42 [--delete-branch]
tools gitlab stale-branches manifest sweep.json                                # every MR we wrote to, live status
tools gitlab stale-branches closed-bug sweep.json --dry-run                    # closed bug, open MR
```

Other steps: `reconcile`, `sync-note`, `shipped-detail`, `side-comment`, `mark-review`. The sweep JSON records the host and project, so later steps need no `--host` or `--project`.

### `pr review`

The reviewer's twin of `fetch-review`. Read-only: GETs on GitLab, and `git diff` / `cat-file` / `worktree list` in the checkout.

- **Diff**: from local git when the checkout has both the base and head commits (`--context-lines`, default 8), else from GitLab's diffs API. Every line carries its old- and new-side number.
- **Checkout**: `--repo <checkout>` (default: the current checkout when `--project` is not given). File links point at the worktree that has the MR's source branch checked out; the report warns when there is none or it is behind the MR head.
- **Impact**: other open MRs that add an import of a module this MR deletes or renames (relative, root-relative and `@/` or `~/` aliased imports), or change the same files. It reads the diffs of at most 50 other open MRs, the most recently updated first (`--impact-limit <n>` changes that), and warns when the result is partial. `--no-impact` skips the scan.
- **Gates**: the `review.gates` from the config, below. None configured, no gates section.
- **Output**: stdout is the facts JSON by default; `--md` the numbered report (json2md); `--llm` a compact view with refs (`f1` files, `t1` threads, `d1` your drafts, `m1` affected MRs); `--expand f3,t1` prints refs in full from the saved facts (`--refresh` collects again). Every collecting run writes `$TMPDIR/gitlab-pr-<project>-<key>-<iid>.json` and `.md` (`<key>` is a hash of the host and project, so two hosts never share a file) and prints both paths on stderr.
- **Review window**: `--proposal-skeleton` prints a review proposal pre-filled from the facts (provider, host, project, number, branches, `baseSha`, `headSha`, `repoPath`, every thread with its `resolved` state). An agent adds the verdict and drafts and pushes it with `tools hub proposal push`; the `gt:review-proposal` skill describes the flow.

**Content check, not history.** `shipped` samples the lines an MR branch adds and looks for them in the environment branches, because squash merges and rebases make ancestry say "never merged" for code that shipped.

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
        "draftCommentGuide": null
    },
    "review": {
        "gates": [
            { "label": "types", "command": "bunx tsgo --noEmit" },
            { "label": "unit tests", "command": "bun test {files}", "when": "src/**/*.test.ts" }
        ]
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
| `review.gates` | `[]` | Checks `pr review` lists for the reviewer to run: `label`, `command` (`{files}` becomes the matching changed files), optional `when` glob over changed paths; a gate with `when` is listed only when a changed file matches |

Ledgers of writes live next to the config: `comment-batch.jsonl` and `label-batch.jsonl`.

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
- `tools azure-devops` — work items that `stale-branches` reads when `workItems.idPattern` is set
