# Rebase one branch onto its base — and push or merge only when told

Purpose: rebase a branch onto its (possibly moved) base, detect an empty rebase, force-push with
a lease when the user said push, merge the PR when the user said merge. Not for: several
branches (`rebase-fleet.md`), a parent with children (`rebase-cascade.md`), or a branch whose
work already landed upstream in another form (`oracle-merge.md`).

## 1. Resolve the inputs

- **Branch / PR**: from the message or the current checkout. A PR number resolves to its head
  and base: `gh pr view <N> --json headRefName,baseRefName,state` (GitLab: `glab mr view <N>
  --output json`).
- **Base**: `tools git base <branch>` prints the ref and the rule that chose it (`--base`, PR
  target, config `mainPrBranch`, declared branch, inferred). An inferred base is a guess:
  print it and confirm before continuing. "Retarget onto X" means X is the base, and the PR
  base changes too: `gh pr edit <N> --base <X>` / `glab mr update <N> --target-branch <X>`.
- **Where**: a branch checked out in a worktree is rebased inside that worktree
  (`git -C <worktree> …`); git refuses to rebase a branch that is checked out elsewhere.

## 2. Pre-flight

```bash
git fetch origin
tools git merged <branch> --base origin/<base>      # MERGED → nothing to rebase, go to merged-and-cleanup.md
git rev-list --left-right --count origin/<base>...<branch>   # behind<TAB>ahead
PUSHREF=$(git rev-parse --abbrev-ref --symbolic-full-name <branch>@{push} 2>/dev/null || true)
REMOTE=${PUSHREF%%/*}                               # the remote git would really push to
PUSH_BRANCH=${PUSHREF#*/}                           # its name THERE, which need not be <branch>
ANCHOR=${PUSHREF:+$(git rev-parse "$PUSHREF")}      # the lease anchor, BEFORE anything moves
git tag bkp/rebase/<branch>-$(date +%Y%m%d-%H%M) <branch>
```

Report `N ahead, M behind`. `0 ahead` means the branch is already in the base: skip the rebase.
`@{push}`, not `@{upstream}`: in a triangular or fork workflow a branch pulls from
`upstream/topic` and pushes to `origin/topic`, so the upstream would anchor the lease against a
ref the push never touches, and `origin <branch>` would be the wrong destination for a branch
whose push remote is not `origin`. `2>/dev/null` here swallows exactly one message, git's
`fatal: … does not have a push destination`, and the empty `PUSHREF` it leaves is read as a
fact below, never as "the lookup found nothing".

## 3. Rebase

```bash
git rebase origin/<base> <branch>
```

Read the output:

- "Successfully rebased" with `git log --oneline origin/<base>..<branch>` empty → **EMPTY**: all
  commits were already upstream (patch-identical). Report it; ask whether to close the PR.
- Conflicts on a branch whose work is NOT upstream → resolve by hand, both sides' intent, never
  `-X`. Record each resolution (file, both sides, result, why) in the report.
- Conflicts on a branch whose features the base **visibly already holds** (its PRs were squashed
  or recomposed before merging; `git cherry origin/<base> <branch>` is mostly `+`) → do not
  resolve commit by commit. `git rebase --abort`, then `oracle-merge.md`.
- A stack: this branch is the base of another PR → the child is orphaned now; `rebase-cascade.md`
  handles both at once. Prefer running the cascade instead of a lone rebase when you know the
  children up front.

## 4. Verify

```bash
git log --oneline origin/<base>..<branch>
git range-diff <old-base>..bkp/rebase/<branch>-<ts> origin/<base>..<branch>   # only context drift expected
```

Run the project's typecheck and tests when the branch's files overlap with what the base gained.
`range-diff` is blind to import-line correctness; tsc and tests are the real gate.

## 5. Push — only on the word "push"

The user typed "push" (or "merge", which implies the merge tool's push): then, and only then:

```bash
git push --force-with-lease=refs/heads/$PUSH_BRANCH:$ANCHOR \
    "$REMOTE" <branch>:refs/heads/$PUSH_BRANCH        # with a $PUSHREF
git push -u origin <branch>                           # empty $PUSHREF: nothing to lease against yet
```

The remote, the leased ref and the destination all come out of `$PUSHREF`, so they cannot name
three different things. Writing the destination as `<branch>:refs/heads/$PUSH_BRANCH` matters
whenever the branch is called something else on the remote: `"$REMOTE" <branch>` would lease one
ref and write another. No fetch between capturing the anchor and
pushing. "stale info" means the remote moved: fetch, read what arrived, and re-decide; never
escalate to `--force`. Before the first push of a session check `git branch -vv`: a branch
tracking a differently named upstream pushes elsewhere.
A branch's `push: never` policy (`tools git config show`) means print the command, do not run it.

Without the word: report `Push: HELD` with the new HEAD sha and the exact push line.

## 6. Merge — only when asked

`merge-pr.md`. Rebase style is the default (`tools github merge --rebase <PR>`, or `--ff-only`
when the branch is already linear on its base).

## Report shape

- `Rebased <branch> onto <base>: N commits, pushed (lease ok), merged --ff-only (#PR).`
- `Rebased <branch> onto <base>: EMPTY, all N commits already upstream. Close the PR?`
- `Rebased <branch> onto <base>: CONFLICT in <files>; resolved by hand: <one line each>.`
- `Rebased <branch> onto <base>: N commits. Push: HELD — git push --force-with-lease=… origin <branch>`
