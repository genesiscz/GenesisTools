# Cascade: rebase a parent and the children stacked on it — `tools git rebase-cascade`

Purpose: move a parent branch onto its target and transplant every child branch that was cut
from it, so no child carries duplicates of the parent's old commits. Not for: a single branch
(`rebase-branch.md`) or many independent branches (`rebase-fleet.md`).

## Drive the tool

```bash
tools git rebase-cascade <parent> --dry-run          # the plan, nothing moves
tools git rebase-cascade <parent> [--onto <target>] [--child <b> …]
```

What the plan shows, and what to check before confirming once:

- **target**: the parent's open PR target first, then config `mainPrBranch`, then an inference
  (printed as such; pass `--onto` to pin it).
- **parent verdict vs target** from the merged engine, which picks the parent's route:
  - `rebase`: plain `git rebase <target> <parent>`.
  - `merged`: the parent is already upstream; it is not rebased, the children transplant
    straight onto the target, and the parent is reported as removable (`tools git merged --prune`).
  - `oracle`: the parent was recomposed upstream (≥ 80 % of its touched files already landed,
    patch-ids unmatched). The tool prints the net conflicts and STOPS; run `oracle-merge.md` on
    the parent by hand, then `tools git rebase-cascade --continue`.
- **children**, detected by merge-base: a branch whose merge-base with the parent holds
  commits the target lacks. A child of a child is ordered after its sibling and transplanted
  onto that sibling. Each line shows the child's own commit count and its fork point. A child
  checked out in another worktree is rebased there; a dirty worktree is a refusal.
- **backups**: `refs/backup/cascade/<branch>` (survives gc, invisible in listings) and a tag
  `bkp/cascade/<branch>-<ts>` per branch, created before the first move.

Every child moves with `git rebase --onto <new base> <fork point> <child>`, never a plain
`git rebase <parent>`: patch-id dedup is not a guarantee once the parent's rebase changed any
context. After each transplant the tool checks the child: byte-identical tree when its base
tree did not change, otherwise the count of replayed commits (fewer means some were dropped as
already upstream; it says so).

## Conflicts, resume, undo

- A conflict leaves that branch's rebase in progress and prints the files. Resolve by hand,
  `git add`, `git rebase --continue`, then `tools git rebase-cascade --continue`.
- `--status` shows the phase, the branch it waits on, and whether the target moved since the plan.
- `--abort` resets every touched branch to its backup and clears the plan (tags stay);
  `--restore <branch>` does one branch; `--cleanup` deletes the backup refs, the tags and the plan.
- The tool never pushes. It prints the `git push --force-with-lease=<b>:<anchor> origin <b>`
  lines with the anchors captured before anything moved; run them only on the word "push".

## By hand, when the tool refuses or the repo is odd

`OLD_PARENT` is the parent's tip before its rebase. Tiers:

1. Reflog: `git reflog <parent>`; the entry before the rebase is usually `<parent>@{1}`. Show it
   and its subject, confirm it is the pre-rebase tip.
2. `git cherry -v <parent> <child>`: `-` lines already exist on the new parent, `+` lines are
   the child's own. Count the `+` lines (N) and use `<child>~N` as `OLD_PARENT`. Works only when
   the parent's commits were not squashed or reordered.
3. Manual: `git log --oneline <target>..<child>`, ask which commits are the child's own, set
   `OLD_PARENT=<child>~N`.

Then per child: `git rebase --onto <parent> $(git merge-base $OLD_PARENT <child>) <child>` and
show `git log --oneline <parent>..<child>` afterwards. The merge-base, not `OLD_PARENT` blindly:
a child that last synced before the parent's tip has an older fork point.

## Merging a stack afterwards

Bottom-up, one PR at a time, and never `--delete-branch` on the parent while a child PR still
targets it: `gh pr merge --delete-branch` closes the child instead of retargeting it. Merge the
lowest PR, `gh pr edit <child> --base <what the parent merged into>`, verify `gh pr view <child>
--json baseRefName,state,mergeable` shows OPEN and MERGEABLE, only then delete the parent's
branch. `merge-pr.md` has the commands.
