# Split one branch into several by scope

Purpose: take the commits of a source branch and rebuild them as separate branches (one per
scope, one PR each), then prove the split lost nothing. Not for: reshaping the commits of a
single branch (`recommit.md`); `tools git-rebranch` is the interactive alternative for the same
job.

Arguments (`/gt:git-recompose-branches`): number of commits to analyse (default 50), the
source branch (default: current), and comma-separated path patterns per group.

## 1. Analyse

```bash
BASE=$(tools git base <source> --json | tools json --raw | jq -r .ref)   # the ref itself; confirm an inferred one
git log --reverse --format='COMMIT %h %s' --name-only $(git merge-base "$BASE" <source>)..<source>
```

Every command below uses `"$BASE"` as it came back. It is whatever the detector chose, local
(`master`) or remote (`origin/master`), so re-spelling it as `origin/$BASE` either fails or
names a different commit. The one place the bare branch name is needed is `gh pr create
--base`, which takes a branch on the host, never a remote-tracking ref: strip the remote there
(`${BASE#origin/}`).

A merge commit in that range stops the analysis: `git log --name-only` shows nothing for it, and
`git cherry-pick -x <merge>` refuses without a mainline parent. Check with `git log --merges
<range>`; if any exist, ask the user to linearise the source first (`git rebase "$BASE"`
in a worktree, or `recommit.md`) and start over. Do not pick merges with `-m 1`: the resolution
content then travels as an unlabelled diff and the step 3 blob check is the only thing left to
catch a loss.

Classify every commit against the patterns: **IN** (only matching paths), **OUTSIDE** (no
matching path), **MIXED** (both). Write the table to `.claude/work/<source>-commits.md`:
`| # | hash | subject | group paths | outside paths | class |`. Ask the user how MIXED commits
should go (keep whole, skip, or keep only the group's paths).

## 2. Build each group branch

```bash
git switch -c <group-branch> --no-track "$BASE"
git cherry-pick -x <sha> <sha> …                          # in original order
```

For a MIXED commit whose outside paths must not come along, after the pick:

```bash
git restore --source="$BASE" --staged --worktree -- <outside paths>
git commit --amend --no-edit
```

`git status --porcelain` must be empty before the pick and before that `restore`: both write the
working tree, and neither the source branch nor the base holds uncommitted work. Print the
outside paths and confirm before that `restore`. It is not the banned undo of
uncommitted work: the branch was created seconds ago from the base, every byte is still on the
source branch, and the restore puts back the base's own copy of paths this group never owned.
Say that explicitly in the report.

## 3. Verify the split

```bash
WORK=$(mktemp -d)                                       # private: a fixed /tmp name can be a symlink someone else planted
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

Every `git diff` here is checked, on the source side as well as per group, and none of them
feeds a pipe. A pipe reports `sort`'s exit status, not git's, so a bad `<source>` writes an
empty list and the comparison then measures nothing against nothing. Never `cat <(…) <(…)`
either: a process substitution hides its exit status the same way, so a group branch that does
not exist contributes zero paths in silence. Usually that
shortens the list and the `diff` catches it, but when the missing group's paths are also claimed
by another group the lists match and the check reports a clean split it never verified.

`mktemp -d` for the same reason Phase 2b of `recommit.md` uses it: two fixed names under `/tmp`
collide between concurrent runs, and `>` follows a symlink another local user planted there and
truncates its target. Keep `$WORK`, do not delete it at the end; the two lists are the evidence
for the split and `/tmp` clears on reboot anyway. Name the directory in the report.

`--no-renames` on every side, or a moved file counts as one path (its new name) and a group
that lost the deletion of the old name still passes this diff. Cherry-picks carry deletions
whole, so the loss shows up only through the `restore` step on a MIXED commit; the check has
to be able to see it either way.

Then per path: the mode AND the blob on exactly one group branch must equal the source's
(`git ls-tree <g> -- <path>` vs `git ls-tree <source> -- <path>`; comparing blobs alone misses a
lost executable bit, which `git rev-parse <ref>:<path>` cannot see. A path deleted on the source
must be absent from that group too). A path present in two groups is
a design smell: name it and ask which group owns it. `tools git merged <g1> --base <source>`
per group is a fast second opinion (every group must be MERGED by content against the source).

## 4. Report

Per group: branch, commit count, `git log --oneline "$BASE"..<g>`, the exact
`git push -u origin <g>` line (held until the user says push), and the `gh pr create --base
"${BASE#origin/}" --head <g>` line with a temp body file. Flag every MIXED commit and what was
dropped.
