# Merged? Then clean up — `tools git merged`

Purpose: decide whether a branch or worktree is already in the base, and remove it without
losing anything. Not for: deciding whether a branch *should* be merged (that is a review), or
for branches you did not create (name them, never sweep).

## Why git lies

`git branch -d`, `merge-base --is-ancestor`, `git log base..branch`, `git cherry` and `git diff
--stat` all compare SHAs or patch-ids. A squash merge, a rebase merge and a recompose before
merging all give the landed commits new SHAs, so a fully merged branch reads as unmerged. On
2026-09-04 `backup/clarity-pr-before-squash` was 100 % in master: ancestor said no, cherry said
13 unmatched, `diff --stat` showed 36 000 lines. The reliable test is content: every file the
branch touched has its final blob somewhere in the base's history after the fork.

`tools git merged` runs the ladder and prints which tier decided:

| verdict | how | meaning |
|---|---|---|
| EMPTY | - | the tip is the base tip; nothing on the branch |
| MERGED | ancestor | plain merge or fast-forward; `ahead 0` |
| MERGED | cherry | rebased or cherry-picked; every patch-id exists upstream |
| MERGED | content | squashed, recomposed or a snapshot; every touched file's final blob landed |
| UNMERGED | none | the listed files hold content the base never had (`+/-` per file) |

Known limits, say them when they apply: a snapshot taken before the PR's last edit lists that
file as unmerged (correct: that exact content never landed); renames are delete + add; a
branch whose only unique work is a revert of something the base later re-added shows MERGED.

## Procedure

1. `git fetch --prune` so `origin/<base>` and the `[gone]` markers are current.
2. `tools git merged <ref> [<ref>…]` for named branches or worktree paths, or `tools git merged
   --all` for every local branch and detached worktree. Read the `base:` line; pass `--base` when
   it is not the branch's real target. Add `--pr` when PRs exist: a stacked child is then judged
   against its PR target and the `pr#N:MERGED` flag corroborates.
3. Read `how`. `content` on a branch whose PR was squashed is the expected answer, not a doubt.
   For UNMERGED read the file list: a real branch-only file means real work; a file the PR
   edited after the snapshot means the snapshot is stale, not the work lost.
4. **Stashes are manual.** `git stash list`; for each stash this session created:
   `git stash show -p 'stash@{N}'`, then `git show origin/<base>:<file> | rg '<distinctive line>'`.
   Unique content → surface it and ask. Only touch stashes you made; long-lived stashes stay.
5. Remove only what the printed list named:
   `tools git merged --prune <ref> --prune <ref>`. There is no "prune everything" flag by
   design: each ref is re-verified, and the plan (worktree path, branch and tip SHA, remote
   branch with `--remote`) is printed before the single confirmation. Non-interactive runs need
   `--yes`, which means "I read the list a plain run printed".
6. Verify: `git worktree list`, `git branch`, and the restore lines it printed
   (`git branch <name> <sha>` brings a branch back).

## What `--prune` refuses, and why

- UNMERGED, or a dirty worktree (any entry): real work could be lost.
- The current branch, the base branch, the main checkout.
- `--remote` with an OPEN PR or MR on that head, or a `push: never` policy: the remote is kept
  and the reason printed; the local removal still runs.
- `unpushed` on a MERGED branch is a warning, not a refusal: `origin/<branch>` holds an older
  copy (typical after a recompose) and the content is already on the base.

Remote deletion is opt-in (`--remote`) even for a fully merged branch: the remote head may
still be a PR head someone links to.

## Worktree removal details

- Leave the directory first: `git worktree remove` refuses to remove its own cwd. `ExitWorktree`
  only acts on worktrees created via `EnterWorktree` this session; otherwise `cd` to the main
  checkout and use absolute paths.
- Non-force first. A refusal "contains modified or untracked files" is the signal you want.
  `--prune` inspects `status`: only `D` entries (the debris of an interrupted removal) → it
  retries with `--force`; any `M`/`??`/`A`/`R` entry → it refuses and says so.
- Give removal a long timeout (`node_modules` deletion is slow); `--prune` uses 120 s.

## When to STOP and ask

Anything genuinely unpushed: a branch whose content diff shows unique commits, a stash with
unique content, a worktree dirty with real edits. Do not delete it. Give the user this shape:

- **What** the artifact is (branch / worktree / stash) and its exact identifier or path.
- **What is dirty or unmerged**, concretely: the file list and a one-line diffstat, or the
  specific commits (`git log --oneline origin/<base>..<branch>` after confirming they are real,
  not SHA noise).
- **Your proposal**: "push branch X to a same-named remote branch first", "pop and commit the
  stash", "these look like superseded old versions, safe to discard, confirm?".

Asking costs one prompt; a wrong `-D` or `--force` costs unrecoverable work.

## Report

What was removed (worktree path, branch names with their old tip SHAs, stash text) and what
was deliberately left alone: unrelated worktrees, other people's stashes, backup branches you
were not asked about. A separate worktree from another line of work is out of scope unless the
user named it; verify its state and offer, never auto-remove.
