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
 * Summed per-test milliseconds a single file may spend before the guard fails.
 *
 * Set from measurement, not from a round number. After the 2026-09-15 trim the slowest file
 * on ubuntu is merged.test.ts at 21.3 s (run 34910083066), followed by cascade at 15.6 s and
 * baseline-oracle at 13.8 s. 25 s therefore sits just above today's worst while still refusing
 * any file that grows past a twelfth of the 300 s step budget. Lower it as the top files come
 * down; never raise it to make a red run green, which is the failure this guard exists to stop.
 */
const DEFAULT_CEILING_MS = 25_000;

/**
 * Suite total above which the run is reported as approaching its budget. A warning, never a
 * failure: the step budget is 300 s, and a run that crosses this is still green but is the
 * last warning before the budget starts killing jobs at random.
 */
const DEFAULT_WARN_TOTAL_S = 240;

const FILE_HEADER = /^((?:src|scripts|apps|plugins|native|DevDashboard)\/.*\.test\.tsx?):$/;
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
 * A CALL SITE, not a mention. The trailing `(` matters: this very repo has a file whose comment
 * explains why it is NOT `test.concurrent`, and a word-boundary match handed it the exemption —
 * the guard then excused a 29.9 s file for a property its source denies having.
 */
const CONCURRENT = /(?:^|[\s;}])(?:describe|test|it)\.concurrent[.(]/m;

export interface GuardReport {
    /** Summed per-test ms per file, highest first. */
    ranked: Array<{ file: string; ms: number; tests: number }>;
    /** Files over the ceiling that are not exempt. */
    violations: Array<{ file: string; ms: number; tests: number }>;
    /** Files over the ceiling whose source runs tests concurrently, so the sum overcounts. */
    exempt: Array<{ file: string; ms: number; tests: number }>;
    /** `(pass)`/`(fail)` lines parsed. Zero means the log is unreadable, not that the suite is fast. */
    testLines: number;
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
    options: { ceilingMs?: number; isConcurrent?: (file: string) => boolean } = {}
): GuardReport {
    const ceiling = options.ceilingMs ?? DEFAULT_CEILING_MS;
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
    const over = ranked.filter((row) => row.ms > ceiling);

    return {
        ranked,
        violations: over.filter((row) => !isConcurrent(row.file)),
        exempt: over.filter((row) => isConcurrent(row.file)),
        testLines,
        totalSeconds,
    };
}

/** True when the file runs its tests concurrently, which makes the summed metric overcount. */
export function sourceIsConcurrent(file: string, root: string): boolean {
    const path = resolve(root, file);

    if (!existsSync(path)) {
        // A log naming a file this checkout does not have is not an exemption. Guard it.
        return false;
    }

    return CONCURRENT.test(readFileSync(path, "utf8"));
}

function main(argv: string[]): number {
    const positional = argv.filter((arg) => !arg.startsWith("-"));
    const logPath = positional[0];

    if (!logPath) {
        process.stderr.write("usage: bun scripts/ci/test-runtime-guard.ts <test-log> [--ceiling-ms N]\n");
        return 1;
    }

    if (!existsSync(logPath)) {
        process.stderr.write(`test-runtime-guard: ${logPath} does not exist — nothing was scanned.\n`);
        return 1;
    }

    const ceilingIndex = argv.indexOf("--ceiling-ms");
    const requested = ceilingIndex === -1 ? Number.NaN : Number(argv[ceilingIndex + 1]);
    const ceilingMs = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_CEILING_MS;
    const warnIndex = argv.indexOf("--warn-total-seconds");
    const requestedWarn = warnIndex === -1 ? Number.NaN : Number(argv[warnIndex + 1]);
    const warnTotal = Number.isFinite(requestedWarn) && requestedWarn > 0 ? requestedWarn : DEFAULT_WARN_TOTAL_S;
    const root = resolve(import.meta.dir, "..", "..");
    const report = analyze(readFileSync(logPath, "utf8"), {
        ceilingMs,
        isConcurrent: (file) => sourceIsConcurrent(file, root),
    });

    // The positive control, and the reason this is not `if (violations.length === 0) pass`.
    // A log that was truncated, never written, or written by a step that died reports zero
    // slow files, which is indistinguishable from a clean suite without this check.
    if (report.testLines === 0) {
        process.stderr.write(
            `::error::test-runtime-guard: ${logPath} holds zero (pass)/(fail) lines. ` +
                "The log is missing or truncated, so a clean result here would be the instrument failing, " +
                "not the suite passing.\n"
        );
        return 1;
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
                `ceiling ${(ceilingMs / 1000).toFixed(0)}s — clean.\n`
        );
        return 0;
    }

    process.stderr.write(
        `::error::test-runtime-guard: ${report.violations.length} file(s) over the ${(ceilingMs / 1000).toFixed(0)}s ` +
            "per-file ceiling. Make the test cheap rather than raising the ceiling; the step budget is fixed.\n"
    );

    for (const row of report.violations) {
        process.stderr.write(`  ${(row.ms / 1000).toFixed(1)}s  ${row.tests} tests  ${row.file}\n`);
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
