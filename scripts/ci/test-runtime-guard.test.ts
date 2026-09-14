import { describe, expect, test } from "bun:test";
import { analyze } from "./test-runtime-guard";

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

    test("a fail line counts toward its file, so a slow failing test cannot hide", () => {
        const report = analyze(["src/slow/thing.test.ts:", "(fail) waits > broken and slow [30000.00ms]"].join("\n"));

        expect(report.ranked[0]).toEqual({ file: "src/slow/thing.test.ts", ms: 30000, tests: 1 });
    });
});
