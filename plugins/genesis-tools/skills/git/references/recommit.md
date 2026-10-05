# Recommit — recompose a branch's commits by scope

Purpose: rebuild the commits of the current branch into N clean, scope-organised commits with
the same final tree. Not a squash: a soft reset plus fresh commits, gated by a backup tag and a
tree-identity check. Not for: splitting into several branches (`recompose-branches.md`).

Arguments (`/gt:git-recommit`): a number (exactly that many commits), `--min N --max M` (decide
within the range), or nothing (ask: a number, or analyse and propose a split).

## The script path (preferred)

`scripts/recommit.ts` does Phases 3, 5's placement, 5's check and 7 in four calls. The judgement
stays yours: which commits form which group, and each message.

```bash
R="${CLAUDE_PLUGIN_ROOT}/skills/git/scripts/recommit.ts"
bun "$R" log   --base <parent> --head <branch>              # commits oldest first, with their paths
# write groups.json, in commit order:
#   [{ "message": "fix(x): …", "commits": ["abc1234", …] },
#    { "message": "test: …", "paths": ["src/**/*.test.ts"] },
#    { "message": "chore: the rest", "commits": [ … ], "rest": true }]
bun "$R" group --base <parent> --head <branch> --groups groups.json   # writes groups.plan.txt, checks it
bun "$R" apply --base <parent> --head <branch> --plan groups.plan.txt --dry-run
bun "$R" apply --base <parent> --head <branch> --plan groups.plan.txt
```

- Every path goes to the group whose `paths` globs claim it, else the group whose commits touch
  it most (a tie goes to the later group and prints as `shared`), else the `rest` group. Read the
  `shared` lines: a file that two scopes edit lands in one of them, so move it with an explicit
  `paths` entry when the default is wrong.
- `group` refuses a commit listed twice or never, a path two groups claim, a path no rule places,
  and an empty group. Fix the JSON and run it again; nothing exists yet.
- Grouping by `commits` keeps the CONTENT safe whatever the commits mix (cmux, tmux, utils, a
  deletion, a rename split across groups, a mode change, a symlink): `apply` proves the final tree
  byte for byte AND audits every path (it equals the base before its group, its final entry from
  its group on, and no other commit touches it). It does not make each commit BUILD on its own:
  a commit that edits cmux and a shared util puts the util in whichever group wins, so an
  earlier group can depend on a later one. Read `group`'s `areas:` line per group, pin a
  misplaced path with `paths`, and pass `--verify-each "bunx tsgo --noEmit"` (any command) to
  run it on every new commit in a throwaway worktree; a failure refuses the move.
- `apply` works on the merge-base, never on a moved parent tip, builds with `commit-tree` in a
  throwaway index (the working tree, the index and the stash are never touched, so it is safe in
  a worktree with someone else's uncommitted edits), refuses unless the new tree equals head's,
  tags the old head `bkp/recommit/<branch>-<stamp>`, and moves the branch only if it still points
  at the head the plan was built from. It prints the undo line.
- A stack: apply the parent, then `git rebase --onto <new parent> <old parent> <child>` (the tree
  is identical, so this applies cleanly), then recommit the child against the new parent.
- After a tree-identical recommit the previous CI result still describes the code; see the
  review-loop skill's rule on when CI may be skipped.

The phases below are the manual path, and what each step of the script stands for.

## Phase 1: detect the base

```bash
tools git base                      # ref + which rule chose it: --base, PR target, config mainPrBranch, declared, inferred
```

Prefer the remote spelling (`origin/master`, not `master`). Show the user "Detected base:
`<ref>` (<source>), diverged N commits ago. Correct?" and take a correction. An inferred base
must be confirmed; a wrong base makes every later step wrong.

## Phase 2: local vs remote base

When the base has both a local and a remote branch and they differ (`git log --oneline
master..origin/master` and the reverse), say so and offer to sync (`git fetch origin && git
branch -f master origin/master` in a worktree, or `git checkout master && git pull` in the main
checkout). Use the remote name for everything below.

## Phase 2b: BASE_SHA is the MERGE-BASE, never the moving tip

```bash
BASE_SHA=$(git merge-base HEAD origin/<base>)     # never git rev-parse origin/<base>
CHECK="${CLAUDE_PLUGIN_ROOT}/skills/git/scripts/recommit-plan-check.ts"
WORK=$(mktemp -d)                                 # private: a fixed /tmp name can be a symlink someone else planted
bun "$CHECK" --base "$BASE_SHA" --list > "$WORK/files.txt"
echo "files: $(wc -l < "$WORK/files.txt")"
git log --oneline "$BASE_SHA"..origin/<base>       # what the base gained; none of it may appear above
```

The two are equal only while the base has not moved since the fork. Using the tip lists your
changes PLUS the reverse of every commit the base gained; staging that in Phase 7 reverts other
people's work, and the tree-identity gate does not catch it because the revert was in the diff
you started from. The tell: the file count jumps and paths from tools the branch never touched
appear. Observed 2026-09-04: 97 files instead of 51. Do not "fix" it by rebasing first; rebase
after the recommit is verified, as a separate step.

## Phase 3: collect commit and file data

```bash
git log --reverse --format='COMMIT %h %s' --name-only "$BASE_SHA"..HEAD
cat "$WORK/files.txt"                               # the canonical list every group must cover
```

The canonical list comes from the script, never from `git diff --name-only`. Rename detection
is on by default there, so a moved file prints only its new path; the old path never reaches
the categoriser, no group stages the deletion, and the recomposed branch resurrects the file.
Observed 2026-09-04: 210 paths with detection on, 216 without, six deleted files came back,
and nothing before the final tree gate noticed. The script lists with `--no-renames`, so both
halves of every move are in the list and the categoriser must place both.

## Phase 4: commit count

Number given → use it. Range → decide in Phase 5. Nothing → ask: "N commits touching M files
across these scopes: […]. A number, or analyse and propose a split?"

## Phase 5: categorise (a Sonnet subagent)

Give it the Phase 3 output. Rules: every path from the canonical list appears in exactly one
group; a path touched across scopes goes with its most significant change; groups are ordered
chronologically by scope; messages match the repo's style (`git log --oneline -20 "$BASE_SHA"`).
It returns `COMMIT n: <message>` blocks with `FILES:` lists. Save them to `$WORK/plan.txt`
and check the plan yourself, before Phase 6:

```bash
bun "$CHECK" --base "$BASE_SHA" --plan "$WORK/plan.txt"   # must print "tree identity OK"
```

The script compares the union with a list built by a different command than the one the
subagent saw, flags duplicates, missing and extra paths, replays the groups in a temporary
index and proves the result is head's tree, byte for byte. No commit exists yet, so a failure
costs one plan edit, not a reset and a redo. The subagent's own "I cross-checked the union"
line is not a check: it reruns the command that produced its input and confirms itself.

## Phase 6: present the plan

Per commit: message, file count, files (collapsed above 10). Ask: "Proceed with this N-commit
split? (yes / adjust / abort)".

## Phase 7: backup, reset, recommit, gate

```bash
git status --porcelain                              # MUST be empty: a tag saves commits, never uncommitted work
BRANCH=$(git rev-parse --abbrev-ref HEAD)
BACKUP_TAG="bkp/recommit/${BRANCH}-$(date +%Y%m%d-%H%M%S)"
git tag "$BACKUP_TAG" HEAD                          # tell the user the name immediately
git reset --soft "$BASE_SHA"
git reset HEAD                                      # working tree = final state, nothing staged
git add -- <file> <file> …                          # per commit, the group's paths ONLY, never `git add .` or -A
git commit -m "<message>"
git status --porcelain                              # MUST be empty after the last commit
git diff "$BACKUP_TAG"..HEAD --stat                 # MUST be empty
```

Naming a path that the branch deleted stages the deletion (git 2.x, verified 2026-09-04 with
`git show --name-status` printing `R100` for a move whose both halves sat in one group), so
the staging line is only as good as the list: a ` D` line left after the loop means a path
was never in any group.

A non-empty status or diff → show it, ABORT, tell the user `git reset --hard $BACKUP_TAG`
restores the branch, which is true only because the tree was clean before the tag: the tag
holds commits, not uncommitted work. Refuse to start on a dirty tree; ask the user to commit
or stash first. That reset is the documented undo of a recommit in progress, not the
banned "clean a tree you are inspecting"; every byte is on the tag. The Phase 5 script already
proved the plan reaches this tree, so a failure here means the staging deviated from the plan,
not that the plan was wrong.

Then show old count → new count, the new `git log --oneline "$BASE_SHA"..HEAD`, the backup
tag. Push only when the user says push: `git push --force-with-lease=<branch>:<anchor> origin
<branch>` with the anchor captured before the reset. Otherwise: "Push: HELD" and the line.

## Stacks: a ← b ← c

Recommitting `b` rewrites the SHAs `c` is built on; done naively `c` carries duplicates of
`b`'s old commits. The transplant is conflict-free by construction because the final tree of
`b` is identical before and after (Phase 7 proves it).

Order: bottom-up, `b` first, then transplant and recommit `c`. Deeper stacks repeat the pair
downward.

```bash
OLD_B=$(git rev-parse b); OLD_C=$(git rev-parse c)          # step 0: freeze EVERYTHING first
git tag bkp/recommit/b-<ts> "$OLD_B"; git tag bkp/recommit/c-<ts> "$OLD_C"
# step 1: recommit b against a; then
git diff "$OLD_B" b --stat                                  # MUST be empty
# step 2: transplant c onto the rewritten b
git rebase --onto b "$(git merge-base "$OLD_B" c)" c        # the merge-base, not OLD_B blindly
# step 3: recommit c against the new b; git diff "$OLD_C" c --stat MUST be empty
# step 4: push bottom-up, both with a lease, only when told
```

Lab-verified facts (2026-07-20): (1) after rewriting `b`, never `git merge b` into `c`; the
collapsed merge-base turns every evolved line into a conflict, the transplant gives zero.
(2) `b` must be FROZEN from `c`'s last sync until the transplant; a late delta on `b` conflicts
under any method — land it, merge `b` into `c` once, then step 0. (3) Merge commits inside
`c` are harmless; the transplant linearises them.

Fallback when `b` moved and `c` is stale: merge new `b` into `c`, resolve once, `git reset
--soft b` in `c` and recommit `c` directly; prove no loss with `git diff <pre-merge c tag>..c
--stat` showing only the late-`b` delta.

Rules: one branch at a time; the tree-identity check is the gate between every step; keep all
backup tags until every PR in the stack is merged; run step 2 in `c`'s worktree when it has one.
`tools git rebase-cascade` automates the transplant part for a plain parent rebase.
