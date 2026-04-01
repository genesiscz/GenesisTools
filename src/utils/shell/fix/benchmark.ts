/**
 * Test runner + benchmark for all 4 shell command fixer implementations.
 *
 * Usage: bun src/utils/shell/fix/benchmark.ts
 */

import chalk from "chalk";
import { SafeJSON } from "@app/utils/json";
import { fixShellCommand as fixBashScript } from "./impl-bash-script.js";
import { fixShellCommand as fixJustBash } from "./impl-just-bash.js";
import { fixShellCommand as fixRegex } from "./impl-regex.js";
import { fixShellCommand as fixShellQuote } from "./impl-shell-quote.js";
import { fixShellCommand as fixShellwords } from "./impl-shellwords.js";
import { testCases } from "./test.data.js";

interface ImplEntry {
    name: string;
    fn: (input: string) => string;
}

const impls: ImplEntry[] = [
    { name: "bash-script", fn: fixBashScript },
    { name: "regex", fn: fixRegex },
    { name: "shell-quote", fn: fixShellQuote },
    { name: "shellwords", fn: fixShellwords },
    { name: "just-bash", fn: fixJustBash },
];

// ── Run tests ────────────────────────────────────────────────────────────

interface TestResult {
    pass: boolean;
    actual: string;
    error?: string;
}

interface ImplReport {
    name: string;
    passed: number;
    failed: number;
    crashed: number;
    failures: { testName: string; expected: string; actual: string; tags: string[] }[];
    crashes: { testName: string; error: string }[];
    durationMs: number;
}

function runImpl(impl: ImplEntry): ImplReport {
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
        let result: TestResult;

        try {
            const actual = impl.fn(tc.input);
            const pass = actual === tc.expected;
            result = { pass, actual };
        } catch (err) {
            result = {
                pass: false,
                actual: "",
                error: err instanceof Error ? err.message : String(err),
            };
        }

        if (result.error) {
            report.crashed++;
            report.crashes.push({ testName: tc.name, error: result.error });
        } else if (result.pass) {
            report.passed++;
        } else {
            report.failed++;
            report.failures.push({
                testName: tc.name,
                expected: tc.expected,
                actual: result.actual,
                tags: tc.tags,
            });
        }
    }

    report.durationMs = performance.now() - start;
    return report;
}

// ── Benchmark (multiple runs) ────────────────────────────────────────────

function benchmark(impl: ImplEntry, iterations: number): number {
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
        for (const tc of testCases) {
            impl.fn(tc.input);
        }
    }

    return performance.now() - start;
}

// ── Main ─────────────────────────────────────────────────────────────────

const total = testCases.length;
console.log(chalk.bold(`\nShell Command Fixer — ${total} test cases × ${impls.length} implementations\n`));
console.log(chalk.dim("─".repeat(80)));

const reports: ImplReport[] = [];

for (const impl of impls) {
    const report = runImpl(impl);
    reports.push(report);

    const statusIcon = report.failed === 0 && report.crashed === 0 ? chalk.green("✓") : chalk.red("✗");
    const passRate = ((report.passed / total) * 100).toFixed(1);

    console.log(
        `${statusIcon} ${chalk.bold(impl.name.padEnd(14))} ` +
            `${chalk.green(`${report.passed} pass`)}  ` +
            `${report.failed > 0 ? chalk.red(`${report.failed} fail`) : chalk.dim("0 fail")}  ` +
            `${report.crashed > 0 ? chalk.yellow(`${report.crashed} crash`) : chalk.dim("0 crash")}  ` +
            `${chalk.cyan(`${report.durationMs.toFixed(1)}ms`)}  ` +
            `${chalk.dim(`(${passRate}%)`)}`
    );
}

console.log(chalk.dim("─".repeat(80)));

// ── Show failures ────────────────────────────────────────────────────────

const anyFailures = reports.some((r) => r.failed > 0 || r.crashed > 0);

if (anyFailures) {
    console.log(chalk.bold.red("\nFailures:\n"));

    for (const report of reports) {
        if (report.failures.length === 0 && report.crashes.length === 0) {
            continue;
        }

        console.log(chalk.bold.yellow(`  ${report.name}:`));

        for (const f of report.failures) {
            console.log(chalk.red(`    ✗ ${f.testName}`));
            console.log(chalk.dim(`      tags: ${f.tags.join(", ")}`));
            console.log(chalk.dim(`      expected: ${SafeJSON.stringify(f.expected).slice(0, 120)}`));
            console.log(chalk.dim(`      actual:   ${SafeJSON.stringify(f.actual).slice(0, 120)}`));
        }

        for (const c of report.crashes) {
            console.log(chalk.yellow(`    💥 ${c.testName}: ${c.error}`));
        }

        console.log();
    }
}

// ── Benchmark ────────────────────────────────────────────────────────────

console.log(chalk.bold("\nBenchmark (100 iterations × 106 cases):\n"));

const benchIterations = 100;

for (const impl of impls) {
    const ms = benchmark(impl, benchIterations);
    const perCase = ((ms / (benchIterations * total)) * 1000).toFixed(1);
    console.log(
        `  ${chalk.bold(impl.name.padEnd(14))} ` +
            `${chalk.cyan(`${ms.toFixed(0)}ms`)} total  ` +
            `${chalk.dim(`${perCase}µs/case`)}`
    );
}

// ── Summary ──────────────────────────────────────────────────────────────

console.log(chalk.bold("\n\nSummary:\n"));

const bestImpl = reports.reduce((best, r) => (r.passed > best.passed ? r : best), reports[0]);
console.log(`  Best pass rate: ${chalk.green.bold(bestImpl.name)} (${bestImpl.passed}/${total})`);

if (!anyFailures) {
    console.log(chalk.green.bold("\n  All implementations pass all tests! 🎉\n"));
} else {
    const allSame = reports.every((r) => r.passed === reports[0].passed && r.failed === reports[0].failed);

    if (allSame) {
        console.log(
            chalk.yellow("\n  All implementations have identical results — failures are in shared preprocess.ts\n")
        );
    }
}

process.exit(anyFailures ? 1 : 0);
