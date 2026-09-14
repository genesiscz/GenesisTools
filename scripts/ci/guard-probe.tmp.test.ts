import { expect, test } from "bun:test";

/**
 * 🛑 TEMPORARY. Planted on 2026-09-15 to prove `scripts/ci/test-runtime-guard.ts` actually
 * fails a CI run, and removed in the very next commit. A guard that has never been watched
 * to catch is worth nothing: this repo has shipped four CI guards that passed while
 * enforcing nothing, because the tool exited 127 and the shell read that as "no matches".
 *
 * 26 seconds, against a 25 second per-file ceiling. It asserts something true so that the
 * test step's own discovery signal stays clean and only the guard turns the job red.
 */
test("PLANTED: a file over the per-file runtime ceiling must fail the guard", async () => {
    await Bun.sleep(26_000);

    expect(true).toBe(true);
}, 40_000);
