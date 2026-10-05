# Git

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Git analysis for commits, authors, and workitem ID extraction, plus branch mechanics with proof.**

Queries commits across a date range, extracts workitem IDs from commit messages via configurable regex patterns, attributes branches, classifies rebased commits, and maintains a list of author identities so you can slice history cleanly across name/email changes. The branch side answers "is it merged?" by content (`merged`), rebases a parent with its children (`rebase-cascade`), detects the base branch (`base`), splits one branch into one branch per path group and proves nothing was lost (`rebranch plan`, `apply`, `verify`) and reads the per-repo policy file (`config`). `changes` shows what you touched and when. The `gt:git` skill in `plugins/genesis-tools` is the guided workflow on top of these commands; the typed git readers they share live in `src/utils/git/` (`createGit()` and `porcelain`).

`tools git commits` is the reporting layer. The same tool holds the two interactive history editors, `rebranch` (when run without a subcommand) and `rename-commits`.

---

## Quick Start

```bash
# Query commits for the last week
tools git commits --from 2026-04-13 --to 2026-04-20

# Include line-change stats and filter by author
tools git commits --from 2026-04-01 --to 2026-04-30 --stat --author "Martin"

# Group by branch, include workitem titles from Azure DevOps cache
tools git commits --from 2026-05-01 --to 2026-05-15 --group-by branch --with-workitem-title

# markdown for standup / Clarity paste
tools git commits --from 2026-05-14 --to 2026-05-27 --markdown --clipboard

# Configure authors interactively (pick from git history)
tools git configure-authors

# Quick add/remove
tools git configure-authors --add "Your Name"
tools git configure-authors --remove "old-name"

# Suggest workitem patterns from a repo
tools git configure-workitem-patterns --suggest --repo /path/to/repo

# Add a custom pattern
tools git configure-workitem-patterns --add 'col-(\d+)'
```

---

## Commands

### `commits`

Query commits by date range with optional workitem extraction, branch attribution, and rebase handling.

| Option | Description |
|--------|-------------|
| `--from <YYYY-MM-DD>` | Start date (required) |
| `--to <YYYY-MM-DD>` | End date (required) |
| `--author <name>` | Override configured authors (repeatable) |
| `--with-author <name>` | Append to configured authors (repeatable) |
| `--format <json\|table>` | Output format (default: table) |
| `--stat` | Include line-change stats |
| `--group-by <day\|branch\|workitem\|none>` | Group main listing (default: `day`) |
| `--without-branch` | Hide inline `[branch]` column (shown by default) |
| `--without-workitem-id` | Hide inline `[#id]` column (shown by default) |
| `--with-workitem-title` | Resolve Azure DevOps titles (cache-first); shown inline after `#id` **and** in the Workitem Summary |
| `--with-workitems` | Alias for `--with-workitem-title` |
| `--with-full-commit-messages` | Show full multi-line commit bodies (default: first line only) |
| `--without-stashes` | Exclude `WIP on` / `index on` stash commits |
| `--without-merges` | Exclude merge commits |
| `--workitem <id>` | Filter to commits referencing workitem ID (repeatable, OR) |
| `--include-rebases` | Expand rebased-into-range commits inline |
| `--date <author\|commit\|true-first>` | Date used for grouping (default: `author`) |
| `--markdown` | markdown output (day headers, bullet list) |
| `--clipboard` | Copy output to clipboard (`--markdown` recommended) |

**Rebase behaviour:** `git log --after`/`--before` still filter by committer date. Commits authored before `--from` but committed inside the range are clustered by landing time. In the default `day` grouping each cluster is folded into the day it **landed** (committer date) as a single `▸ N commits rebased … [from <branch>]` line, with the day header showing `(N commits, M rebased)`. Under `--group-by branch|workitem|none` the clusters stay in a compressed footer instead. `--include-rebases` expands every rebased commit in its own section. Patch-id dedup collapses cherry-pick/rebase duplicates (keeps newest committer date).

**Default inline columns:** each row shows `[branch]` and `[#workitem]` when known. Trunk-only attribution is labelled `[trunk: develop]`. Only the **first line** of each commit message is shown — pass `--with-full-commit-messages` for the full body.

**`(?)` marker:** a commit flagged `(?)` had its author date likely reset by a rebase/amend, so the timestamp shown is the original authoring time, not when it landed. A legend prints at the bottom whenever any `(?)` appears.

**Performance:** branch attribution (`git branch --contains`) and patch-id dedup (`git show | git patch-id`) run in parallel; a ~1000-commit / two-week range over `--all` resolves in ~1s. Per-phase timings are logged at `debug` level — run with `-v` or read `~/.genesis-tools/logs/<today>.log` to triage slow runs.

### `merged`

Is a branch or worktree already in the base? A verdict by content, not by sha: squash, rebase and recompose all fool `git branch -d`, `merge-base --is-ancestor`, `git cherry` and `git diff --stat`.

```bash
tools git merged feat/x                       # one ref (a branch or a worktree path)
tools git merged --all                        # every local branch and detached worktree
tools git merged --all --pr                   # corroborate with each branch's PR/MR; stacked children are judged against their PR target
tools git merged --prune feat/x --prune .worktrees/feat-y   # remove only the named refs, each re-verified, one confirmation
```

| Verdict | How | Meaning |
|---|---|---|
| `EMPTY` | `-` | the tip is the base tip itself |
| `MERGED` | `ancestor` | plain merge or fast-forward |
| `MERGED` | `cherry` | rebased or cherry-picked; every patch-id exists upstream |
| `MERGED` | `content` | squashed, recomposed or a snapshot: every touched file's final blob exists in the base's history since the fork |
| `STALE` | `superseded` | nothing of the branch landed as-is, but the base itself rewrote EVERY file it touches: an older draft of work that moved on (a pre-review snapshot of a squash-merged PR, a `backup/*` cut before a rebase, an agent scratch branch) |
| `UNMERGED` | `none` | the listed files hold content the base never had, including at least one path the base never touched again after the fork |

| Option | Description |
|---|---|
| `[refs...]` | Branch names or worktree paths |
| `--all` | Every local branch except the base and master/main, plus every detached worktree |
| `-b, --base <ref>` | Base to judge against (default: config `mainPrBranch`, else origin HEAD) |
| `--pr` | Look up each branch's PR/MR (network) |
| `--json` | Full report as JSON; never deletes |
| `--prune <ref>` | Remove this ref (repeatable). There is no "prune everything": name what a plain run listed |
| `--remote` | With `--prune`: also delete `origin/<branch>` when it is the upstream, no PR is open and the push policy allows |
| `--yes` | With `--prune`: skip the confirmation (non-interactive runs need it) |
| `-d, --stale-days <n>` | Flag branches with no commit newer than this (default 90) |
| `-C, --cwd <path>` | Repository path |

`--prune` refuses UNMERGED refs, dirty worktrees, the current branch, the base and the main checkout; an unpushed MERGED branch is a warning (the remote holds an older copy). Exit 0 when every ref is MERGED or EMPTY and clean, 1 otherwise, 2 on usage.

STALE refs are listed in their own section and are never folded into the "safe to remove" line: whether an older draft is worth keeping is the reader's call, so `--prune` has to name each one. They do not fail the exit code.

`--prune origin/<branch>` deletes a REMOTE-ONLY branch, the case where the local copy is already gone (`--remote` alone cannot reach it: that flag only follows a local branch to its upstream). It needs `--remote` explicitly, and every gate that merely drops the remote step for a local branch REFUSES the whole ref here, because there is nothing else to delete: an open PR, a failed PR lookup (pass `--pr` so the lookup runs at all), a `push: never` policy, or the base branch itself. The success line prints `git push origin <sha>:refs/heads/<branch>`, which is the only way back — a deleted remote branch has no reflog.

### `rebase-cascade`

Rebase a parent branch onto its target and transplant every child stacked on it. Children are detected by merge-base (a child carries parent-only commits the target lacks), fork points are saved before the parent moves, a child checked out in another worktree is rebased there, every branch gets a backup ref (`refs/backup/cascade/<branch>`) and tag (`bkp/cascade/<branch>-<ts>`), and nothing is pushed.

```bash
tools git rebase-cascade feat/parent --dry-run          # the plan, nothing moves
tools git rebase-cascade feat/parent [--onto origin/master] [--child feat/c1]
tools git rebase-cascade --continue | --status | --abort | --restore <branch> | --cleanup
```

The parent's route comes from the merged engine: `rebase` (plain), `merged` (already upstream: children go straight onto the target), or `oracle` (recomposed upstream: the tool prints the net conflicts and stops for the oracle merge, then `--continue`). A conflict leaves that branch's rebase in progress; resolve, `git rebase --continue`, then `--continue` here. The plan file lives in the git common dir, so every worktree of the clone sees it.

### `base`

`tools git base [branch]` prints the base branch and the rule that chose it: `--base`, the branch's open PR/MR target, config `mainPrBranch`, the closest declared branch, or an inference (closest merge-base, then origin HEAD, then a local master/main). `--offline` skips the PR lookup, `--json` for machines.

### `changes`

What did I touch, and when? Lists the uncommitted files, newest first, grouped by how long ago each was modified (`Last hour`, `Last 3 hours`, `Today`, `Yesterday`, `Last N days`, `Older`). Each row shows the status, the path, and the relative and absolute time. It only reads: nothing is staged or written.

```bash
tools git changes                  # uncommitted files grouped by modification time
tools git changes --commits 5      # the files of the last 5 commits, grouped by commit time
tools git changes -C ../other      # another repository
```

| Option | Description |
|---|---|
| `-c, --commits <n>` | Show the files of the last N commits instead of uncommitted changes; each file is stamped with its commit's committer time |
| `-C, --cwd <path>` | Repository path |

Status colors: yellow for modified, green for added, red for deleted, blue for renamed, cyan for copied, gray for untracked. A deleted file has no mtime, so it counts as modified now. An untracked directory is listed file by file. A rename is listed under its new path. In `--commits` mode a merge commit lists nothing of its own; its files appear under the commits it brought in. The status comes from the typed `git status --porcelain=v2 -z` reader in `src/utils/git/` and the paths are relative to the repository root, so the command works from any subdirectory.

### `rebranch`

Split a messy branch into several clean ones. Two ways in.

**Interactive** (no subcommand, needs a terminal): it finds the fork point, groups the commits by conventional-commit scope or ticket id (`feat(login, PROJ-123): ...`), lets you refine each group in a searchable multiselect, names the branches, and cherry-picks each group from the fork point. `--dry-run` prints the plan and creates nothing. Commits that conflict are skipped with a warning.

```bash
tools git rebranch --dry-run     # the plan only
tools git rebranch
```

**By path groups** (no prompts, for agents and scripts): `plan`, then `apply`, then `verify`. This is the flow of the `gt:git` skill (`references/recompose-branches.md`) as code.

```bash
tools git rebranch plan --groups 'api=src/api/**' --groups 'web=src/web/**,docs/web' --base origin/master
tools git rebranch plan --groups 'api=src/api/**' --groups 'web=src/web/**,docs/web' --base origin/master --json > plan.json
# edit plan.json: a decision on every MIXED commit, the commits in no group added to a group or listed under skip
tools git rebranch apply --plan plan.json --dry-run    # the exact git commands, nothing written
tools git rebranch apply --plan plan.json --yes        # build the branches, then verify
tools git rebranch verify --plan plan.json             # the proof alone, on existing branches
```

`plan` is read-only. It detects the base with the same ladder as `tools git base` (`--base`, the PR target, config `mainPrBranch`, a declared branch, an inference; `--offline` skips the PR lookup), lists the source's commits since the merge-base, and classifies each one per group: **IN** (every changed path matches), **OUTSIDE** (none does) or **MIXED** (both). Paths are listed with rename detection off, so a move counts with its old and its new name. It also lists the commits in no group and the commits in several groups. A merge commit in the range stops it: linearise the source first. A pattern with `*` uses the repo's glob matcher (`*` also crosses `/`, matching ignores case); a pattern without `*` names a file or a directory and matches everything below it.

`apply` refuses to start with uncommitted or untracked changes, a rebase or cherry-pick in progress, a locked index, a group branch name that already exists, or a MIXED commit without a decision. Per group it runs `git switch -c <branch> --no-track <base>` and `git cherry-pick -x` for each commit in source order. A `paths-only` commit is picked whole first; then the paths outside the group are printed, put back from the branch tip before that pick (`git restore --source=<tip> --staged --worktree`), and the commit is amended (`--no-verify`, so no hook rewrites it). Restoring from the pre-pick tip rather than the base keeps what an earlier pick on the same branch did to those paths. If the restore or the amend fails, `--continue` finishes that cleanup instead of picking the commit again, and refuses while the checkout holds a change the cleanup did not make (an edit to a path outside the group, an unrelated staged file), because the restore would overwrite it and the amend would commit it. At the end it switches back to the starting branch, runs the verification, and prints the `git push` and `gh pr create` lines, which it never runs. The source branch is never moved.

One rebranch operation runs per repository: `apply`, `--continue` and `--abort` hold `<git-common-dir>/genesis-rebranch.lock` until they end, and a second invocation from any worktree is refused at once. A killed run leaves a lock the next invocation takes over. A conflict stops the run and keeps its state in `<git-common-dir>/genesis-rebranch.json`. Resolve, `git add`, `git cherry-pick --continue` (or `--skip` to leave that commit out), then `tools git rebranch apply --continue`. `apply --abort` stops the cherry-pick, returns to the starting branch, and removes every branch this run created; each one is first tagged `bkp/rebranch/<branch>-<stamp>`, and the command prints the `git branch <name> <tag>` line that brings it back. When the final verification fails the state is kept as well: fix the branches and run `--continue` to prove the split again, run `--abort` to remove them, or start another `apply`, which replaces the record and leaves those branches in place.

`verify` is the proof, as code. For every path the source changed since the merge-base, it finds the last source commit that touched it and the groups that carry that change (`whole`, or `paths-only` with the path inside the group). One of those group branches must hold the source's final entry: the same mode and blob, or no file at all after a deletion. When the base moved after the fork, the expected entry comes from the source merged onto the base (`git merge-tree`); a path that merge conflicts on is reported as unverified. It exits 1 and names the path when an entry differs, when the last change of a path is in no group (lost), or when a group branch changes a path the source never touched (extra). A path whose last change was left out on purpose (`skip`, `paths-only`, or the top-level skip list) is reported as dropped and does not fail the check. Paths changed by commits in two groups are reported as shared.

The plan file (`plan --json` prints a complete one; `apply` and `verify` read it from a path or from `-` for stdin):

```jsonc
{
  "version": 1,
  "source": "feat/messy",                  // the branch to split; never moved
  "base": "origin/master",                 // the new branches start at its tip
  "sourceSha": "…", "baseSha": "…", "mergeBase": "…",   // optional: apply warns when they moved
  "groups": [
    {
      "name": "api",
      "branch": "feat/messy-api",          // must not exist yet
      "paths": ["src/api/**"],             // the group's patterns; paths-only and verify use them
      "commits": [
        { "sha": "1a2b3c4d…", "decision": "whole" },
        { "sha": "5e6f7a8b…", "decision": "paths-only" }   // a MIXED commit: keep only src/api/**
      ]
    }
  ],
  "skip": ["9c0d1e2f…"]                    // commits left out of every group on purpose
}
```

| Field | Rule |
|---|---|
| `commits[].sha` | 7 to 64 hex characters; a unique prefix of a commit of `source` since the merge-base |
| `commits[].decision` | `whole`, `skip` or `paths-only`. Required for a MIXED commit; an IN or OUTSIDE commit defaults to `whole`. `paths-only` on a commit with no path in the group is refused |
| commit order | picked in source order whatever the list order (apply says when it reordered) |
| other keys | `subject`, `class`, `outsidePaths`, `baseSource`, `commits`, `unassigned`, `shared` are information from `plan` and ignored on read |

Exit codes: `plan` 0, or 1 on merges or an empty range; `apply` 0 when the branches are built and verified, 1 on a refusal, a conflict, a failure or a failed proof, 2 on missing arguments, on `--dry-run` combined with `--continue` or `--abort` (those always act, so a preview of them would lie), on `--continue` combined with `--abort`, or on no `--yes` without a terminal; `verify` 0 or 1.

### `rename-commits`

Interactive reword of the last N commits: it shows each commit with its message as the default, collects the new messages, shows an OLD/NEW confirmation screen, and then rewrites history with a rebase. It checks that the commits are already pushed (or that a rebase only changed hashes) and warns before rewriting; `--force` skips that check. It rewrites history, so back the branch up first. To reshape commits from an agent use the recommit script in the `gt:git` skill instead.

```bash
tools git rename-commits --commits 3
tools git rename-commits -c 5 --force
```

### `config`

Per-repository `genesis-tools.config.json`, read from `<repo>/.claude/` first and then from the git common dir (shared by every worktree):

```jsonc
{
  "git": {
    "mainPrBranch": "feature/next",
    "branches": [
      { "name": "master", "push": "confirm", "environment": "prod" },
      { "nameRegex": "^release/", "push": "never" },
      { "catchAll": true, "push": "allowed" }
    ]
  }
}
```

`tools git config show` prints the effective file and what each local branch matches, `config init` infers a main branch and writes the file after confirmation, `config check` validates it (exactly one matcher per entry, `catchAll` last, `push` in `confirm | never | allowed`).

### `configure-authors`

Manage the author identities used by `commits` when `--author` isn't passed.

| Option | Description |
|--------|-------------|
| `--add <name>` | Add author (repeatable) |
| `--remove <name>` | Remove an author |
| `--list` | List configured authors |
| _(no flags)_ | Interactive multi-select from `git log` |

### `configure-workitem-patterns`

Manage regex patterns that extract workitem IDs (e.g. `DEV-1234`, `FEAT-42`) from commit messages.

| Option | Description |
|--------|-------------|
| `--list` | List current patterns |
| `--add '<regex>'` | Add a pattern |
| `--remove <index>` | Remove a pattern by index |
| `--suggest` | Scan a repo and propose patterns |
| `--repo <path>` | Repo to scan for `--suggest` (default: cwd) |
| _(no flags)_ | Interactive management |

---

## Storage

Configuration lives at `~/.genesis-tools/git/config.json`.

Example with branch attribution:

```json
{
  "authors": ["you@example.com"],
  "workitemPatterns": [ ... ],
  "branchAttribution": {
    "excludeTrunks": ["develop", "main", "master"]
  }
}
```

`branchAttribution.excludeTrunks` is optional; defaults to `develop`, `main`, and `master`. Names matching these (including `origin/<name>`) are skipped during branch resolution unless no other branch exists — then the trunk is shown as `[trunk: <name>]`.

Workitem pattern tightening (e.g. `col-(\d{5,6})` instead of `col-(\d+)`) is per-user via `configure-workitem-patterns` or direct config edit; code defaults remain loose for other projects.
