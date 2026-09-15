import { expect, test } from "bun:test";

/**
 * 🛑 TEMPORARY. Planted on 2026-09-15 to prove `scripts/ci/test-runtime-guard.ts` actually
 * fails a CI run, and removed in the very next commit. A guard that has never been watched to
 * catch is worth nothing: this repo has shipped four CI guards that passed while enforcing
 * nothing, because the tool exited 127 and the shell read that as "no matches".
 *
 * 45 seconds. The ceiling is 6% of the run's own summed test time, which measured 31-34 s
 * across five real runs, so this clears it on the slowest runner as well as the fastest. It
 * asserts something true so the test step's own discovery signal stays clean and only the
 * guard turns the job red.
 */
test("PLANTED: a file over the per-file runtime ceiling must fail the guard", async () => {
    await Bun.sleep(45_000);

    expect(true).toBe(true);
}, 90_000);
