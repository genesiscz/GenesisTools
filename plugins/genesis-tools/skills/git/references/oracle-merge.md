# The oracle merge — rebase a branch whose work already landed upstream in another form

Purpose: rebase an integration branch when the base already holds most of its content through
squashed or recomposed PRs, so a plain replay would conflict at intermediate commits and could
replay an older copy over the better one. Not for: a branch with genuinely new work only (plain
rebase), or a fleet of independent branches (`rebase-fleet.md`).

The tell: `git cherry origin/<base> <branch>` prints mostly `+`, yet the base visibly holds the
same features. `tools git merged <branch>` reports UNMERGED with most touched files already
landed; `tools git rebase-cascade` routes such a parent here automatically and prints the
numbers.

Why it beats rerere and commit-by-commit resolution: a merge shows the net conflict once; a
replay shows it per commit in different shapes, and rerere only replays identical hunks. The
tagged tree turns "did the rebase resolve everything the way I meant" into a byte comparison.

Validated 2026-09-04 on a 97-commit branch: 22 net conflicts resolved once, 15 rebase stops,
zero manual work during the replay, final tree = oracle + one README hunk the replay kept
correctly, 8858 tests green, 14 commits dropped as already upstream.

## Procedure

1. **See the net conflicts, read-only:**
   `git merge-tree --write-tree origin/<base> <branch>` (exit 1 = conflicts; the file list follows
   the tree oid).
2. **Move stale rerere aside first.** `ls .git/rr-cache | wc -l` and `ls .git/rr-cache/*/postimage
   | wc -l`; then `git rerere clear && mv $(git rev-parse --git-common-dir)/rr-cache
   /tmp/rr-cache-backup-$(date +%Y%m%d-%H%M)`. Moved, never `rm`, and say where. With
   `rerere.autoupdate=true` a recorded resolution from months ago is applied and staged with no
   prompt (233 entries, 183 resolutions from July were sitting in GenesisTools on 2026-09-04).
3. **Merge once, resolve per file by evidence:** `git merge --no-commit --no-ff origin/<base>` on
   the branch. For every conflicted file: `git log -1 --format=%ci origin/<base> -- <file>` and
   `git log -1 --format=%ci <branch> -- <file>`. A merged PR's rewrite wins its files; the branch
   wins only work that is genuinely new. Keep the branch's new-work hunk inside a file that
   otherwise goes to the base: `bun "${CLAUDE_PLUGIN_ROOT}/skills/git/scripts/resolve-hunks.ts"
   <file> theirs 4` takes the base side and flips hunk 4. Never overwrite a whole file with one
   side: the non-conflict regions already hold both sides' work.
4. **Verify the merged tree like a real candidate:** install (`bun install` before blaming the
   merge; last time darwinkit had to be reinstalled), typecheck, the suites, every guard.
5. **Tag the tree and abort the merge:** `git tag oracle/<id> $(git write-tree)` then
   `git merge --abort`. A tag may point at a tree; it survives the abort.
6. **Replay against the oracle:**
   `bun "${CLAUDE_PLUGIN_ROOT}/skills/git/scripts/rebase-with-oracle.ts" oracle/<id> origin/<base> [--worktree <path>]`
   It runs `git rebase --empty=drop`, writes `git show oracle/<id>:<file>` over every conflicted
   file at each stop, continues, and `--skip`s a commit the resolution emptied. Expect stops on
   files `merge-tree` never listed: a three-way merge sees the net result, a replay sees
   intermediate states. It caps at 150 stops and logs every file decision.
7. **The gate:** `git diff oracle/<id> HEAD^{tree}`. Empty = exact. Non-empty = read it: either
   the replay is MORE right than the merge (a hunk taken wholesale from the base that also
   carried the branch's own new work, such as README lines documenting the branch's new flags:
   keep HEAD) or a regression (fix it).
8. **List the dropped commits by subject** against the base before pushing; each must be upstream
   in equal or better form.
8b. **Read the per-commit line audit** the script prints (pre-rebase tip vs result, matched by
   subject: DROPPED / SHRUNK / GROWN / NEW, the `--stat` residual of every SHRUNK commit, and
   `CANCEL?` where a later small commit is the exact per-file reverse of an earlier one). The
   tree gate protects the END state; this protects the HISTORY. Rule per SHRUNK residual:
   branch-only content that belongs under a dropped commit's subject → re-attribute it (rebuild
   from that commit's parent, `cherry-pick -n`, restore the stray file from HEAD, commit under
   the right subject, replay the rest); a hunk a later residual deletes again → the pair
   cancels, drop both; old code re-applied over the base's newer version with no later undo →
   the tree gate already failed, resolve to the oracle. Seen 2026-09-04: `886 → 28` and
   `311 → 2` lines, the 2 undoing 2 of the 28, and the 28-line survivor did not compile.
   "Applied cleanly" is not "applied correctly".
8c. **Read the lost-line check** printed last: every trimmed line the pre-rebase tip had, in a
   file the branch touched, that neither HEAD nor the base has. A file the base never touched
   since the fork and that still lost lines is a real loss (printed in full); a file the base
   rewrote is a count only (a rewrite drops old lines legitimately; re-indented survivors are
   not losses). "Compare with the state N rebases ago" is one command:
   `rebase-with-oracle.ts --audit-only <backup-tag> origin/<base>` (both audits, no rebase).
9. **Push only on "push"**, `--force-with-lease=<branch>:<anchor>`. A child branch cut from the
   old tip is orphaned now: `rebase-cascade.md`.

This does not break policy 6 (no `-X`): every file written at a stop comes from a tree resolved
by hand and verified green, not from a side.

## Fallback (flag it first)

Reset to the base and re-apply the net file set as a few clean commits. It loses per-commit
history and carries two traps: inverted refactors (a whole-diff apply resurrects code the base
removed) and dropped scaffolding (experiment files absent on the base). Only when the user wants
a recomposed history anyway.
