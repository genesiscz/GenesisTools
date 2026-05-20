/**
 * Test runner + benchmark for shell command fixer implementations.
 *
 * Tests both modes: plain (expected) and prettify (expectedPretty).
 *
 * Usage: bun src/utils/shell/fix/benchmark.ts
 */

import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import chalk from "chalk";
import { fixShellCommand as fixRegex } from "./impl-regex.js";
import { testCases } from "./test.data.js";

type FixFn = (input: string, options?: { prettify?: boolean }) => string;

interface ImplEntry {
    name: string;
    fn: FixFn;
}

const impls: ImplEntry[] = [{ name: "regex", fn: fixRegex }];

// ── Run tests ────────────────────────────────────────────────────────────

interface ImplReport {
    name: string;
    passed: number;
    failed: number;
    crashed: number;
    failures: { testName: string; expected: string; actual: string; tags: string[] }[];
    crashes: { testName: string; error: string }[];
    durationMs: number;
}

function runImpl(impl: ImplEntry, prettify: boolean): ImplReport {
    const report: ImplReport = {
        name: impl.name,
        passed: 0,
        failed: 0,
        crashed: 0,
        failures: [],
        crashes: [],
        durationMs: 0,
    };

    const start = performance.now();

    for (const tc of testCases) {
        const expected = prettify ? tc.expectedPretty : tc.expected;

        try {
            const actual = impl.fn(tc.input, { prettify });
            if (actual === expected) {
                report.passed++;
            } else {
                report.failed++;
                report.failures.push({
                    testName: tc.name,
                    expected,
                    actual,
                    tags: tc.tags,
                });
            }
        } catch (err) {
            report.crashed++;
            report.crashes.push({
                testName: tc.name,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    report.durationMs = performance.now() - start;
    return report;
}

// ── Benchmark (multiple runs) ────────────────────────────────────────────

function benchmark(impl: ImplEntry, prettify: boolean, iterations: number): number {
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
        for (const tc of testCases) {
            try {
                impl.fn(tc.input, { prettify });
            } catch {
                // Ignore — crashing cases are already reported by runImpl
            }
        }
    }

    return performance.now() - start;
}

// ── Display ──────────────────────────────────────────────────────────────

function printReport(label: string, reports: ImplReport[]): void {
    const total = testCases.length;

    out.println(chalk.dim("─".repeat(80)));
    out.println(chalk.bold(`  ${label}`));
    out.println(chalk.dim("─".repeat(80)));

    for (const report of reports) {
        const statusIcon = report.failed === 0 && report.crashed === 0 ? chalk.green("✓") : chalk.red("✗");
        const passRate = ((report.passed / total) * 100).toFixed(1);

        out.println(
            `${statusIcon} ${chalk.bold(report.name.padEnd(14))} ` +
                `${chalk.green(`${report.passed} pass`)}  ` +
                `${report.failed > 0 ? chalk.red(`${report.failed} fail`) : chalk.dim("0 fail")}  ` +
                `${report.crashed > 0 ? chalk.yellow(`${report.crashed} crash`) : chalk.dim("0 crash")}  ` +
                `${chalk.cyan(`${report.durationMs.toFixed(1)}ms`)}  ` +
                `${chalk.dim(`(${passRate}%)`)}`
        );
    }
}

function printFailures(reports: ImplReport[]): void {
    const anyFailures = reports.some((r) => r.failed > 0 || r.crashed > 0);

    if (!anyFailures) {
        return;
    }

    for (const report of reports) {
        if (report.failures.length === 0 && report.crashes.length === 0) {
            continue;
        }

        out.println(chalk.bold.yellow(`  ${report.name}:`));

        for (const f of report.failures) {
            out.println(chalk.red(`    ✗ ${f.testName}`));
            out.println(chalk.dim(`      tags: ${f.tags.join(", ")}`));
            out.println(chalk.dim(`      expected: ${SafeJSON.stringify(f.expected).slice(0, 120)}`));
            out.println(chalk.dim(`      actual:   ${SafeJSON.stringify(f.actual).slice(0, 120)}`));
        }

        for (const c of report.crashes) {
            out.println(chalk.yellow(`    💥 ${c.testName}: ${c.error}`));
        }

        out.println();
    }
}

// ── Main ─────────────────────────────────────────────────────────────────

const total = testCases.length;
out.println(chalk.bold(`\nShell Command Fixer — ${total} test cases × ${impls.length} implementations × 2 modes\n`));

// Run plain mode
const plainReports = impls.map((impl) => runImpl(impl, false));
printReport("Mode: plain (expected)", plainReports);

// Run pretty mode
const prettyReports = impls.map((impl) => runImpl(impl, true));
printReport("Mode: prettify (expectedPretty)", prettyReports);

// Show all failures
const allReports = [...plainReports, ...prettyReports];
const anyFailures = allReports.some((r) => r.failed > 0 || r.crashed > 0);

if (anyFailures) {
    out.println(chalk.bold.red("\nFailures:\n"));
    printFailures(plainReports);
    printFailures(prettyReports);
}

// Benchmark
const benchIterations = 100;
out.println(chalk.bold(`\nBenchmark (${benchIterations} iterations × ${total} cases, prettify mode):\n`));

for (const impl of impls) {
    const ms = benchmark(impl, true, benchIterations);
    const perCase = ((ms / (benchIterations * total)) * 1000).toFixed(1);
    out.println(
        `  ${chalk.bold(impl.name.padEnd(14))} ` +
            `${chalk.cyan(`${ms.toFixed(0)}ms`)} total  ` +
            `${chalk.dim(`${perCase}µs/case`)}`
    );
}

// Summary
out.println(chalk.bold("\n\nSummary:\n"));

const plainPass = plainReports.reduce((sum, r) => sum + r.passed, 0);
const prettyPass = prettyReports.reduce((sum, r) => sum + r.passed, 0);
const totalTests = total * impls.length;

out.println(`  Plain:    ${plainPass}/${totalTests} passed`);
out.println(`  Prettify: ${prettyPass}/${totalTests} passed`);

if (!anyFailures) {
    out.println(chalk.green.bold("\n  All implementations pass all tests in both modes! 🎉\n"));
}

process.exit(anyFailures ? 1 : 0);
