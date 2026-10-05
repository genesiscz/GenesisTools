# Split one branch into several by scope

Purpose: take the commits of a source branch and rebuild them as separate branches (one per
scope, one PR each), then prove the split lost nothing. Not for: reshaping the commits of a
single branch (`recommit.md`).

An agent runs three commands: `tools git rebranch plan`, then `apply`, then `verify`. They are
this reference as code. The manual commands under each step say what the tool does, and they
are the fallback when the tool is not available. `tools git rebranch` with no subcommand is the
interactive variant for a person at a terminal; it groups by commit scope, not by path.

Arguments (`/gt:git-recompose-branches`): number of commits to analyse (default 50), the
source branch (default: current), and comma-separated path patterns per group.

## 1. Analyse

```bash
WORK=$(mktemp -d)                                       # private: a fixed /tmp name can be a symlink someone else planted
tools git rebranch plan --groups 'api=src/api/**' --groups 'web=src/web/**,docs/web' [--source <branch>] [--base <ref>]
tools git rebranch plan <same flags> --json > "$WORK/plan.json"
```

The first run prints the base and the rule that chose it, then one row per commit with **IN**
(only group paths), **OUTSIDE** (no group path) or **MIXED** (both) per group, the commits in no
group, and the commits in several groups. An inferred base is a guess: confirm it, or pin it
with `--base`. Show the table to the user and ask how each MIXED commit should go: `whole`,
`skip`, or `paths-only` (keep only the group's paths). Write each answer into `plan.json` as the
commit's `decision`; `apply` refuses a MIXED commit without one. Put each commit in no group
into a group, or under the top-level `skip` list; otherwise `verify` reports its paths as lost.
The schema is in `src/git/README.md` (`rebranch`).

A merge commit in the range stops the plan: `git log --name-only` shows nothing for it, and
`git cherry-pick -x <merge>` refuses without a mainline parent. Ask the user to linearise the
source first (`git rebase "$BASE"` in a worktree, or `recommit.md`) and start over. Do not pick
merges with `-m 1`: the resolution then travels as an unlabelled diff.

Manual equivalent:

```bash
BASE=$(tools git base <source> --json | tools json --raw | jq -r .ref)   # the ref itself; confirm an inferred one
git log --merges "$(git merge-base "$BASE" <source>)"..<source>         # must print nothing
git log --reverse --format='COMMIT %h %s' --name-only --no-renames "$(git merge-base "$BASE" <source>)"..<source>
```

Use `"$BASE"` as it came back, local (`master`) or remote (`origin/master`). Re-spelling it as
`origin/$BASE` fails or names a different commit. Only `gh pr create --base` needs the bare
branch name (`${BASE#origin/}`).

## 2. Build each group branch

```bash
tools git rebranch apply --plan "$WORK/plan.json" --dry-run   # the exact git commands, nothing written
tools git rebranch apply --plan "$WORK/plan.json" --yes
```

`apply` refuses uncommitted or untracked changes, a rebase or cherry-pick in progress, a
locked index, and a group branch name that already exists (it never overwrites a branch). It
never moves the source, never pushes, and switches back to the starting branch at the end. On
a conflict it stops: resolve, `git add`, `git cherry-pick --continue` (or `--skip` to leave the
commit out), then `tools git rebranch apply --continue`. `tools git rebranch apply --abort`
removes every branch the run created, each tagged `bkp/rebranch/<branch>-<stamp>` first, and
returns to the starting branch.

Manual equivalent, per group:

```bash
git switch -c <group-branch> --no-track "$BASE"
git cherry-pick -x <sha> <sha> …                          # in original order
```

For a `paths-only` commit, after its pick:

```bash
git restore --source=HEAD~1 --staged --worktree -- <outside paths>
git commit --amend --no-edit --no-verify
```

`git status --porcelain` must be empty before the pick and before that `restore`: both write the
working tree. Print the outside paths before the `restore`. It is not the banned undo of
uncommitted work: every byte is still on the source branch, and the restore puts back the
branch's own copy from before the pick. Restore from `HEAD~1`, not from the base: an earlier
pick on the same branch may have changed one of those paths, and the base copy would undo it.
`--no-verify` keeps a formatting hook from rewriting the amended commit. Say all this in the
report.

## 3. Verify the split

`apply` ends with this check. `tools git rebranch verify --plan "$WORK/plan.json"` runs it alone
on existing branches. It exits 1 and names the path when:

- **DIFFERS**: the group that carries the last commit touching a path holds another entry than
  the source (blob, mode, or a file the source deleted);
- **LOST**: the last commit touching a path is in no group and not under `skip`;
- **EXTRA**: a group branch changes a path the source never touched;
- **UNVERIFIED**: the base moved and the source conflicts with it on that path.

A path whose last change was left out on purpose (`skip`, `paths-only`) is reported as dropped
and does not fail. A path changed by commits in two groups is reported as shared; it passes
only when the group with the last change holds the source's final entry. Any red line ends the
job: show it to the user, never report the split as done.

Manual equivalent:

```bash
git diff --no-renames --name-only "$BASE" <source> > "$WORK/source.raw" \
    || { echo "source <source>: diff failed, verification is void"; exit 1; }
sort "$WORK/source.raw" > "$WORK/split-source.txt"

: > "$WORK/groups.raw"
for g in <g1> <g2> …; do
    git diff --no-renames --name-only "$BASE" "$g" >> "$WORK/groups.raw" \
        || { echo "group $g: diff failed, verification is void"; exit 1; }
done

sort -u "$WORK/groups.raw" > "$WORK/split-groups.txt"
diff "$WORK/split-source.txt" "$WORK/split-groups.txt"  # must be empty
```

Every `git diff` is checked and none feeds a pipe: a pipe reports `sort`'s exit status, so a bad
ref writes an empty list and the comparison measures nothing. `--no-renames` on every side, or
a moved file counts as one path and a lost deletion of the old name passes. Then per path, the
mode AND the blob on the group with the last change must equal the source's (`git ls-tree <g>
-- <path>` against `git ls-tree <source> -- <path>`; `git rev-parse <ref>:<path>` cannot see a
lost executable bit). `tools git merged <g> --base <source>` per group is a fast second opinion.
This list comparison assumes the base did not move since the fork; the tool handles a moved base
with `git merge-tree`.

## 4. Report

Per group: branch, commit count, `git log --oneline "$BASE"..<g>`, the exact
`git push -u origin <g>` line (held until the user says push), and the `gh pr create --base
"${BASE#origin/}" --head <g>` line with a temp body file (`apply` prints both). Flag every MIXED
commit and what was dropped. Keep `$WORK`; the plan file is the evidence for the split.
