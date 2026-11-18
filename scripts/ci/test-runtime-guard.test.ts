import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, completedEmptySelection, formatTopRanking, sourceIsConcurrent } from "./test-runtime-guard";

/** A GitHub Actions log line carries a BOM, a job/step prefix, a timestamp and ANSI. */
function ciLine(text: string): string {
    return `test (ubuntu-latest, 5)\tRun tests (full suite, discovery)\t2026-09-15T00:01:02.3456789Z ${text}`;
}

const SLOW_FILE = [
    "src/slow/thing.test.ts:",
    "(pass) waits > a very slow case [21000.00ms]",
    "(pass) waits > a second case [500.00ms]",
].join("\n");

const FAST_FILE = ["src/fast/thing.test.ts:", "(pass) quick > one [3.00ms]", "(pass) quick > two"].join("\n");

describe("analyze", () => {
    test("sums per-test milliseconds under the file header that precedes them", () => {
        const report = analyze([FAST_FILE, SLOW_FILE].join("\n"));

        expect(report.ranked[0]).toEqual({ file: "src/slow/thing.test.ts", ms: 21500, tests: 2 });
        expect(report.ranked[1]).toEqual({ file: "src/fast/thing.test.ts", ms: 3, tests: 2 });
        expect(report.testLines).toBe(4);
    });

    test("a bracket-less line still counts as a test, so the test count cannot silently drop", () => {
        expect(analyze(FAST_FILE).ranked[0].tests).toBe(2);
    });

    // bun 1.4.2 moved the group marker onto the header line. On the pin probe (CI run
    // 34961144349) that turned an 11,146-test log into zero parsed tests.
    test("reads bun 1.4's header, which carries the ::group:: marker on the same line", () => {
        const log = [
            "::group::src/fast/thing.test.ts:",
            "(pass) quick > one [3.00ms]",
            "::endgroup::",
            "::group::src/slow/thing.test.ts:",
            "(pass) waits > a very slow case [21000.00ms]",
            "::endgroup::",
        ].join("\n");
        const report = analyze(log);

        expect(report.testLines).toBe(2);
        expect(report.ranked[0]).toEqual({ file: "src/slow/thing.test.ts", ms: 21000, tests: 1 });
    });

    test("flags the file over the ceiling and leaves the one under it alone", () => {
        const report = analyze([FAST_FILE, SLOW_FILE].join("\n"), { ceilingMs: 20_000 });

        expect(report.violations.map((row) => row.file)).toEqual(["src/slow/thing.test.ts"]);
        expect(report.exempt).toEqual([]);
    });

    test("a concurrent file over the ceiling is exempt rather than flagged, because the sum overcounts", () => {
        const report = analyze(SLOW_FILE, {
            ceilingMs: 20_000,
            isConcurrent: (file) => file === "src/slow/thing.test.ts",
        });

        expect(report.violations).toEqual([]);
        expect(report.exempt.map((row) => row.file)).toEqual(["src/slow/thing.test.ts"]);
    });

    test("parses a real CI log line through its BOM, job prefix, timestamp and ANSI", () => {
        const report = analyze(
            [
                ciLine("src/slow/thing.test.ts:"),
                ciLine("\x1b[32m(pass)\x1b[0m waits > a very slow case [21000.00ms]"),
            ].join("\n")
        );

        expect(report.ranked).toEqual([{ file: "src/slow/thing.test.ts", ms: 21000, tests: 1 }]);
    });

    test("an empty log reports zero test lines rather than a clean suite", () => {
        const report = analyze("");

        expect(report.testLines).toBe(0);
        expect(report.violations).toEqual([]);
    });

    test("a log with headers but no test lines is also zero, which is the truncation case", () => {
        expect(analyze("src/slow/thing.test.ts:").testLines).toBe(0);
    });

    test("test lines before any file header are ignored rather than attributed to nothing", () => {
        expect(analyze("(pass) orphan [900.00ms]").ranked).toEqual([]);
    });

    test("adds both phase totals, because a full run prints one per phase", () => {
        const report = analyze(
            ["Ran 11275 tests across 1298 files. [274.74s]", "Ran 87 tests across 8 files. [5.48s]"].join("\n")
        );

        expect(report.totalSeconds).toBeCloseTo(280.22, 2);
    });

    test("reads a millisecond suite total as milliseconds, not seconds", () => {
        expect(analyze("Ran 1 tests across 1 files. [105.00ms]").totalSeconds).toBeCloseTo(0.105, 3);
    });

    test("a group terminator ends attribution, so the failure summary is not glued onto the last file", () => {
        // The real shape of CI run 34908819029: a file's group closes, then bun reprints its
        // failures with no header, then the serial phase runs with no groups at all. Without a
        // terminator all of that landed on legacy-cache.test.ts — 85 tests and 23.49 s for a
        // file that has 17 tests and costs 2.67 s.
        const report = analyze(
            [
                "src/fast/thing.test.ts:",
                "(pass) quick > one [3.00ms]",
                "##[endgroup]",
                "",
                "(fail) some other file > a slow case reprinted in the summary [30000.00ms]",
                "Ran 2 tests across 2 files. [1.00s]",
                "(pass) serial phase > a case with no group at all [9000.00ms]",
            ].join("\n")
        );

        expect(report.ranked).toEqual([{ file: "src/fast/thing.test.ts", ms: 3, tests: 1 }]);
    });

    test("::endgroup:: ends a block too, since a raw step log is not post-processed", () => {
        const report = analyze(
            [
                "src/fast/thing.test.ts:",
                "(pass) quick > one [3.00ms]",
                "::endgroup::",
                "(fail) stray > not this file's [50000.00ms]",
            ].join("\n")
        );

        expect(report.ranked).toEqual([{ file: "src/fast/thing.test.ts", ms: 3, tests: 1 }]);
    });

    test("a suite total closes the block AND is still read as the total", () => {
        const report = analyze(
            ["src/fast/thing.test.ts:", "(pass) quick > one [3.00ms]", "Ran 1 test across 1 file. [2.00s]"].join("\n")
        );

        expect(report.totalSeconds).toBe(2);
        expect(report.ranked).toEqual([{ file: "src/fast/thing.test.ts", ms: 3, tests: 1 }]);
    });

    test("a fail line counts toward its file, so a slow failing test cannot hide", () => {
        const report = analyze(["src/slow/thing.test.ts:", "(fail) waits > broken and slow [30000.00ms]"].join("\n"));

        expect(report.ranked[0]).toEqual({ file: "src/slow/thing.test.ts", ms: 30000, tests: 1 });
    });
});

describe("--top ranking", () => {
    const GROUPED = [
        "::group::src/foo.test.ts:",
        "(pass) case > one [1500.00ms]",
        "::endgroup::",
        "::group::src/bar.test.ts:",
        "(pass) case > two [100.00ms]",
        "::endgroup::",
    ].join("\n");

    test("a bun 1.4 ::group:: log produces a non-empty ranking", () => {
        const report = analyze(GROUPED);
        const top = formatTopRanking(report.ranked);

        expect(report.ranked.length).toBeGreaterThan(0);
        expect(top).toContain("src/foo.test.ts");
        expect(top).toMatch(/1\.5s/);
        expect(top).toContain("Slowest 25 test files");
        expect(top).not.toMatch(/^\s*$/);
    });

    test("the heading names the limit it was given", () => {
        const top = formatTopRanking(analyze(GROUPED).ranked, 1);

        expect(top).toContain("Slowest 1 test files");
        expect(top).toContain("src/foo.test.ts");
        expect(top).not.toContain("src/bar.test.ts");
    });

    test("the CLI --top path prints that ranking for a ::group:: log", async () => {
        const dir = mkdtempSync(join(tmpdir(), "runtime-guard-top-"));
        const logPath = join(dir, "test.log");
        writeFileSync(logPath, GROUPED);

        const proc = Bun.spawn(["bun", join(import.meta.dir, "test-runtime-guard.ts"), logPath, "--top"], {
            stdout: "pipe",
            stderr: "pipe",
            env: process.env,
        });
        const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

        expect(code).toBe(0);
        expect(out).toContain("src/foo.test.ts");
        expect(out).toMatch(/1\.5s/);
        expect(out).toContain("src/bar.test.ts");
    });
});

describe("an affected run that selected no tests", () => {
    /** Written by `bun run test --changed=HEAD --pass-with-no-tests` on a clean tree, 2026-11-18. */
    const EMPTY = [
        "bun test v1.4.2 (744846f84)",
        "--changed: no changed files, nothing to run",
        "",
        " 0 pass",
        " 0 fail",
        "Ran 0 tests across 0 files. [108.00ms]",
        "\u001b[90m[test] own-process phase 2/2: src/chrome-devtools/lib/headless.test.ts\u001b[0m",
        "Ran 0 tests across 0 files. [106.00ms]",
        "[test] phase exits: parallel 0, serial 0",
        "[test] suite complete (exit 0)",
    ];

    test("passes only when the runner completed and every summary ran zero tests", () => {
        expect(completedEmptySelection(EMPTY.join("\n"))).toBe(true);
        expect(completedEmptySelection(EMPTY.map(ciLine).join("\n"))).toBe(true);
        expect(completedEmptySelection(EMPTY.slice(0, -1).join("\n"))).toBe(false);
        expect(
            completedEmptySelection(
                EMPTY.join("\n").replace("Ran 0 tests across 0 files. [106", "Ran 3 tests across 1 files. [106")
            )
        ).toBe(false);
        expect(completedEmptySelection(EMPTY.join("\n").replace("(exit 0)", "(exit 1)"))).toBe(false);
        expect(completedEmptySelection("[test] suite complete (exit 0)\n")).toBe(false);
    });

    test("the CLI exits 0 on it and still exits 1 on a log cut before the marker", async () => {
        const dir = mkdtempSync(join(tmpdir(), "runtime-guard-empty-"));
        const guard = async (log: string) => {
            const logPath = join(dir, "test.log");
            writeFileSync(logPath, log);
            const proc = Bun.spawn(["bun", join(import.meta.dir, "test-runtime-guard.ts"), logPath], {
                stdout: "pipe",
                stderr: "pipe",
                env: process.env,
            });
            return await proc.exited;
        };

        expect(await guard(EMPTY.join("\n"))).toBe(0);
        expect(await guard(EMPTY.slice(0, -1).join("\n"))).toBe(1);
    });
});

describe("the ceiling is a share of the run, not a fixed number of seconds", () => {
    /** `count` files of `each` ms, so the summed total and one file's share are both exact. */
    function suite(count: number, each: number, hogMs: number): string {
        const lines: string[] = [];

        for (let i = 0; i < count; i++) {
            lines.push(`src/f${i}/a.test.ts:`, `(pass) case [${each.toFixed(2)}ms]`, "##[endgroup]");
        }

        lines.push("src/hog/a.test.ts:", `(pass) hog [${hogMs.toFixed(2)}ms]`, "##[endgroup]");

        return lines.join("\n");
    }

    test("the same code passes on a fast runner and on a 30% slower one", () => {
        // The defect this replaces: merged.test.ts measured 20.0 s, 24.4 s and 26.5 s on three
        // runs of the IDENTICAL tree e9a55d657, so a fixed 25 s ceiling reddened one of them.
        const fast = analyze(suite(100, 5_000, 20_000));
        const slow = analyze(suite(100, 6_500, 26_000));

        expect(fast.violations).toEqual([]);
        expect(slow.violations).toEqual([]);
        // The ceiling moved with the runner; the verdict did not.
        expect(slow.ceilingMs).toBeGreaterThan(fast.ceilingMs);
    });

    test("a file that really does take a bigger share is still caught on either runner", () => {
        const fast = analyze(suite(100, 5_000, 60_000));
        const slow = analyze(suite(100, 6_500, 78_000));

        expect(fast.violations.map((row) => row.file)).toEqual(["src/hog/a.test.ts"]);
        expect(slow.violations.map((row) => row.file)).toEqual(["src/hog/a.test.ts"]);
    });

    test("the floor stops a tiny suite from tightening the ceiling to nothing", () => {
        // 6% of 10 s is 600 ms; without the floor a 1 s test would be a violation.
        const report = analyze(suite(10, 1_000, 1_000));

        expect(report.ceilingMs).toBe(20_000);
        expect(report.violations).toEqual([]);
    });

    test("an explicit --ceiling-ms still wins, so one number can be pinned for a bisect", () => {
        const report = analyze(suite(100, 5_000, 26_000), { ceilingMs: 25_000 });

        expect(report.ceilingMs).toBe(25_000);
        expect(report.violations.map((row) => row.file)).toEqual(["src/hog/a.test.ts"]);
    });

    test("summedMs is every file's time, which is what the share is taken of", () => {
        const report = analyze(suite(4, 1_000, 2_000));

        expect(report.summedMs).toBe(6_000);
    });
});

describe("sourceIsConcurrent", () => {
    function withSource(body: string): boolean {
        const dir = mkdtempSync(join(tmpdir(), "runtime-guard-src-"));
        writeFileSync(join(dir, "probe.test.ts"), body);

        return sourceIsConcurrent("probe.test.ts", dir);
    }

    test.each([
        ['test.concurrent("a", () => {});', true],
        ['describe.concurrent("a", () => {});', true],
        ['it.concurrent("a", () => {});', true],
        ['test.concurrent.each([1])("a", () => {});', true],
        ['    test.concurrent("indented", () => {});', true],
    ])("a real call site earns the exemption: %s", (source, expected) => {
        expect(withSource(source)).toBe(expected);
    });

    test.each([
        ['// explains why this file is NOT test.concurrent\ntest("a", () => {});', false],
        ['/** Overlapping them with `test.concurrent` turned it red on CI. */\ntest("a", () => {});', false],
        ['const label = "test.concurrent";\ntest("a", () => {});', false],
        ['test("a", () => {});', false],
    ])("a mention in prose or a string does NOT: %s", (source, expected) => {
        expect(withSource(source)).toBe(expected);
    });

    test("a file the checkout does not have is guarded rather than exempted", () => {
        expect(sourceIsConcurrent("nope/missing.test.ts", tmpdir())).toBe(false);
    });

    // The exemption is per-FILE, so one concurrent call must not cover a sequential neighbour.
    test("a MIXED file is not exempt, because the sequential test would bypass the ceiling", () => {
        const source = ['test.concurrent("overlaps", () => {});', 'test("slow and sequential", () => {});'].join("\n");

        expect(withSource(source)).toBe(false);
    });

    test("a concurrent suite wrapping plain inner tests stays exempt, since those do overlap", () => {
        const source = ['describe.concurrent("suite", () => {', '    it("inner", () => {});', "});"].join("\n");

        expect(withSource(source)).toBe(true);
    });
});
