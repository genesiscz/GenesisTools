---
name: gt:git
description: Git branch mechanics with proof, not habit. Is this branch or worktree ALREADY merged (squash, rebase and recompose all fool git's own checks); rebase one branch or a whole fleet onto a moved base; rebase a branch whose work already landed upstream in another form (the oracle merge); cascade a parent and its child branches; clean up worktrees and branches after a merge without losing anything; recompose a branch into clean commits; split one branch into several by scope; merge a PR the rebase way. Use this whenever the user says rebase, restack, cascade, "is it merged", "can I delete this branch", "clean up worktrees", recommit, squash the commits, split this branch, "land the PR", or asks about a branch that looks unmerged but should be. Also when a rebase hits conflicts and the base already contains the branch's features.
---

# gt:git — one hub for merged checks, rebases, cascades, cleanup and recommits

Content, not SHAs, decides "merged". A backup tag precedes every move. Push only on the word
"push". One confirmation per destructive class per run. The mechanics live in `tools git …`
commands so they are code with tests, not prose; the references tell you which command, in
which order, and what to read in its output.

## Pick the reference

| You are asked… | Read | Tool that does the work |
|---|---|---|
| "is feat/x merged?", "can I delete these worktrees?", "clean up after the merge", "which of my branches are done", "remove the merged branches" | `references/merged-and-cleanup.md` | `tools git merged`, `tools git merged --prune` |
| "rebase feat/x onto master", "rebase and push", "does it land empty", "retarget onto develop", "rebase PR 12 and merge it" | `references/rebase-branch.md` | git, `tools git base`, `tools github merge` |
| "rebase my open MRs", "restack these 12 branches", "main moved, update my branches", many branches behind one base | `references/rebase-fleet.md` (GitLab fleets: also the internal plugin's `rebase-prs` skill) | worktrees + git |
| conflicts on a branch whose PRs already merged, `git cherry` mostly `+` while the base visibly holds the features, "rebase enhancements safely", "the base already has most of this" | `references/oracle-merge.md` | `scripts/resolve-hunks.ts`, `scripts/rebase-with-oracle.ts` |
| "rebase the parent and its children", "my sub-branches broke after I rebased", a stack of PRs, "cascade" | `references/rebase-cascade.md` | `tools git rebase-cascade` |
| "recommit", "make these 40 commits into 5", "clean commits before the PR", "squash into logical commits" | `references/recommit.md` (`/gt:git-recommit`) | git, `scripts/recommit-plan-check.ts` |
| "split this branch into three PRs", "cherry-pick the dashboard commits out into their own branch" | `references/recompose-branches.md` (`/gt:git-recompose-branches`) | git, `tools git-rebranch` |
| "merge PR 12", "land it", "rebase merge", "squash merge it", GitLab MR merge | `references/merge-pr.md` | `tools github merge`, `glab` |
| import-only conflicts on a JS/TS monorepo with a barrel normaliser (rare) | `references/import-fast-path.md` | the internal plugin's `rebase-prs` skill |

Two questions come first in almost every case, so answer them before opening a reference:

1. **Is the branch already upstream?** `tools git merged <branch>` (add `--pr` when a PR exists).
   A MERGED verdict changes the job: nothing to rebase, only to clean up.
2. **What is the base?** `tools git base <branch>` prints the ref and which rule chose it
   (`--base`, the PR target, the repo config, a declared branch, or an inference). An
   *inferred* base is a guess: print it and confirm it before any rebase, cascade or prune.

## The base branch is data

`genesis-tools.config.json` declares `git.mainPrBranch` (the default PR/MR and cascade target)
and `git.branches[]` with a `push` policy per branch (`confirm` default, `never`, `allowed`).
It is read from `<repo>/.claude/genesis-tools.config.json` first, then from the git common dir,
so every worktree of a clone shares one file. `tools git config show` prints the effective
config, `tools git config init` infers a main branch and writes the file after confirmation,
`tools git config check` validates it. Without a file the commands infer (origin HEAD, then
the closest merge-base) and say so; they never silently assume `master`.

## Policies (every reference cites these)

1. **Merged means content.** Ancestry, patch-ids and `diff --stat` each lie in one case; the
   `merged` verdict says which case you are in (`ancestor`, `cherry`, `content`).
2. **Backup before the first move**: a tag `bkp/<verb>/<branch>-<ts>`; print the restore command.
3. **Push only on the word "push"** (or "merge", through the merge tool). Implied is not typed.
4. **Confirm always**, one confirmation per destructive class per run: force-push, branch
   delete, worktree remove, stash drop. A local rebase with a backup tag needs no prompt.
5. **Force only as `--force-with-lease=<branch>:<anchor>`**, the anchor captured before the
   change and no fetch in between. On "stale info": fetch and read, never escalate to `--force`.
6. **Never `-X ours`, `-X theirs`, `--ours`, `--theirs`.** The oracle merge is not that: every
   file it writes at a stop comes from a tree resolved by hand and verified green.
7. **A check never mutates.** `merged` without `--prune` deletes nothing; `rebase-cascade
   --dry-run` moves nothing; every diagnostic prints the fix command instead of running it.
8. **The base is data**: PR target, then config, then declared, then inferred; an inferred base
   is confirmed before it is used.
9. **Never bare `rm`**, never `git checkout -- <path>` or `git restore` to undo (stash or copy),
   never `$?` after a pipe, `2>/dev/null` only for noise you can name.

## Related skills

- Creating a worktree for new work: the third-party `using-git-worktrees` skill.
- Choosing merge vs PR when a branch is finished: `finishing-a-development-branch`.
- Review comments on the PR you are about to merge: `gt:github` (`tools github review`).
- GitLab fleets at work: the internal plugin's `rebase-prs` skill owns the MR audit and the pinned-lease push.

## Scripts

- `bun "${CLAUDE_PLUGIN_ROOT}/skills/git/scripts/resolve-hunks.ts" <file> theirs|ours [hunk-index …]`
  resolves every conflict block in one file to a side, with listed hunks flipped; the
  non-conflict regions survive. Refuses to write while a marker would remain.
- `bun "${CLAUDE_PLUGIN_ROOT}/skills/git/scripts/rebase-with-oracle.ts" <oracle-ref> <base-ref> [--worktree <path>]`
  replays a branch with `--empty=drop`, writes the oracle's copy of every conflicted file at
  each stop, and ends with the tree gate, the per-commit line audit and the lost-line check.
  `--audit-only <pre-tip> <base>` runs the two audits with no rebase.
- `bun "${CLAUDE_PLUGIN_ROOT}/skills/git/scripts/recommit-plan-check.ts" --base <sha> (--list | --plan <file>)`
  lists every changed path with rename detection off (both halves of a move), or checks a
  recommit plan in a temporary index before the first commit exists: duplicates, missing and
  extra paths, groups that change nothing, and the tree-identity gate.
