# tools git

Git reports and branch mechanics with proof. It answers "what did I commit and on which work item", "is this branch
already merged" (by content, so squash, rebase and recompose do not fool it) and "what is this branch based on". It
moves branches safely: a cascade rebase of a parent and its children, a split of one branch into several with a proof
that nothing was lost, and a reword of recent commit messages. It also holds the per-repository policy file, the
worktree setup, git's file system monitor, and a code health score.

The `gt:git` skill in `plugins/genesis-tools` is the guided workflow on top of these commands. The typed git readers
they share live in `src/utils/git/` (`createGit()` and `porcelain`).

## Quick start

```bash
# Your commits of one week, grouped by day, with branch and work item columns
tools git commits --from 2026-11-02 --to 2026-11-08

# Is this branch already in the base, even after a squash merge?
tools git merged feat/login

# Every local branch and detached worktree, with a verdict each
tools git merged --all

# Which branch is the current one based on, and which rule decided?
tools git base

# The files you touched, newest first, grouped by how long ago
tools git changes

# The scariest files of a folder, as a ranked table
tools git health src --top 10
```

## Commands

Every command runs in the current directory's repository. The branch and config commands take `-C, --cwd <path>` to
run against another one (`worktree` takes the long `--cwd <path>` only).

| Job | Commands |
|---|---|
| Report on history | `commits`, `configure-authors` (`authors`), `configure-workitem-patterns` (`patterns`), `changes` |
| Read branch state | `merged`, `base` |
| Move and reshape branches | `rebase-cascade`, `rebranch` (`interactive`, `plan`, `apply`, `verify`), `rename-commits` |
| Set up a repository | `config` (`show`, `init`, `check`), `worktree` (`config`, `init`, `sync-plans`, `backup`), `fsmonitor` |
| Score code health | `health`, `monster` |

Options of the tool itself:

| Option | What it does |
|---|---|
| `-v, --verbose` | Debug logging; `rebranch` also prints every git command it runs |
| `-?, --help-full` | Long help with examples |
| `--readme` | Print this README |
| `-V, --version` | Print the version |

### History reports

#### `commits`

Your commits in a date range, across every ref (`git log --all`), with work item ids from the messages, the branch
each commit belongs to, and rebase handling. `--to` is inclusive.

```bash
tools git commits --from 2026-11-01 --to 2026-11-15 --stat --author "Alice Example"
tools git commits --from 2026-11-01 --to 2026-11-15 --group-by branch --with-workitem-title
tools git commits --from 2026-11-01 --to 2026-11-15 --markdown --clipboard   # for a standup or time-log paste
tools git commits --from 2026-11-01 --to 2026-11-15 --workitem 4242 --format json
```

| Option | Description |
|---|---|
| `--from <date>` | Start date, `YYYY-MM-DD` (required) |
| `--to <date>` | End date, `YYYY-MM-DD`, inclusive (required) |
| `--author <name...>` | Only these authors, instead of the configured ones (repeatable) |
| `--with-author <name...>` | Add authors to the configured ones (repeatable) |
| `--format <format>` | `table` (default) or `json` |
| `--stat` | Add files changed, insertions and deletions |
| `--group-by <mode>` | `day` (default), `branch`, `workitem` or `none` |
| `--without-branch` | Hide the inline `[branch]` column |
| `--without-workitem-id` | Hide the inline `[#id]` column |
| `--with-workitem-title` | Look up work item titles in Azure DevOps (see below) |
| `--with-workitems` | Alias for `--with-workitem-title` |
| `--with-full-commit-messages` | Show whole commit bodies, not only the first line |
| `--without-stashes` | Leave out stash commits (`WIP on`, `index on`) |
| `--without-merges` | Leave out merge commits |
| `--workitem <id>` | Only commits that name this work item (repeatable, OR) |
| `--include-rebases` | List every rebased-into-range commit in its own section |
| `--date <mode>` | Date to group by: `author` (default), `commit` or `true-first` |
| `--markdown` | Markdown output: day headers and a bullet list |
| `--clipboard` | Copy the output; only with `--markdown` or `--format json` (a table prints a warning) |

Without `--author` it uses the authors you saved with `configure-authors`. With none saved it shows every author's
commits and says so.

**Inline columns.** Each row shows `[branch]` and `[#workitem]` when they are known. A commit that is only on a trunk
is labelled `[trunk: develop]`. Only the first line of each message is shown unless you pass
`--with-full-commit-messages`.

**Branch attribution.** The branch comes from `git name-rev` and `git branch --contains`. Trunk branches
(`develop`, `main`, `master` and their `origin/` copies by default) are skipped, unless no other branch holds the
commit. A name whose last segment is a trunk name (`release/main`) counts as a trunk too. When several branches
hold a commit, the one whose name contains one of the commit's work item ids wins, else the first in alphabetical
order. Change the trunk list with `branchAttribution.excludeTrunks` (see Configuration).

**Rebase behaviour.** `git log --after` and `--before` filter by committer date. So a commit authored before `--from`
but committed inside the range (a rebase landed it) is in the result. These commits are clustered by landing time. In
the default `day` grouping each cluster is folded into the day it landed as one `▸ N commits rebased … [from
<branch>]` line, and the day header shows `(N commits, M rebased)`. Under `--group-by branch|workitem|none` the
clusters stay in a short footer. `--include-rebases` lists every rebased commit in its own section. Patch-id dedup
collapses cherry-pick and rebase duplicates and keeps the one with the newest committer date.

**The `(?)` marker.** A commit marked `(?)` has an author date about equal to its commit date, clustered into one
minute with others. That is the fingerprint of a rebase or amend that reset the author date, so the time shown is
likely when it was rebased, not when the work was written. A legend prints at the bottom of the table output
whenever a `(?)` appears (the `--markdown` output has the marker but no legend). `--date true-first` groups such
commits by their commit date.

**Work item titles.** `--with-workitem-title` needs a `tools azure-devops` configuration. It reuses fresh titles from
that tool's cache and fetches the rest from the Azure DevOps API in one batch (a network call). Without a
configuration the titles are skipped, with a debug log line only. When a configuration exists but the Azure DevOps
login fails (it expired, say), the whole run fails with exit 1 and shows no commits. A title shows inline after
`#id` and in the Workitem Summary.

**Performance.** Branch attribution (`git branch --contains`) and patch-id dedup (`git show | git patch-id`) run in
parallel. A range of about 1,000 commits over two weeks across `--all` resolves in about 1 s. Per-phase timings are
logged at debug level: run with `-v`, or read `~/.genesis-tools/logs/<today>.log`, to triage a slow run.

#### `configure-authors` (alias `authors`)

The author identities `commits` uses when you pass no `--author`. Each one goes to `git log --author`, so a name or an
email both work.

```bash
tools git configure-authors                          # pick from the authors in git log (interactive)
tools git configure-authors --add "Alice Example" --add alice@example.com
tools git configure-authors --remove "old-name"
tools git configure-authors --list
```

| Option | Description |
|---|---|
| `--add <name...>` | Add one or more authors (repeatable) |
| `--remove <name>` | Remove an author |
| `--list` | List the configured authors |
| no option | Interactive multiselect from git history |

#### `configure-workitem-patterns` (alias `patterns`)

The regular expressions that pull work item ids (`DEV-1234`, `#12345`) out of commit messages and branch names.

```bash
tools git configure-workitem-patterns --list
tools git configure-workitem-patterns --suggest --repo ~/Projects/app
tools git configure-workitem-patterns --add 'ABC-(\d+)'
tools git configure-workitem-patterns --remove 0
```

| Option | Description |
|---|---|
| `--list` | List the patterns, with the index `--remove` takes (it starts at 0) |
| `--add <regex>` | Add a pattern that reads commit messages |
| `--remove <index>` | Remove a pattern by its index |
| `--suggest` | Scan the history and offer patterns with their match counts (needs a terminal) |
| `--repo <path>` | Repository for `--suggest` (default: the current directory) |
| no option | Interactive: add (from the commit message, the branch name or both), remove, suggest |

With no saved pattern the tool uses three built-in ones: `\b[A-Z]{2,10}-(\d+)\b` on commit messages, `#(\d{5,6})` on
commit messages, and `\b[A-Z]{2,10}-(\d+)\b` on branch names. Once you save one pattern, the saved list replaces
the built-in ones completely, so add every pattern you still want. `--list` shows the built-in list with indices 0
to 2 while nothing is saved, but `--remove` removes only saved patterns, so those indices cannot be removed: save
your own list first.

`--suggest` reads the last 200 commit subjects of every ref (`git log --all -200`) and the local branch names, then
asks in a multiselect which of the found patterns to add.

A pattern must have a capture group, and the group must capture the number. `--add` stores the pattern with capture
group 1 and the commit message as its source. Tighten a pattern for your own projects (for example
`ABC-(\d{5,6})` in place of `[A-Z]{2,10}-(\d+)`) here or in the config file. The built-in patterns stay loose on
purpose, because other projects use other id formats.

#### `changes`

What did I touch, and when? It lists the uncommitted files, newest first, grouped by how long ago each was modified
(`Last hour`, `Last 3 hours`, `Today`, `Yesterday`, `Last N days`, `Older`). Each row shows the status, the path, and
the relative and absolute time. It only reads: nothing is staged or written.

```bash
tools git changes                       # uncommitted files grouped by modification time
tools git changes --commits 5           # the files of the last 5 commits, grouped by commit time
tools git changes -C ~/Projects/app     # another repository
```

| Option | Description |
|---|---|
| `-c, --commits <n>` | The files of the last N commits instead; each file gets its commit's committer time |
| `-C, --cwd <path>` | Repository path |

Status colors: yellow for modified, green for added, red for deleted, blue for renamed, cyan for copied, gray for
untracked. A deleted file has no modification time, so it counts as modified now. An untracked folder is listed file
by file. A rename is listed under its new path. In `--commits` mode a merge commit lists nothing of its own: its files
appear under the commits it brought in. The status comes from the typed `git status --porcelain=v2 -z` reader in
`src/utils/git/`, and paths are relative to the repository root, so the command works from any subfolder.

### Branch state

#### `merged`

Is a branch or worktree already in the base? The verdict is by content, not by sha: squash, rebase and recompose all
fool `git branch -d`, `merge-base --is-ancestor`, `git cherry` and `git diff --stat`.

```bash
tools git merged feat/x            # one ref: a branch name or a worktree path
tools git merged --all             # every local branch and detached worktree
tools git merged --all --pr        # also check each PR or MR; a stacked child is judged against its PR target

# remove only the named refs, each checked again, with one confirmation
tools git merged --prune feat/x --prune .worktrees/feat-y
```

| Verdict | How | Meaning |
|---|---|---|
| `EMPTY` | `-` | The tip is the base tip itself |
| `MERGED` | `ancestor` | A plain merge or a fast-forward |
| `MERGED` | `cherry` | Rebased or cherry-picked: every patch-id is upstream |
| `MERGED` | `content` | Squashed, recomposed or a snapshot (see below) |
| `STALE` | `superseded` | An older draft of work that moved on (see below) |
| `UNMERGED` | `none` | The listed files hold content the base never had |

`content` means every touched file's final blob exists in the base's history since the fork. `superseded` means
nothing of the branch landed as is, but the base itself rewrote every file the branch touches. `UNMERGED` also needs
at least one listed path that the base never touched again after the fork.

| Option | Description |
|---|---|
| `[refs...]` | Branch names or worktree paths |
| `--all` | Every local branch except the base, `master` and `main`, plus every detached worktree |
| `-b, --base <ref>` | Base to judge against (default: config `mainPrBranch`, else origin HEAD) |
| `--pr` | Look up each branch's PR or MR (network, through `gh` or `glab`) |
| `--json` | The report as JSON. Without `--prune` only: with `--prune` it is ignored and the prune runs |
| `--prune <ref>` | Remove this ref (repeatable). There is no "prune everything": name what a plain run listed |
| `--remote` | With `--prune`: also delete `origin/<branch>` when it is safe (see below) |
| `--yes` | With `--prune`: skip the confirmation (a run without a terminal needs it) |
| `-d, --stale-days <n>` | Flag branches with no commit newer than this many days (default 90) |
| `-C, --cwd <path>` | Repository path |

`--remote` deletes `origin/<branch>` only when it is the branch's upstream, no PR is open, and the branch's push
policy allows it.

`--json` does not make a prune safe. The `--help` text says it never deletes, but that holds for a plain run only:
`merged --prune feat/x --json --yes` deletes the ref and prints text.

`--prune` refuses UNMERGED refs, dirty worktrees, the current branch, the base and the main checkout. An unpushed
MERGED branch is a warning, because the remote holds an older copy. Exit 0 when every ref is MERGED or EMPTY and
clean, 1 otherwise, 2 on a usage error, a base it cannot find, or `--prune` without `--yes` and without a terminal.

A STALE ref is an older draft of work that moved on: a pre-review snapshot of a squash-merged PR, a `backup/*` branch
cut before a rebase, an agent scratch branch. STALE refs get their own section and are never folded into the "safe
to remove" line, because whether an older draft is worth keeping is your call. So `--prune` has to name each one.
They do not fail the exit code.

`--prune origin/<branch>` deletes a remote-only branch, for when the local copy is already gone (`--remote` alone
cannot reach it: that flag only follows a local branch to its upstream). It needs `--remote` explicitly. Every gate
that only drops the remote step for a local branch refuses the whole ref here, because there is nothing else to
delete: an open PR, a failed PR lookup (pass `--pr` so the lookup runs at all), a `push: never` policy, or the base
branch itself. The success line prints `git push origin <sha>:refs/heads/<branch>`. Keep it: it is the only way back,
because a deleted remote branch has no reflog.

#### `base`

Prints the base branch of a branch (default: the current one) and the rule that chose it.

```bash
tools git base                   # the current branch
tools git base feat/x --offline  # skip the PR lookup
tools git base feat/x --json
```

| Option | Description |
|---|---|
| `-b, --base <ref>` | Check this ref and return it instead of detecting |
| `--offline` | Skip the PR or MR lookup |
| `--json` | Print as JSON |
| `-C, --cwd <path>` | Repository path |

The rules, in order: `--base`, the branch's open PR or MR target, config `mainPrBranch`, the closest declared branch
of the config, then an inference (the closest merge-base, then origin HEAD, then a local `master` or `main`). An
inferred base is a guess: confirm it before a rebase, a cascade or a prune depends on it. Exit 2 when `--base` does
not resolve or no rule finds a base.

### Moving and reshaping branches

#### `rebase-cascade`

Rebase a parent branch onto its target and transplant every child stacked on it. Children are detected by
merge-base (a child carries parent-only commits the target lacks). Fork points are saved before the parent moves. A
child checked out in another worktree is rebased there. Every branch gets a backup ref
(`refs/backup/cascade/<branch>`) and a tag (`bkp/cascade/<branch>-<timestamp>`) first, and nothing is pushed.

```bash
tools git rebase-cascade feat/parent --dry-run                       # the plan; nothing moves
tools git rebase-cascade feat/parent --onto origin/master --child feat/c1
tools git rebase-cascade --status                                    # the plan in progress and its backups
tools git rebase-cascade --continue                                  # after you resolved a conflict
tools git rebase-cascade --abort                                     # every touched branch back to its backup
```

| Option | Description |
|---|---|
| `[parent]` | The parent branch to rebase |
| `--onto <target>` | Target ref (default: the parent's PR target, else config `mainPrBranch`) |
| `--child <branch>` | Name the children yourself instead of detecting them (repeatable) |
| `--dry-run` | Print the plan and move nothing |
| `--yes` | Skip the single confirmation (a run without a terminal needs it) |
| `--offline` | Skip the PR or MR lookup for the target |
| `--continue` | Carry on after a resolved conflict |
| `--status` | Show the plan in progress and the backups; warns when the target moved |
| `--abort` | Reset every touched branch to its backup and clear the plan |
| `--restore <branch>` | Reset one branch to its backup |
| `--cleanup` | Delete the backup refs, tags and the plan file (refuses a cascade in progress unless `--yes`) |
| `-C, --cwd <path>` | Run from this checkout |

The parent's route comes from the `merged` engine: `rebase` (plain), `merged` (already upstream, so the children go
straight onto the target) or `oracle` (recomposed upstream: the tool prints the net conflicts and stops for the
oracle merge, then you run `--continue`). A conflict leaves that branch's rebase in progress. Resolve it, run
`git rebase --continue`, then `tools git rebase-cascade --continue`. When the cascade is done it prints the push lines
and runs none of them.

It refuses to start with uncommitted changes in the checkout, a dirty child worktree, or a cascade already in
progress. A target it had to infer gets a warning: pass `--onto` to pin it. The plan file is
`<git-common-dir>/genesis-cascade.json`, so every worktree of the clone sees it. Exit 0 on success, 1 on a refusal
or a conflict, 2 when the parent is missing, the base cannot be found, or `--yes` is missing without a terminal.

#### `rebranch`

Split a messy branch into several clean ones. There are two ways in.

**Interactive** (`tools git rebranch`, the same as `tools git rebranch interactive`, needs a terminal). It finds the
fork point, groups the commits by conventional-commit scope or ticket id (`feat(login, PROJ-123): ...`), lets you
refine each group in a searchable multiselect, names the branches, and cherry-picks each group from the fork point.
`--dry-run` prints the plan and creates nothing. Commits that conflict are skipped with a warning. Without a terminal
it exits 2 and points to `plan`.

```bash
tools git rebranch --dry-run     # the plan only
tools git rebranch               # run it
tools git -v rebranch            # and print every git command
```

**By path groups** (no prompts, for agents and scripts): `plan`, then `apply`, then `verify`. This is the flow of the
`gt:git` skill (`references/recompose-branches.md`) as code. Nothing is ever pushed.

```bash
tools git rebranch plan --groups 'api=src/api/**' --groups 'web=src/web/**,docs/web' --base origin/master
tools git rebranch plan \
    --groups 'api=src/api/**' \
    --groups 'web=src/web/**,docs/web' \
    --base origin/master \
    --json > plan.json
# edit plan.json: a decision on every MIXED commit; each commit in no group goes into a group or under skip
tools git rebranch apply --plan plan.json --dry-run    # the exact git commands; nothing written
tools git rebranch apply --plan plan.json --yes        # build the branches, then verify
tools git rebranch verify --plan plan.json             # the proof alone, on existing branches
```

| Subcommand and option | Description |
|---|---|
| `plan -g, --groups <name=paths>` | A group: `name=pattern,pattern` (repeatable) |
| `plan -s, --source <branch>` | Branch to split (default: the current one) |
| `plan -b, --base <ref>` | Base ref (default: what `tools git base` detects) |
| `plan --json` | Print the plan file instead of the table |
| `plan --offline` | Skip the PR or MR lookup for the base |
| `apply -p, --plan <file>` | The plan file, or `-` for stdin |
| `apply --dry-run` | Print the exact git commands and write nothing |
| `apply --yes` | Skip the single confirmation |
| `apply --continue` | Carry on after a cherry-pick conflict was resolved |
| `apply --abort` | Remove every branch this run created (tagged first) and return to the start |
| `verify -p, --plan <file>` | The plan file, or `-` for stdin |
| `verify --json` | Print the report as JSON |

All three take `-C, --cwd <path>`.

`plan` is read-only. It detects the base with the same rules as `tools git base`, lists the source's commits since
the merge-base, and classifies each one per group: **IN** (every changed path matches), **OUTSIDE** (none does) or
**MIXED** (both). Paths are listed with rename detection off, so a move counts with its old and its new name. It also
lists the commits in no group and the commits in several groups. A merge commit in the range stops it: make the
source linear first. A pattern with `*` uses the repository's glob matcher (`*` also crosses `/`, and matching ignores
case). A pattern without `*` names a file or a folder and matches everything below it.

`apply` refuses to start with uncommitted or untracked changes, a rebase or cherry-pick in progress, a locked index,
a group branch name that already exists, or a MIXED commit without a decision. Per group it runs
`git switch -c <branch> --no-track <base>` and `git cherry-pick -x` for each commit in source order. A `paths-only`
commit is picked whole first. Then the paths outside the group are printed, put back from the branch tip before that
pick (`git restore --source=<tip> --staged --worktree`), and the commit is amended (`--no-verify`, so no hook
rewrites it). Restoring from the pre-pick tip rather than the base keeps what an earlier pick on the same branch did
to those paths. If the restore or the amend fails, `--continue` finishes that cleanup instead of picking the commit
again. It refuses while the checkout holds a change the cleanup did not make (an edit to a path outside the group, an
unrelated staged file), because the restore would overwrite it and the amend would commit it. At the end it switches
back to the starting branch, runs the verification, and prints the `git push` and `gh pr create` lines, which it never
runs. The source branch is never moved.

One rebranch operation runs per repository. `apply`, `--continue` and `--abort` hold
`<git-common-dir>/genesis-rebranch.lock` until they end, and a second run from any worktree is refused at once. A
killed run leaves a lock that the next run takes over. A conflict stops the run and keeps its state in
`<git-common-dir>/genesis-rebranch.json`. Resolve it, `git add`, `git cherry-pick --continue` (or `--skip` to leave
that commit out), then `tools git rebranch apply --continue`.

`apply --abort` stops the cherry-pick, returns to the starting branch, and removes every branch this run created.
Each one is first tagged `bkp/rebranch/<branch>-<stamp>` (each `/` of the branch name becomes `-`), and the command
prints the `git branch <name> <tag>` line that brings it back. When the final verification fails the state is kept
too. Then fix the branches and run `--continue` to prove the split again, run `--abort` to remove them, or start
another `apply`, which replaces the record and leaves those branches in place.

`verify` is the proof, as code. For every path the source changed since the merge-base, it finds the last source
commit that touched it and the groups that carry that change (`whole`, or `paths-only` with the path inside the
group). One of those group branches must hold the source's final entry: the same mode and blob, or no file at all
after a deletion. When the base moved after the fork, the expected entry comes from the source merged onto the base
(`git merge-tree`). A path that merge conflicts on is reported as unverified. It exits 1 and names the path when an
entry differs, when the last change of a path is in no group (lost), or when a group branch changes a path the source
never touched (extra). A path whose last change was left out on purpose (`skip`, `paths-only`, or the top-level skip
list) is reported as dropped and does not fail the check. Paths changed by commits in two groups are reported as
shared.

The plan file. `plan --json` prints a complete one, and `apply` and `verify` read it from a path or from `-`:

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

The rules of the plan file:

- `commits[].sha`: 7 to 64 hex characters, a unique prefix of a commit of `source` since the merge-base.
- `commits[].decision`: `whole`, `skip` or `paths-only`. It is required for a MIXED commit; an IN or OUTSIDE commit
  defaults to `whole`. `paths-only` on a commit with no path in the group is refused.
- Commit order: commits are picked in source order whatever the list order, and `apply` says when it reordered.
- Other keys (`subject`, `class`, `outsidePaths`, `baseSource`, `commits`, `unassigned`, `shared`) are information
  from `plan` and are ignored on read.

Exit codes:

- `plan`: 0; 1 on merges or an empty range; 2 with no `--groups`, on a detached HEAD without `--source`, or when no
  base is found.
- `apply`: 0 when the branches are built and verified; 1 on a refusal, a conflict, a failure or a failed proof; 2 on
  missing arguments, on `--dry-run` with `--continue` or `--abort` (those always act, so a preview of them would lie),
  on `--continue` with `--abort`, or on no `--yes` without a terminal.
- `verify`: 0 or 1; 2 without `--plan`.
- `interactive`: 2 without a terminal.

#### `rename-commits`

An interactive reword of the last N commits. It shows each commit with a suggested message, collects the new
messages, shows an OLD and NEW confirmation screen, and then rewrites history with a rebase.

```bash
tools git rename-commits --commits 3
tools git rename-commits -c 5 --force
```

| Option | Description |
|---|---|
| `-c, --commits <n>` | How many commits to rename (without it, it shows the last 50 and asks) |
| `-f, --force` | Skip the safety check (only when the commits are backed up) |

Two placeholders work in a new message. `<suggested>` becomes the suggested message without its `type(scope):`
prefix, and `<original>` becomes the old message, so `feat(login): <suggested>` keeps your own type and scope. The
suggestions use the scope most of the listed commits carry. When none carries one, it asks for the scope first.

The safety check refuses (exit 1) unless the current commit is pushed to its upstream, or the branch diverged from it
with the same files (the usual state after a rebase). The pushed copy is your backup. After the rewrite it compares
HEAD with the upstream and warns when a file differs, because only the messages should have changed. A stale git
lock file is removed before the rebase. It rewrites history, so back the branch up first. To reshape commits from an
agent, use the recommit script of the `gt:git` skill instead.

### Repository setup

#### `config`

The per-repository `genesis-tools.config.json`: the main PR branch, a push policy per branch, and the worktree policy
(see Configuration for every key).

```bash
tools git config show            # the effective file, its path, and what each local branch matches
tools git config show --json
tools git config init            # infer the main branch, print the proposed file, write it after a yes
tools git config check           # validate; exit 1 naming the bad entry
```

| Subcommand and option | Description |
|---|---|
| `show --json` | Print as JSON |
| `init --yes` | Write without asking (also overwrites an existing local copy) |
| `check` | Validate the file |

All three take `-C, --cwd <path>`.

`init` infers the main branch from origin's HEAD, then from `git remote show origin` (a network call with a 15 s
timeout, made only when origin/HEAD is not set), then from a local `master` or `main`. It exits 1 when none of the
three gives a branch. It proposes `mainPrBranch` with a `confirm` entry for that branch and a `catchAll` entry with
`push: allowed`, and writes it to `<git-common-dir>/genesis-tools.config.json`. If your PRs target another branch
(a `feature/next` UAT branch, say), edit `mainPrBranch` after it writes. When a config already exists, `init` stops
(exit 1) unless you pass `--yes`. Without a terminal it needs `--yes` (exit 2).

`check` validates: the file parses as a JSON object, `git.mainPrBranch` is a non-empty string, `git.branches` is an
array, exactly one of `name`, `nameRegex`, `catchAll: true` per entry, `catchAll` last, a `nameRegex` that compiles,
`push` in `confirm | never | allowed`, `deployDriver` in `jenkins | github | gitlab`, `autoDeploys` a boolean,
`environment` a string, and the types of the `worktrees` keys. No file is not an error: it prints "nothing to check"
and exits 0.

`show` lists the same problems and exits 1 when the file has any. Without `mainPrBranch` in the file it infers one
the way `init` does, so it too can run `git remote show origin` when origin/HEAD is not set.

#### `worktree`

Where new worktrees go and what runs in them, for this repository. The policy is the `git.worktrees` section of the
repository config.

```bash
tools git worktree config                                    # guided setup (needs a terminal)
tools git worktree config --json                             # the current policy and the presets; writes nothing
tools git worktree init --branch feat/login                  # create or find the worktree of an existing branch
tools git worktree init --branch feat/login --create --base origin/master
tools git worktree sync-plans                                # copy this worktree's .claude/plans to the main checkout
```

| Subcommand and option | Description |
|---|---|
| `config --json` | Print the current policy and the presets; write nothing |
| `init --branch <name>` | Branch to check out (default: the current branch) |
| `init --create` | Create the branch as well |
| `init --base <ref>` | Start point for `--create` (default: `HEAD`) |
| `init --hook` | Internal: the post-checkout hook calls it inside a new worktree |
| `sync-plans --json` | Print what was copied |
| `sync-plans --hook` | Internal: the post-commit hook calls it |

All three take `--cwd <path>` (run as if in this folder). Note the long form only: there is no `-C` here.

`config` asks three questions and shows the real path each answer produces for a sample branch `feat/login`:

- `base`: `.claude/worktrees` (the default, where Claude Code puts its own worktrees), `.worktrees`, or `../` (beside
  the checkout). A relative path resolves against the main checkout's root.
- `install`: a command to run inside a new worktree (default `bun install`; empty to skip).
- `plansSync`: copy `.claude/plans` back to the main checkout after each commit in a worktree (default yes).

It writes the local file `<git-common-dir>/genesis-tools.config.json`. It refuses when the repository has a versioned
`.claude/genesis-tools.config.json`, because that file shadows the local one: edit the versioned file instead. It
also refuses to write over a local file that does not parse. Without a terminal it prints the section to write by
hand and exits 1.

`init` puts the worktree at `<base>/<branch>`, with every `/` of the branch name written as `-`
(`feat/login` becomes `feat-login`). An existing folder there is reported, not replaced. Either way it prints one
JSON line on stdout, `{"path": …, "branch": …, "created": true|false}`. Without a configured `base`
it refuses (exit 1) and names `tools git worktree config`: it never guesses, because a wrong base folder scatters
worktrees across the disk and moving one afterwards means rewriting its gitdir pointer.

The `install` command and the plan copy run from git hooks, not from `init` itself:

- The post-checkout hook runs `tools git worktree init --hook` the first time a new linked worktree is checked out,
  whoever created it (`git worktree add`, Claude Code, Codex, a person). That runs `install` inside it. A failed
  install leaves the worktree usable and prints a warning.
- The post-commit hook runs `tools git worktree sync-plans --hook` in a linked worktree. It copies only when
  `plansSync` is `true`. A direct `sync-plans` call always copies.

GenesisTools carries both hooks in `.githooks/`. Another repository needs its own `post-checkout` and `post-commit`
hooks that run these two commands; without them `init` creates the worktree but runs no install.

##### `worktree backup`

Saves everything a linked worktree holds that its repository does not, proves that the copy restores it, and with
`--remove` removes the worktree. It works on a worktree of any repository, not only this one.

```bash
tools git worktree backup /tmp/cc/shop/<session>/worktrees/fix-x --dry-run     # the plan and the blockers; writes nothing
tools git worktree backup /tmp/cc/shop/<session>/worktrees/fix-x                # back up and prove; the worktree stays
tools git worktree backup /tmp/cc/shop/<session>/worktrees/fix-x --remove --note "checkout fix spike"
```

| Option | Description |
|---|---|
| `--dry-run` | Print the plan and the blockers; write nothing (every git read runs with `--no-optional-locks`) |
| `--remove` | Remove the worktree once the proof passed and nothing changed during the backup |
| `--note <text>` | What the work was, written into the README |
| `--max-copy-mb <n>` | Refuse when the untracked and ignored files to copy exceed this many MiB, a plain decimal number (default 512) |
| `--json` | The plan (with `--dry-run`) or the result as JSON on stdout |

The backup goes to `~/.genesis-tools/backups/worktrees/<YYYY-MM-DD>-<repo>-<worktree>/` (`-2`, `-3`, ... when the name
is taken):

- `commits/`: one `git format-patch` file per commit in `<base>..HEAD`. The base is the merge base with the branch's
  upstream when it has one. Without an upstream, it compares two candidates, `origin/HEAD` and the branch the main
  checkout has out (unless that is this worktree's own branch), and takes the merge base that leaves the fewest
  commits in `<base>..HEAD`. So a worktree cut from a feature branch gets its own commits, not the whole feature
  branch. When neither gives a merge base (a bare clone has no `origin/HEAD` and no main-checkout branch), the base
  is the one commit where the commits that no other branch, remote branch or tag holds start. Without any base the
  backup has no commit patches and `--remove` refuses. Merge commits are skipped and counted.
- `uncommitted-on-<short HEAD>.patch`: `git diff HEAD --binary`, the working copy of every changed tracked file.
- `staged-on-<short HEAD>.patch`: `git diff --cached HEAD --binary`, the index, when it differs from HEAD. It is a
  separate patch because a staged version can differ from the working copy (a partly staged file, or a file staged
  and then changed back).
- `untracked/` and `ignored/`: the files with their paths, mode and mtime (an APFS clone, so no extra space on the
  same volume). Ignored entries that a tool rebuilds (`node_modules`, `dist`, `.next`, `target`, `*.log`, ...) are
  skipped; sockets and fifos are listed, not copied.
- `README.md` with the restore commands, and `backup.json` with the full result.
- When HEAD holds commits that no branch, remote branch or tag holds, the ref
  `refs/backups/worktrees/<folder name>` keeps them alive in the repository. It is never moved: when that name is
  taken (a same-day backup in another backup root), the new ref gets `-2`, `-3`, ...

The proof runs in a scratch repository that borrows the source's objects: `git apply --cached --check` of the
uncommitted patch on HEAD's tree, and `git am` of the commit patches on the base, whose tree must equal HEAD's tree
when the range has no merge commits. `--remove` then reads the worktree's fingerprint again (HEAD, the diff, the
untracked and ignored files with size and mtime) and refuses when anything changed. It runs
`git worktree remove --force` once, so a locked worktree stays refused. The branch stays in the repository.

It refuses before writing anything when a merge, rebase, cherry-pick, revert or bisect is in progress, when the worktree
has initialized submodules, when the index has unmerged entries, when the copy exceeds the limit, or when another
worktree lives inside the folder. It also refuses when `assume-unchanged` or `skip-worktree` hides an edit, a deletion
or an executable-bit change of a tracked file from `git diff` (no patch would hold it; the bytes are compared without
clean filters, which a read-only plan never starts, so a filtered file counts as changed), and when the backup root lies
inside the worktree (symlinks resolved), because a removal would delete the backup too. With `--remove` it also refuses
a locked worktree, one where a process has its working directory, and one with no base. Exit 0 when the backup did what
was asked; exit 2 when the backup is written and proven but `--remove` kept the worktree (it changed, or a process
started in it, during the backup), so the backup is usable; exit 1 on any other refusal.

Code that needs the same backup calls `planWorktreeBackup` and `backupWorktree` from `@genesiscz/utils/git`.

`sync-plans` exists because `.claude/plans/` is usually gitignored and `git worktree remove` deletes it without a
warning, and git has no hook for worktree removal. It never overwrites: a plan already in the main checkout wins, and
symbolic links are skipped.

#### `fsmonitor`

git's file system monitor, on in the global git config, with every worktree it ran in recorded so that turning it
off cleans all of them.

```bash
tools git fsmonitor status
tools git fsmonitor enable
tools git fsmonitor disable --keep-cache
```

- `status [--json]`: the two global values, every running `git fsmonitor--daemon` with its worktree, memory and CPU,
  and every recorded worktree. Changes nothing.
- `record [--json]`: adds every worktree a daemon watches to `~/.genesis-tools/git/fsmonitor.json`. The
  `git-fsmonitor-record` daemon task runs it every 10 minutes.
- `enable`: saves the current global `core.fsmonitor` and `core.untrackedCache`, sets both to `true`, registers the
  record task, and records the running daemons. Safe to run twice: the saved values are kept.
- `disable [--keep-cache] [--json]`: puts the saved global values back first. Then it stops the daemon of every
  recorded or running worktree, removes the untracked cache from each index (unless `--keep-cache`, or the cache was
  on before), and removes the task. A worktree that fails stays on the list. It exits 1 when a worktree step fails
  or a daemon's worktree cannot be identified; run it again to retry.
- Without a saved `enable` (the monitor was turned on by hand, or is already off) `disable` changes nothing: it
  restores no value, stops no daemon and removes no cache. Set `core.fsmonitor` back with `git config --global`
  yourself.

How it behaves, measured 2026-10-12 (git 2.55, medians of 9 interleaved runs, load average about 25):

- One `git status` in five real repositories (3,065 to 12,213 tracked files): 22 to 279 ms of CPU with the default
  settings, 6 to 15 ms with the monitor on. The output is the same byte for byte. On a 9,278-file clone a status cost
  8.6 to 9.3 ms of CPU, against 49 ms without the monitor and the untracked cache.
- git starts one daemon per worktree on the first status there. Each uses about 8 MB of memory and close to no CPU
  while nothing changes. A daemon exits within a second when its worktree folder is moved or deleted, so the
  throwaway repositories that tests create do not leave daemons behind. `git worktree remove` works while a daemon
  runs.
- One agent-hook Bash call (the before and after hook processes with their git children) went from 205 to 113 ms of
  CPU for an editing command, and from 190 to 90 ms for a read-only one, with the same files rendered. The five
  daemons used 100 ms of CPU together in 10 minutes.
- A daemon's working folder is the home folder. The tool finds its worktree from its open folder handles (it opens
  the worktree folder first, then each folder above it); a main checkout's socket path is the fallback. A linked
  worktree binds its socket by the bare name `fsmonitor--daemon.ipc`, which names nothing.

Two known problems are under Troubleshooting: the daemon crash on shutdown and the socket that breaks folder copies.

### Code health: `health` and `monster`

Both score every source file of a folder and rank them. `health` prints a plain table; `monster` draws the scariest
file as an ASCII monster that tells you its size and age, so you can shrink it by deleting cruft. They read the same
data.

```bash
tools git health                 # the top 5 files of the current folder
tools git health src --top 10
tools git monster src --top 10
tools git health src --json
```

| Option | Description |
|---|---|
| `[dir]` | Folder to analyze (default: `.`) |
| `-t, --top <n>` | How many files the leaderboard shows (default 5) |
| `--json` | The report as JSON (`monster` draws no art) |

The score of a file is `3 × ln(1 + lines) + 0.15 × days since its last commit + 2 × (imports in + imports out)`.
A score of 15 makes an imp, 40 an ogre and 80 a kraken; below 15 it is a slime. The repository monster size is the
sum of every file's score.

- Files: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cts`, `.mts`. It walks the folder itself, not git's file list, so it
  skips `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, every folder whose name starts with a dot, and
  symbolic links, but not other ignored or generated files.
- Imports: only relative imports (`./x`, `../y`) that resolve to a scanned file count. Path aliases and packages do
  not.
- Age: one `git log` gives each file's last commit. A file that was never committed has age 0. In a folder outside
  git every age is 0, and the monster leaves the age out of what it says.
- `--top` must be a positive whole number, or the command exits 1.

## How it works

- **git.** Every command runs `git` in the repository. The branch commands read through the typed readers in
  `src/utils/git/`.
- **PR and MR lookups.** `merged --pr`, `merged --prune --remote`, `base`, `rebase-cascade` and `rebranch plan` ask
  the origin's host for the branch's PR or MR through the `gh` (GitHub) or `glab` (GitLab) CLI. That is a network
  call; `--offline` skips it where offered. The origin must be `github.com` (or a host that ends in `.github.com`)
  for `gh`, or a host that contains `gitlab` for `glab`. For any other host (a GitHub Enterprise server, say) the
  lookup is off: `merged` warns, and the other commands go on without it (a debug log line only).
- **`git remote show origin`.** `config init`, and `config show` when the file has no `mainPrBranch`, run it (a
  network call with a 15 s timeout) when origin/HEAD is not set.
- **Azure DevOps.** `commits --with-workitem-title` reads titles through `tools azure-devops`: its cache first, then
  its API.
- **The GenesisTools daemon.** `fsmonitor enable` registers the `git-fsmonitor-record` task with `tools daemon`;
  `disable` removes it.
- **Writes.** These commands change a repository: `rebase-cascade`, `rebranch` (interactive and `apply`),
  `rename-commits`, `merged --prune`, `worktree init` and `worktree sync-plans`. These write config:
  `configure-authors`, `configure-workitem-patterns`, `config init`, `worktree config`, and `fsmonitor enable|disable`
  (the global git config). Nothing pushes, except that `merged --prune --remote` deletes a remote branch. The other
  commands print the push commands and run none.
- **Cost.** Nothing costs money.

Where data lives:

| Path | What |
|---|---|
| `~/.genesis-tools/git/config.json` | Your authors, work item patterns and trunk list |
| `~/.genesis-tools/git/fsmonitor.json` | The saved global values and every recorded worktree |
| `<repo>/.claude/genesis-tools.config.json` | The versioned repository config (read first) |
| `<git-common-dir>/genesis-tools.config.json` | The local repository config, shared by every worktree |
| `<git-common-dir>/genesis-cascade.json` | A cascade in progress |
| `<git-common-dir>/genesis-rebranch.json`, `.lock` | A rebranch run in progress, and its lock |
| `refs/backup/cascade/*`, tags `bkp/cascade/*`, `bkp/rebranch/*` | Backups before a move |
| `~/.genesis-tools/logs/<today>.log` | Debug logs and per-phase timings |

`GENESIS_TOOLS_HOME` replaces the home folder for these paths: the data then lives in
`$GENESIS_TOOLS_HOME/.genesis-tools/`.

## Configuration

### Your settings: `~/.genesis-tools/git/config.json`

`configure-authors` and `configure-workitem-patterns` write it. You can also edit it by hand:

```json
{
  "authors": ["Alice Example", "alice@example.com"],
  "workitemPatterns": [
    { "regex": "ABC-(\\d{5,6})", "source": "commit-message", "captureGroup": 1, "description": "ABC ticket" }
  ],
  "branchAttribution": {
    "excludeTrunks": ["develop", "main", "master"]
  }
}
```

| Key | Meaning |
|---|---|
| `authors` | Authors `commits` uses without `--author` |
| `workitemPatterns[]` | Your patterns; a non-empty list replaces the three built-in ones |
| `branchAttribution.excludeTrunks` | Trunk names; optional, default `develop`, `main`, `master` |

A pattern has `regex`, `source` (`commit-message`, `branch-name` or `both`), `captureGroup` and an optional
`description`. Trunk names that match (also as `origin/<name>`) are skipped when a commit's branch is chosen, unless
no other branch holds the commit. Then the trunk shows as `[trunk: <name>]`.

### The repository: `genesis-tools.config.json`

One file per repository, shared by every tool (the file name is not git-specific). It is read from
`<repo>/.claude/genesis-tools.config.json` first, which is versioned when the repository tracks `.claude/`. Then it
is read from `<git-common-dir>/genesis-tools.config.json`, which is local, never versioned, and shared by every
worktree of the clone. The first file found wins; the two are not merged.

```jsonc
{
  "git": {
    "mainPrBranch": "feature/next",
    "branches": [
      { "name": "master", "push": "confirm", "environment": "prod" },
      { "nameRegex": "^release/", "push": "never" },
      { "catchAll": true, "push": "allowed" }
    ],
    "worktrees": { "base": ".claude/worktrees", "install": "bun install", "plansSync": true }
  }
}
```

| Key | Meaning |
|---|---|
| `git.mainPrBranch` | Default PR or MR target, cascade target, and base of `merged` |
| `git.branches[]` | Branch entries, matched top-down; the first match wins |
| `git.branches[].push` | `confirm` (default), `never` or `allowed` |
| `git.branches[].environment` | Data for later versions: what a merge deploys to |
| `git.branches[].autoDeploys` | Data for later versions (a boolean) |
| `git.branches[].deployDriver` | Data for later versions: `jenkins`, `github` or `gitlab` |
| `git.worktrees.base` | Folder for new worktrees; without it `worktree init` refuses |
| `git.worktrees.install` | Command run inside a new worktree; leave it out to skip |
| `git.worktrees.plansSync` | `true` copies `.claude/plans` to the main checkout after each commit |

Each branch entry has exactly one of `name`, `nameRegex` (a JavaScript regular expression) or `catchAll: true`, and
a `catchAll` entry must be the last one. `confirm` asks every time, `never` refuses and prints the command, and
`allowed` never asks. A relative `worktrees.base` resolves against the main checkout's root.

Without a file the commands infer a base (the PR target, then the closest merge-base, then origin HEAD) and say so.
They never silently assume `master`.

## For agents

- **JSON output:** `commits --format json` (`from`, `to`, `authors`, `commits[]`, `rebasedCommits[]`,
  `workitemSummary`), `merged --json`, `base --json`, `config show --json`, `rebranch plan --json` (a complete plan
  file), `rebranch verify --json`, `worktree config --json`, `worktree sync-plans --json`,
  `fsmonitor status|record|disable --json`, `health --json` and `monster --json`. `worktree init` always prints one
  `{path, branch, created}` line.
- **Warning:** `merged --json` is a report only without `--prune`. With `--prune` the flag is ignored, the named
  refs are deleted and the output is text. Never add `--json` to make a prune safe.
- **No terminal:** `merged --prune`, `rebase-cascade`, `config init` and `rebranch apply` need `--yes`, or they exit
  2 and print the command with `--yes`. Run a plain or `--dry-run` command first and read it, then pass `--yes`.
  Interactive `rebranch` exits 2; use `plan`, `apply` and `verify`. `worktree config` exits 1 and prints the section
  to write. `rename-commits`, the bare `configure-*` commands and `patterns --suggest` are for a person.
- **Exit codes:** 0 is success. 1 is a refusal, a conflict, a failed proof or an UNMERGED ref. 2 is a usage error
  that the command finds itself (a missing `--plan`, no refs, a missing `--yes` without a terminal) or a base that
  cannot be found. A flag that the argument parser rejects (an unknown option, a missing `--from`, an option without
  its value) exits 1. Each command's section has the details.
- **A check never mutates.** `merged` without `--prune`, `base`, `changes`, `health`, `monster`, `config show|check`,
  `rebranch plan|verify`, `fsmonitor status` and every `--dry-run` change no branch and no config. (A cascade dry run
  that previews an oracle merge can write one unreachable tree object.)
- **The skill:** `gt:git` (`plugins/genesis-tools/skills/git/SKILL.md`) picks the reference for each job: merged and
  cleanup, rebase one branch or a fleet, the oracle merge, cascade, recommit, recompose a branch, and merge a PR.
  `/gt:git-recommit` and `/gt:git-recompose-branches` start two of them. `/gt:timelog` reads
  `tools git commits`, `authors` and `patterns`.
- In a GenesisTools worktree run `./tools git …` from the worktree root to run that worktree's code; `tools` on PATH
  runs the main checkout.

## Troubleshooting

- **`commits` shows every author.** No author is configured. Run `tools git configure-authors --add "<name>"`, or
  pass `--author`.
- **`commits` finds no work item ids, or the wrong ones.** Check `tools git patterns --list`. A saved list replaces
  the built-in patterns, so one `--add` can switch off the defaults you relied on. Run `--suggest` to see what your
  history matches.
- **No work item titles.** `--with-workitem-title` needs a `tools azure-devops` configuration. Without one the titles
  are skipped silently; run with `-v` to see the debug line.
- **`commits --with-workitem-title` fails with an Azure DevOps auth error.** The configuration exists, but the Azure
  CLI session expired or fails, and that fails the whole run. Sign in again with `az login`, or run without
  `--with-workitem-title`.
- **A commit time looks wrong and has `(?)`.** A rebase or amend reset its author date. Try `--date true-first` or
  `--date commit`.
- **`worktree init` says `git.worktrees` is not configured.** Run `tools git worktree config` in a terminal, or write
  the `git.worktrees` section by hand.
- **`worktree init` created the worktree but nothing was installed.** The install runs from the post-checkout hook.
  The repository needs a hook that runs `tools git worktree init --hook`.
- **`worktree config` refuses to write.** The repository has a versioned `.claude/genesis-tools.config.json`, which
  shadows the local file. Edit the versioned file.
- **`config init --yes` lost my worktree policy.** `init --yes` writes a new local file with only `mainPrBranch` and
  `branches`, so it replaces the whole local copy. Add the `worktrees` section again, or run
  `tools git worktree config`.
- **`rebase-cascade` says a cascade is already in progress.** Run `--status`, then `--continue` or `--abort`. Without
  a plan file, restore by hand from the `bkp/cascade/*` tags.
- **`rebranch apply` says another operation holds the lock.** Another `apply`, `--continue` or `--abort` runs in this
  repository, from any worktree. Wait for it. A lock left by a killed run is taken over by the next run.
- **Crash reports for `git` on macOS (`~/Library/Logs/DiagnosticReports/git-*.ips`).** git 2.55's macOS fsmonitor
  daemon can crash (SIGSEGV in `fsmonitor_publish`, called from `fsevent_callback`) while it shuts down, when an
  FSEvents batch arrives during the shutdown. A daemon shuts down when its worktree is moved or deleted and on
  `git fsmonitor--daemon stop`, so throwaway worktrees (tests, review and restack worktrees) produce crash reports,
  and macOS can show a crash dialog for each. Seen 2026-10-13: 2 crashes in the first 75 minutes with the monitor on
  globally. 1 of 3 daemons that were stopped cleanly before their folder moved still crashed, so stopping first does
  not avoid it. The 2.56.0 release notes name no fix. Nothing is lost: the daemon only caches what changed, and the
  next status starts a new one. `tools git fsmonitor disable` turns it all off when `tools git fsmonitor enable`
  turned it on. A monitor you turned on by hand stays on: set `core.fsmonitor` back with `git config --global`.
- **"Cannot copy a socket file" when you copy a repository folder.** While a daemon runs, the repository's `.git`
  holds the socket `fsmonitor--daemon.ipc`. Node's and Bun's `fs.cpSync` refuse to copy a socket and throw. macOS
  `cp -R` skips it with a warning and exits 0. GenesisTools copies repositories through `copyRepoTree`
  (`src/utils/git/test-repo.ts`), which skips the socket. `fsmonitor.socketDir` does not move it: git uses that
  setting only when `.git` is on a network drive.
- **A slow `commits` run.** Run it with `-v` and read the per-phase timings in `~/.genesis-tools/logs/<today>.log`.

## Related

- [tools github](../github/README.md): PRs, review threads, and `tools github merge`, the stack-safe merge that the
  `gt:git` skill uses.
- [tools gitlab](../gitlab/README.md): GitLab MRs.
- [tools azure-devops](../azure-devops/README.md): the work item titles of `commits --with-workitem-title`.
- [tools daemon](../daemon/README.md): runs the `git-fsmonitor-record` task.
