#!/usr/bin/env bun
/**
 * Per-file runtime ceiling for the discovery suite, read from the log CI already writes.
 *
 * Why this exists: the ubuntu test step is a fixed budget, and the suite twice grew into it
 * without anyone noticing. Seven runs measured 241-260 s against a 240 s limit, so the same
 * tree passed or failed by luck, and a budget kill surfaces as the completion-marker guard
 * reporting a HANG that never happened. Raising the budget a third time is not an answer;
 * noticing the file that ate it is.
 *
 * The metric is the SUM of bun's own per-test brackets under each file header. That is a
 * ranking, not a wall clock: module import and beforeAll/afterAll sit outside the brackets,
 * so a file that is slow purely because it imports a heavy tree scores low here. It is still
 * the right metric for this guard, because the thing worth catching is a test that WAITS —
 * a real sleep, a poll interval, a process spawn in a loop — and that time lands inside the
 * bracket. `bun run test --profile` measures the other half.
 *
 * Concurrent files are exempt and say so. Under `describe.concurrent` every overlapping test
 * reports the whole overlap, so the sum counts the same seconds once per test:
 * src/mcp-doctor/unknown-tool.contract.test.ts sums to 19.7 s on CI and measures 2.2 s of
 * real wall time. Exempting by reading the source rather than by an allowlist means a file
 * that later drops `.concurrent` is guarded again with no list to update.
 *
 * Exit codes are load-bearing: 0 clean, 1 violation or unreadable log, and NOTHING else.
 * A crash is caught and reported as exit 1 rather than escaping as 7 or 127, because this
 * repo has shipped four CI guards that "passed" while enforcing nothing (`rg` exited 127 on
 * the runner and the shell read that as "no matches"). The caller must still treat any exit
 * above 1 as a broken scan.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripAnsi } from "@genesiscz/utils/string";

/**
 * The share of the run's OWN summed test time that one file may hold.
 *
 * Relative, because an absolute ceiling measures the runner rather than the code. On three
 * runs of the identical tree e9a55d657, merged.test.ts measured 20.0 s, 24.4 s and 26.5 s and
 * the whole step measured 242.2 s, 267.3 s and 269.2 s — GitHub's hosted runners vary by about
 * 30%, so a fixed 25 s ceiling reddened one of the three and passed the other two for reasons
 * that had nothing to do with the tests. A share cancels that: when the runner is slow every
 * file is slow together.
 *
 * 6% of the suite's summed per-test time. Today that is ~30 s against ~508 s summed, and the
 * top three files sit at 5.2%, 3.1% and 2.7%. Lower it as they come down; never raise it to
 * make a red run green, which is the failure this guard exists to stop.
 */
const DEFAULT_CEILING_SHARE = 0.06;

/**
 * The floor under that share, so a suite that shrinks does not tighten the ceiling to nothing
 * and start failing on files nobody would call slow.
 */
const MIN_CEILING_MS = 20_000;

/**
 * Suite total above which the run is reported as approaching its budget. A warning, never a
 * failure: the step budget is 300 s, and a run that crosses this is still green but is the
 * last warning before the budget starts killing jobs at random.
 */
const DEFAULT_WARN_TOTAL_S = 240;

/**
 * The optional `::group::` is not cosmetic: bun moved the marker ONTO the header line.
 *
 * bun 1.3.13 printed the group marker and the path as two lines, so a bare `src/…test.ts:`
 * opened the block. bun 1.4.2 prints one line, `::group::src/…test.ts:`. Measured on the
 * 1.4.2 pin probe (run 34961144349): the log held 11,146 `(pass)` lines and ZERO lines this
 * pattern matched, so no block ever opened and the guard counted nothing. It reported that
 * instead of passing, which is the whole point of the zero-lines control below — but a guard
 * that stops enforcing on a runtime upgrade should read both shapes rather than rely on its
 * own alarm.
 */
const FILE_HEADER = /^(?:::group::)?((?:src|scripts|apps|plugins|native|DevDashboard)\/.*\.test\.tsx?):$/;
/**
 * Where a file's block ENDS, and the difference between a guard and a liar.
 *
 * bun's GitHub reporter opens a group per file and closes it, but the run does not end there:
 * the failure summary reprints every failing test with no header, and `scripts/test.ts` then
 * starts a SECOND bun process for the load-sensitive files whose output carries no groups at
 * all. Attributing on the header alone glued all of that onto whichever file happened to print
 * last. Measured on CI run 34908819029: legacy-cache.test.ts was reported at 23.49 s over 85
 * tests when it has 17 tests and costs 2.67 s, and the 85 names were watcher, disk-usage and
 * capture-install cases. The guard would have sent someone to optimise an innocent file.
 */
const BLOCK_END = /^(?:##\[endgroup\]|::endgroup::|Ran \d+ tests? across \d+ files?\.)/;
const TEST_LINE = /^\((pass|fail)\)/;
const BRACKET_MS = /\[(\d+(?:\.\d+)?)ms\]$/;
// `tests?` and `files?`: bun says "Ran 1 test across 1 file." in the singular, and a regex that
// only knew the plural read a one-file phase as having no total at all.
const SUITE_TOTAL = /^Ran \d+ tests? across \d+ files?\. \[(\d+(?:\.\d+)?)(ms|s)\]$/;
/**
 * A CALL SITE, not a mention, anchored to the start of its own line.
 *
 * The trailing `(` matters: this very repo has a file whose comment explains why it is NOT
 * `test.concurrent`, and a word-boundary match handed it the exemption — the guard then excused
 * a 29.9 s file for a property its source denies having. Anchoring to `^\s*` covers the rest of
 * that family for free: `const label = "test.concurrent";`, a `//` comment and a ` * ` jsdoc line
 * all fail to match, because none of them BEGINS with the call.
 *
 * Group 1 is the leading indentation and group 2 the method chain, because the exemption rule
 * below needs both.
 */
const SUITE_CALL = /^([ \t]*)(?:describe|test|it)((?:\.[A-Za-z_$][\w$]*)*)\s*\(/gm;

export interface GuardReport {
    /** Summed per-test ms per file, highest first. */
    ranked: Array<{ file: string; ms: number; tests: number }>;
    /** Files over the ceiling that are not exempt. */
    violations: Array<{ file: string; ms: number; tests: number }>;
    /** Files over the ceiling whose source runs tests concurrently, so the sum overcounts. */
    exempt: Array<{ file: string; ms: number; tests: number }>;
    /** `(pass)`/`(fail)` lines parsed. Zero means the log is unreadable, not that the suite is fast. */
    testLines: number;
    /** The ceiling the run resolved to, so the report can say what a file was measured against. */
    ceilingMs: number;
    /** Summed per-test ms across every file, which the relative ceiling is a share of. */
    summedMs: number;
    /** The suite's own reported total, in seconds, when the log carries one. */
    totalSeconds: number | null;
}

/** ANSI, a GitHub Actions timestamp prefix and a `job\tstep\t` prefix all appear in real logs. */
function clean(line: string): string {
    const afterTab = line.includes("\t") ? line.slice(line.lastIndexOf("\t") + 1) : line;

    return stripAnsi(afterTab)
        .replace(/^﻿/, "")
        .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, "")
        .replace(/\r$/, "");
}

export function analyze(
    log: string,
    options: { ceilingShare?: number; ceilingMs?: number; isConcurrent?: (file: string) => boolean } = {}
): GuardReport {
    const isConcurrent = options.isConcurrent ?? (() => false);
    const ms = new Map<string, number>();
    const tests = new Map<string, number>();
    let current: string | null = null;
    let testLines = 0;
    let totalSeconds: number | null = null;

    for (const raw of log.split("\n")) {
        const line = clean(raw);
        const header = FILE_HEADER.exec(line);

        if (header) {
            current = header[1];
            continue;
        }

        if (BLOCK_END.test(line)) {
            current = null;
            // Not `continue`: the suite total below is one of the lines that closes a block,
            // and it still has to be read.
        }

        const total = SUITE_TOTAL.exec(line);

        if (total) {
            const value = Number(total[1]);
            const seconds = total[2] === "s" ? value : value / 1000;
            // Two phases each print one; the budget cares about their sum.
            totalSeconds = (totalSeconds ?? 0) + seconds;
            continue;
        }

        if (current === null || !TEST_LINE.test(line)) {
            continue;
        }

        testLines++;
        const bracket = BRACKET_MS.exec(line);
        ms.set(current, (ms.get(current) ?? 0) + (bracket ? Number(bracket[1]) : 0));
        tests.set(current, (tests.get(current) ?? 0) + 1);
    }

    const ranked = [...ms.entries()]
        .map(([file, value]) => ({ file, ms: value, tests: tests.get(file) ?? 0 }))
        .sort((a, b) => b.ms - a.ms);
    const summedMs = ranked.reduce((sum, row) => sum + row.ms, 0);
    // An explicit --ceiling-ms still wins, so a bisect can pin one number; otherwise the
    // ceiling is a share of what this same run measured.
    const share = options.ceilingShare ?? DEFAULT_CEILING_SHARE;
    const ceiling = options.ceilingMs ?? Math.max(MIN_CEILING_MS, Math.round(summedMs * share));
    const over = ranked.filter((row) => row.ms > ceiling);

    return {
        ranked,
        violations: over.filter((row) => !isConcurrent(row.file)),
        exempt: over.filter((row) => isConcurrent(row.file)),
        testLines,
        totalSeconds,
        ceilingMs: ceiling,
        summedMs,
    };
}

/**
 * Say which rule produced the ceiling, because two of the three read the same otherwise.
 *
 * The effective ceiling is `max(MIN_CEILING_MS, summed * share)`, so for any suite under about
 * 333 s summed the FLOOR wins. Labelling that as "6% of 10s summed" states something false —
 * 6% of 10 s is 0.6 s, not 20 s — and points whoever reads a failing run at the wrong number.
 * Worst on the unreadable-log path, where it would read "20s (6% of 0s summed)".
 */
function describeCeiling(report: GuardReport, explicitMs: number | undefined): string {
    if (explicitMs !== undefined) {
        return "(fixed)";
    }

    const share = Math.round(report.summedMs * DEFAULT_CEILING_SHARE);

    if (share <= MIN_CEILING_MS) {
        return `(floor; ${(DEFAULT_CEILING_SHARE * 100).toFixed(0)}% of ${(report.summedMs / 1000).toFixed(0)}s summed would be ${(share / 1000).toFixed(1)}s)`;
    }

    return `(${(DEFAULT_CEILING_SHARE * 100).toFixed(0)}% of ${(report.summedMs / 1000).toFixed(0)}s summed)`;
}

/** The ranking the CI "Slowest test files" step prints. Same parser as the ceiling guard. */
export function formatTopRanking(ranked: Array<{ file: string; ms: number; tests: number }>, limit = 25): string {
    const lines = [`Slowest ${limit} test files — sum of per-test ms under each file header`];

    for (const row of ranked.slice(0, limit)) {
        const tests = row.tests === 1 ? "1" : String(row.tests);
        lines.push(`${(row.ms / 1000).toFixed(1).padStart(9)}s ${tests.padStart(5)}  ${row.file}`);
    }

    return `${lines.join("\n")}\n`;
}

/**
 * True when the WHOLE file runs concurrently, which is what makes the summed metric overcount.
 *
 * "Any `.concurrent` anywhere" was too generous: one concurrent test beside one genuinely slow
 * sequential test exempted the file total, so the slow test bypassed the ceiling entirely. The
 * invariant is now per-file and explicit — **every call site at the file's OUTERMOST indentation
 * must be `.concurrent`**.
 *
 * Outermost rather than column zero, because `describe.concurrent(…)` legitimately wraps plain
 * `it(…)` calls and those inner tests DO run concurrently: the repo's own exempt file,
 * src/mcp-doctor/unknown-tool.contract.test.ts, is exactly that shape. Judging the outer layer
 * asks the right question — did the file opt the whole thing in, or only part of it.
 */
export function sourceIsConcurrent(file: string, root: string): boolean {
    const path = resolve(root, file);

    if (!existsSync(path)) {
        // A log naming a file this checkout does not have is not an exemption. Guard it.
        return false;
    }

    const calls = [...readFileSync(path, "utf8").matchAll(SUITE_CALL)].map((match) => ({
        indent: match[1].length,
        chain: match[2],
    }));

    if (calls.length === 0) {
        return false;
    }

    const outermost = Math.min(...calls.map((call) => call.indent));

    return calls.filter((call) => call.indent === outermost).every((call) => call.chain.includes(".concurrent"));
}

function main(argv: string[]): number {
    const positional = argv.filter((arg) => !arg.startsWith("-"));
    const logPath = positional[0];

    if (!logPath) {
        process.stderr.write("usage: bun scripts/ci/test-runtime-guard.ts <test-log> [--ceiling-ms N] [--top]\n");
        return 1;
    }

    if (!existsSync(logPath)) {
        process.stderr.write(`test-runtime-guard: ${logPath} does not exist — nothing was scanned.\n`);
        return 1;
    }

    const ceilingIndex = argv.indexOf("--ceiling-ms");
    const requested = ceilingIndex === -1 ? Number.NaN : Number(argv[ceilingIndex + 1]);
    const ceilingMs = Number.isFinite(requested) && requested > 0 ? requested : undefined;
    const warnIndex = argv.indexOf("--warn-total-seconds");
    const requestedWarn = warnIndex === -1 ? Number.NaN : Number(argv[warnIndex + 1]);
    const warnTotal = Number.isFinite(requestedWarn) && requestedWarn > 0 ? requestedWarn : DEFAULT_WARN_TOTAL_S;
    const root = resolve(import.meta.dir, "..", "..");
    const report = analyze(readFileSync(logPath, "utf8"), {
        ceilingMs,
        isConcurrent: (file) => sourceIsConcurrent(file, root),
    });
    const ceilingLabel = `${(report.ceilingMs / 1000).toFixed(0)}s ${describeCeiling(report, ceilingMs)}`;

    // The positive control, and the reason this is not `if (violations.length === 0) pass`.
    // A log that was truncated, never written, or written by a step that died reports zero
    // slow files, which is indistinguishable from a clean suite without this check.
    if (report.testLines === 0) {
        if (argv.includes("--top")) {
            process.stdout.write("test-runtime-guard: log holds zero (pass)/(fail) lines — ranking unavailable\n");
        }

        process.stderr.write(
            `::error::test-runtime-guard: ${logPath} holds zero (pass)/(fail) lines. ` +
                "The log is missing or truncated, so a clean result here would be the instrument failing, " +
                "not the suite passing.\n"
        );
        return 1;
    }

    // Summary-only path: print the ranking and stop. The ceiling step invokes this
    // script without --top; mixing ::error:: into the step-summary fence would look
    // like "nothing slow" if the parser died, which is the defect --top exists to kill.
    if (argv.includes("--top")) {
        process.stdout.write(formatTopRanking(report.ranked));
        return 0;
    }

    if (report.totalSeconds !== null && report.totalSeconds > warnTotal) {
        process.stderr.write(
            `::warning::the suite reported ${report.totalSeconds.toFixed(1)}s, over the ${warnTotal}s ` +
                "early-warning line. The step budget is 300s; past this the budget starts killing runs at random.\n"
        );
    }

    for (const row of report.exempt) {
        process.stderr.write(
            `test-runtime-guard: ${row.file} sums to ${(row.ms / 1000).toFixed(1)}s over ${row.tests} tests, ` +
                "exempt because it runs them concurrently and the sum counts the same seconds once per test.\n"
        );
    }

    if (report.violations.length === 0) {
        process.stderr.write(
            `test-runtime-guard: ${report.ranked.length} files, ${report.testLines} tests, ` +
                `slowest ${(report.ranked[0].ms / 1000).toFixed(1)}s (${report.ranked[0].file}), ` +
                `ceiling ${ceilingLabel} — clean.\n`
        );
        return 0;
    }

    process.stderr.write(
        `::error::test-runtime-guard: ${report.violations.length} file(s) over the ${ceilingLabel} ` +
            "per-file ceiling. Make the test cheap rather than raising the ceiling; the step budget is fixed.\n"
    );

    for (const row of report.violations) {
        const tests = row.tests === 1 ? "1 test " : `${row.tests} tests`;
        process.stderr.write(`  ${(row.ms / 1000).toFixed(1)}s  ${tests}  ${row.file}\n`);
    }

    return 1;
}

if (import.meta.main) {
    try {
        process.exit(main(process.argv.slice(2)));
    } catch (err) {
        // Never let a crash escape as an exit code above 1: a caller that only tests for 1
        // would read 7 or 127 as something other than a failure, which is exactly how four
        // earlier guards in this repo passed while enforcing nothing.
        process.stderr.write(`::error::test-runtime-guard crashed, so nothing was enforced: ${String(err)}\n`);
        process.exit(1);
    }
}
