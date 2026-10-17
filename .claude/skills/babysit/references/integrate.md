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

The hooks are the gates (Biome, tsgo, the subject rules, the personal-data probe): workers commit and the lead pushes
WITH them. The one exception is a stuck syspolicyd (one core at 100%), when the first launch of any new executable
hangs: a hook copy, a worktree's own `biome`, a fresh Swift test bundle. Prove it first with a brand-new two-line
`#!/bin/sh` script that does not return (`newExecutablesStall()` in `versions.ts` does exactly that). Only then: run
Biome from the main checkout's `node_modules/.bin/biome` on the worktree files, authorize the worker's commit with
`git -c hook.pre-commit.enabled=false -c hook.commit-msg.enabled=false commit`, check its subject with
`check-commits.ts`, and push with `integrate.ts … --no-push-hooks`. The scripts honour that flag only while the probe
still stalls, so the switch ends by itself when syspolicyd recovers. Swift tests wait: record them as NOT RUN, but
`bun .claude/skills/babysit/scripts/swift-typecheck.ts --package <dir>` still proves the Swift code compiles (every
target through `swiftc` alone, no binary launched; GenesisKit takes about two minutes). Use it also when another
session holds the one Swift build slot. Hooks set in config ignore `core.hooksPath`: a by-hand replay (rebase,
cherry-pick, worktree add, which run no gate hook) uses `-c hook.<event>.enabled=false` per event, as `HOOKS_OFF` does.

Then in the main checkout (unified branch):
`bun .claude/skills/babysit/scripts/pick-unified.ts --branch <unified> <worker sha> <correction sha>`. It skips a
commit already there, resolves a version-only conflict in `.claude-plugin/marketplace.json` or
`plugins/genesis-tools/.claude-plugin/plugin.json` to the higher version, and aborts and lists any other conflict.
Give the listed ones to a free worker in a scratch worktree detached at the unified head (resolve keeping both sides,
`cherry-pick -x` each), check its tests and Biome, then fast-forward unified to it if unified has not moved.

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

The worker's scope and reply disposition come from `scripts/policy.ts`, as rendered by `fill-brief.ts`.
A deferred ordinary later-round Medium/Low item carries the supported reply verdict `"belongs-elsewhere"` and
an explanation of the policy deferral: it stays in the summary, but `integrate.ts` posts it in a separate `--no-resolve` batch.
Only acted-on items enter the resolving batch. Security findings and dedicated user reviews are always fixed.

- `git log --oneline origin/<pr-branch>..HEAD` must be empty, and the push line names the old and new head.
- Fetch new threads before you post anything (review-loop: `new-threads.ts`), because the bots answer the push.
- The vault copy of the reply file names the PR-branch SHAs; render the summary with `--range <old>..<new>
  --cwd <the PR worktree>`.
- Remove the worktree (SKILL.md step 8).
