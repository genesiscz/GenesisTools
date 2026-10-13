# Judging a worker's commit

The stance is fable-judge's: a report is a set of claims, not evidence. Judge every commit as if a stranger wrote
it, and give the verdict with the evidence. Inline, never delegated: the verdict is the product of this loop.

## Checklist, in order

1. **The diff is the truth.** `git show --stat <sha>` and the full diff. One commit, only scope files, nothing staged
   that is another session's. A file outside the brief's scope is a finding, even if the change is good.
2. **Rerun every check the worker claims**, in your own shell: the brief's test command, `bunx tsgo --noEmit`, Biome
   on the changed files, Swift tests when Swift changed. A worker's sandbox can fail where yours passes (Sol's
   loopback tests) and the other way round; your run is the one that counts. Compare counts with the report.
3. **Planted regression for every new or changed test.** Put the pre-fix version of the fixed source back (copy the
   fixed file aside first, `git show <base>:<path> > <path>`, run the test, copy the fixed file back; the shell guard
   blocks `git checkout --` for this). A test that still passes proves nothing. Do it in the PR worktree, never in the
   shared main checkout.
4. **Contracts and callers.** Read the module's doc comments for what a function promises (errors it throws, values
   it returns) and grep its callers. On 2026-10-14 Sol's fix threw a raw error from a function documented to throw
   only `CdpLaunchError`; `browse.ts` rethrew anything else, so a user would have seen a stack trace. The tests were
   green.
5. **Spec authority.** The user's words beat the PR's claims, the claims beat the tests, the tests beat the current
   code. A fix that makes code match the PR's stated claim (Sol's t2/t4) is right even when another reading was
   possible; say which reading you accepted.
6. **Tests in the right place.** Unit cases sit with the unit's existing tests (Grok put an `isLocalRemoteUrl` table
   into a hub test because the brief omitted `detector.test.ts`; the correction moved it).
7. **The ready-to-post replies.** Each reply must be true of the final code after your correction: file names,
   counts, behaviour. Grok's said "the table is in prs.test.ts" after the move; such a line is corrected in the vault
   copy, not posted as is.
8. **Cherry-pickability** (unified mode): test-pick onto the PR branch before you correct, so the correction can avoid
   the conflicting lines.

## Verdicts

- **VERIFIED**: every claim reproduced, no defect.
- **VERIFIED WITH CAVEATS**: sound; list what could not be rerun and any minor issue the correction fixes.
- **REFUTED**: a claim failed or a defect was found that the correction cannot fix in one small commit. Then steer
  the worker for a second turn instead (restate the scope and constraints in the steer), and judge again.

## The correction commit

At most one per PR per round, only for real defects or quality below the bar: a broken contract, a test in the wrong
file, a misleading comment or doc line. Not for style the formatter does not enforce, and not for rewriting a correct
fix your way. Its subject uses the same `#<N> followup -` form and names what it corrects. It gets its own test when
it changes behaviour (prove it fails on the worker's version).
