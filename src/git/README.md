# Git

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Git analysis for commits, authors, and workitem ID extraction, plus branch mechanics with proof.**

Queries commits across a date range, extracts workitem IDs from commit messages via configurable regex patterns, attributes branches, classifies rebased commits, and maintains a list of author identities so you can slice history cleanly across name/email changes. The branch side answers "is it merged?" by content (`merged`), rebases a parent with its children (`rebase-cascade`), detects the base branch (`base`) and reads the per-repo policy file (`config`). The `gt:git` skill in `plugins/genesis-tools` is the guided workflow on top of these commands; the typed git readers they share live in `src/utils/git/` (`createGit()` and `porcelain`).

This is complementary to `git-commit` (which *creates* commits) and `git-last-commits-diff` (which *renders* diffs). `tools git commits` is the reporting layer.

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
| `UNMERGED` | `none` | the listed files hold content the base never had |

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
