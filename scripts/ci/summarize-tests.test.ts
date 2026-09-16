import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skip } from "@genesiscz/utils/test/skip";

const SCRIPT = join(import.meta.dir, "summarize-tests.sh");

/**
 * The step that consumes this script declares `shell: bash`, which GitHub Actions runs as
 * `bash --noprofile --norc -eo pipefail {0}`. Reproduce that exactly: the defect this suite
 * exists for is invisible under a plain `bash script.sh`, because it needs `-e` AND
 * `pipefail` together to fire.
 */
async function summarize(log: string | null, os = "Linux"): Promise<{ code: number; out: string }> {
    const dir = mkdtempSync(join(tmpdir(), "gt-summarize-"));
    const logPath = join(dir, `test-${os}.log`);

    if (log !== null) {
        writeFileSync(logPath, log);
    }

    const proc = Bun.spawn(
        ["bash", "--noprofile", "--norc", "-eo", "pipefail", SCRIPT, logPath, os, "success", "success"],
        {
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
        }
    );
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    return { code, out };
}

/** A log the way bun writes one: `(pass) name [N.NNms]`, plus the duplicate failure summary. */
const GREEN_LOG = [
    "(pass) alpha > adds [1.00ms]",
    "(pass) beta > subtracts [2.00ms]",
    "Ran 2 tests across 1 file.",
].join("\n");

const RED_LOG = [
    "(pass) alpha > adds [1.00ms]",
    "(fail) gamma > explodes [3.00ms]",
    "(fail) delta > also explodes [4.00ms]",
    // bun prints each failure a second time in its trailing summary, without the timing.
    "(fail) gamma > explodes",
    "(fail) delta > also explodes",
].join("\n");

/**
 * The Windows runner reaches the script through Git Bash, which does read it — but this
 * harness hands it a native `C:\…` path, and backslash handling across that boundary is a
 * property of the harness, not of the logic under test. The branching being pinned here is
 * platform-independent text processing, so gate the suite rather than assert on MSYS path
 * translation.
 */
describe.skipIf(skip.onWindows)("summarize-tests.sh", () => {
    /**
     * 🛑 THE REGRESSION THIS FILE EXISTS FOR.
     *
     * A fully green suite has zero `(fail)` lines, so `grep '(fail)'` exits 1. Under
     * `pipefail` that is the pipeline's status, and under `-e` a failing command
     * substitution aborts the script at the FIRST assignment — before a single byte
     * reaches the job summary. The step now has `continue-on-error: true`, so a
     * green abort would no longer redden the job, but the script must still survive
     * `-eo pipefail` or the summary is empty — the same false green.
     */
    test("a clean log exits 0 and reports zero failures", async () => {
        const { code, out } = await summarize(GREEN_LOG);

        expect(code).toBe(0);
        expect(out).toContain("0 failing tests");
        expect(out).toContain("`2` `(pass)` lines");
        expect(out).not.toContain("LOG UNREADABLE");
    });

    test("failures are counted, deduplicated and listed", async () => {
        const { code, out } = await summarize(RED_LOG);

        expect(code).toBe(0);
        // 4 raw `(fail)` lines, 2 distinct tests once the `[N ms]` suffix is stripped.
        expect(out).toContain("2 FAILING TESTS");
        expect(out).toContain("`4` raw, `2` distinct");
        expect(out).toContain("(fail) gamma > explodes");
    });

    test("an all-failing log lists the failures, not LOG UNREADABLE", async () => {
        const { code, out } = await summarize("(fail) gamma > explodes [3.00ms]\n(fail) gamma > explodes");

        expect(code).toBe(0);
        expect(out).toContain("1 FAILING TESTS");
        expect(out).not.toContain("LOG UNREADABLE");
    });

    /**
     * The positive control. Zero `(pass)` AND zero `(fail)` lines means the instrument
     * failed, and saying "0 failing tests" there is the exact false green the whole
     * step exists to prevent. Each of these aborted before the `if` under the original
     * inline version, so the banner could never be printed.
     */
    test("a missing log reports LOG UNREADABLE, not success", async () => {
        const { code, out } = await summarize(null);

        expect(code).toBe(0);
        expect(out).toContain("LOG UNREADABLE");
        expect(out).not.toContain("0 failing tests");
    });

    test("an empty log reports LOG UNREADABLE, not success", async () => {
        const { code, out } = await summarize("");

        expect(code).toBe(0);
        expect(out).toContain("LOG UNREADABLE");
        expect(out).not.toContain("0 failing tests");
    });

    test("a log that is a directory reports LOG UNREADABLE, not success", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-summarize-dir-"));
        const logPath = join(dir, "test-Linux.log");
        mkdirSync(logPath);

        const proc = Bun.spawn(
            ["bash", "--noprofile", "--norc", "-eo", "pipefail", SCRIPT, logPath, "Linux", "success", "success"],
            { env: process.env, stdout: "pipe", stderr: "pipe" }
        );
        const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

        expect(code).toBe(0);
        expect(out).toContain("LOG UNREADABLE");
        expect(out).not.toContain("0 failing tests");
    });

    /** A path with a space must survive every expansion, or the counts silently describe nothing. */
    test("a log path containing a space is read, not split", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-summarize-"));
        const spaced = join(dir, "test Linux run.log");
        writeFileSync(spaced, GREEN_LOG);

        const proc = Bun.spawn(
            ["bash", "--noprofile", "--norc", "-eo", "pipefail", SCRIPT, spaced, "Linux", "success", "success"],
            { env: process.env, stdout: "pipe", stderr: "pipe" }
        );
        const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

        expect(code).toBe(0);
        expect(out).toContain("0 failing tests");
        expect(out).toContain("`2` `(pass)` lines");
    });

    /**
     * `head` closes the pipe once it has 40 lines, which hands `sort` an EPIPE. Under
     * `pipefail` that becomes the pipeline's status. This is not hypothetical in this
     * workflow: the neighbouring "Slowest test files" step went red on its first real run
     * (34373807424) for exactly this, and carries a comment saying so.
     */
    test("more than 40 distinct failures truncates the list instead of aborting", async () => {
        const many = Array.from({ length: 57 }, (_, i) => `(fail) suite > case ${i} [1.00ms]`);
        const { code, out } = await summarize(["(pass) alpha > adds [1.00ms]", ...many].join("\n"));

        expect(code).toBe(0);
        expect(out).toContain("57 FAILING TESTS");
        expect(out).toContain("_(showing 40 of 57)_");
        expect(out).toContain("`57` raw, `57` distinct");
    });

    /**
     * The volume that actually fires it. `head` closing after 40 lines only hands `sort` an
     * EPIPE once the remaining output no longer fits the 64 KB pipe buffer, so a few dozen
     * short failures pass either way — 57 of them did, with the guard removed. This is the
     * same defect that reddened the neighbouring "Slowest test files" step on its first real
     * run (34373807424), which is why that step carries a `no head after sort` comment.
     */
    test("a failure list far past the pipe buffer still truncates instead of aborting", async () => {
        const padding = "x".repeat(120);
        const many = Array.from({ length: 4000 }, (_, i) => `(fail) suite > case ${i} ${padding} [1.00ms]`);
        const { code, out } = await summarize(["(pass) alpha > adds [1.00ms]", ...many].join("\n"));

        expect(code).toBe(0);
        expect(out).toContain("4000 FAILING TESTS");
        expect(out).toContain("_(showing 40 of 4000)_");
    });

    test("the step outcomes are echoed verbatim", async () => {
        const { out } = await summarize(GREEN_LOG);

        expect(out).toContain("- install step outcome: `success`");
        expect(out).toContain("- tests step outcome: `success`");
    });
});
