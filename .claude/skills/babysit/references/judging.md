# Judging a worker's commit

The stance is fable-judge's: a report is a set of claims, not evidence. Judge every commit as if a stranger wrote
it, and give the verdict with the evidence. Inline, never delegated: the verdict is the product of this loop.

🛑 **Rule: invoke the `fable-judge` skill and read the whole thing before every push** (Martin, 2026-10-14). Checks
and planted regressions alone are not a judgement: on the first overnight run four commits (one of 807 lines) went
out with green checks and plants but no line-by-line read. The judge reads, side by side, the worker's summary
report, its reply file (every verdict and every reply text it wants posted) and the FULL diff, tests and sources:
`judge-pack` prints all three in one file. Then it judges the code itself (repo rules in `.claude/rules/code.md` and
`tools.md`, contracts, duplication, type safety, scope), the claims against the code, and every refusal.

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
   - A plant that stops the COMPILE proves only that the test calls the new code, not that it catches the fault. Plant
     a behaviour fault instead (flip the fail-closed branch, drop the check) and see the assertion fail.
   - Run the new test by its own name (`swift test --filter <Class>/<testName>`, `bun scripts/test.ts <file> -t
     <name>`), never by the file name: on 2026-10-14 `--filter SnapshotDispatchTests` ran 30 tests from that class
     and skipped the new test in `CursorFeedbackTests` in the same file, so a fail-open plant "passed".
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
   - **Every refusal and deferral is judged on its merits.** A `rejected` needs the file:line that disproves the
     finding. A `no-change` or "follow-up" whose fix belongs in this PR (it is small, it is about this PR's change,
     or it is not code at all, like a wrong PR description) is not accepted: do it in this round. On 2026-10-14 a
     worker answered "the PR description calls login-io.ts a new file" with no-change; the fix was a one-line body
     edit.
   - **Removed test lines are guilty until explained.** List them (`judge-pack` puts the test diff first); a deleted
     or loosened assertion must be replaced by a stronger one, or it is a weakened check.
9. **A spy on the logger must read what the logger writes.** `SafeJSON.stringify(spy.mock.calls)` turns an `Error`
   argument into `{}`, so a "the secret is not logged" test passes on the leaking code (2026-10-14, the Grok auth
   reader logged `{ err }`; the first test was green before the fix). Map each argument the way pino does (an Error's
   message, an object's values) before asserting, and plant the old line to prove the test fails.
10. **A plant must remove the whole fix.** When a fix has two parts (a ticket bump AND a guard), planting only one can
   pass because the other still covers it. That proves the test tests the part you left, not that it is weak: plant
   the other part too before you call a test useless (#501 round 1).
11. **Plants run the tests the commit changed.** Plant each fixed source and run the test files the worker's commit
   touched (`git show --stat`), not the source's folder: on 2026-10-14 two plants "passed" only because the folder
   held none of the new tests.
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
