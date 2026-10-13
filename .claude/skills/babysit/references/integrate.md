# Integrating a round: picks, gates, push, unified

Every push buys a paid review from each bot, so a PR gets one push per round with both commits. Never push the unified
branch. Push only after every gate below passed in the worktree you push from.

## Stacked PRs

When one PR in the run is based on another's branch, push the parent first, then the child. The child's diff on
GitHub then shows the parent's new commits until it is restacked; that is expected, and the restack belongs to merge
prep (review-loop landing recipe: rebase the whole chain once, push each branch once), not to a review round. Say
it in the report so nobody reads the child's grown diff as a mistake.

## Worktree mode (the default when disk allows)

The worker committed on its worktree `W`, detached at the PR head.

```bash
cd <W>
# correction commit here (exact paths), then the gates:
bun install --ignore-scripts && bun scripts/apply-patches.ts   # once per worktree; tsgo fails without the patches
bun scripts/test.ts <the PR's test paths>
bunx tsgo --noEmit
bunx biome check <changed files>
bun scripts/ci/check-tool-commands.ts
bash scripts/ci/placeholder-check.sh
git push origin HEAD:refs/heads/<pr-branch>        # a rejected push: fetch, rebase onto origin/<pr-branch>, re-gate
```

Then in the main checkout (unified branch): `git cherry-pick <worker sha> <correction sha>`, exact paths only if a
conflict needs hand-editing. A version-only conflict in `.claude-plugin/marketplace.json` or
`plugins/genesis-tools/.claude-plugin/plugin.json` keeps the higher version.

## Unified mode

The worker committed on unified in the main checkout; the correction goes there too. Then:

```bash
git -c core.hooksPath=/dev/null worktree add --detach /tmp/cc/<project>/<session>/worktrees/pr<N> origin/<pr-branch>
cd /tmp/cc/<project>/<session>/worktrees/pr<N>
git -c core.hooksPath=/dev/null cherry-pick <worker sha>       # a conflict: keep the PR branch's lines plus the worker's change
git -c core.hooksPath=/dev/null cherry-pick <correction sha>
# the same gates as above, then the push
```

`git cherry-pick --abort` aborts the whole sequence; `--skip` drops one commit. Record every conflict and how you
resolved it: it goes into the report (#511's import line, 2026-10-14).

## After the push

- `git log --oneline origin/<pr-branch>..HEAD` must be empty, and the push line names the old and new head.
- Fetch new threads before you post anything (review-loop: `new-threads.ts`), because the bots answer the push.
- The vault copy of the reply file names the PR-branch SHAs; render the summary with `--range <old>..<new>
  --cwd <the PR worktree>`.
- Remove the worktree (SKILL.md step 8).
