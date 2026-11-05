import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { E2eRunnerKind } from "@genesiscz/utils/e2e/project";
import type { E2eTestResult, E2eTestState } from "@genesiscz/utils/e2e/spec-env";
import { SafeJSON } from "@genesiscz/utils/json";
import type { RunNote } from "./runners/types";
import type { SpecFile } from "./specs";

export interface SpecRun {
    spec: SpecFile;
    dir: string;
    exitCode: number | null;
    seconds: number;
    log: string;
    tests: E2eTestResult[];
}

export interface RunCounts {
    passed: number;
    failed: number;
    skipped: number;
    specsFailed: number;
}

export interface RunSummary {
    project: string;
    runner: E2eRunnerKind;
    runDir: string;
    startedAt: string;
    finishedAt: string;
    /** What the runner said about its target: the device and ports, or the site. */
    facts: Record<string, string>;
    specs: SpecRun[];
    counts: RunCounts;
    notes: RunNote[];
    ok: boolean;
}

export function readResults(path: string): E2eTestResult[] {
    if (!existsSync(path)) {
        return [];
    }

    return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => SafeJSON.parse(line, { strict: true }) as E2eTestResult);
}

/** A spec failed when its runner exited non-zero, or any test failed, or it reported no test at all. */
export function specFailed(run: Pick<SpecRun, "exitCode" | "tests">): boolean {
    return run.exitCode !== 0 || run.tests.length === 0 || run.tests.some((test) => test.state === "failed");
}

export function countResults(specs: SpecRun[]): RunCounts {
    const tests = specs.flatMap((spec) => spec.tests);
    return {
        passed: tests.filter((test) => test.state === "passed").length,
        failed: tests.filter((test) => test.state === "failed").length,
        skipped: tests.filter((test) => test.state === "skipped").length,
        specsFailed: specs.filter(specFailed).length,
    };
}

/** The summary as markdown: the target, one line per spec and per failed test, the counts, and the run's notes. */
export function formatSummary(summary: RunSummary): string {
    const { counts } = summary;
    const lines = [
        `# e2e run ${summary.startedAt}`,
        "",
        `- Project: ${summary.project} (${summary.runner})`,
        ...Object.entries(summary.facts).map(([key, value]) => `- ${key[0].toUpperCase()}${key.slice(1)}: ${value}`),
        `- Result: ${summary.ok ? "passed" : "FAILED"}: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped in ${summary.specs.length} spec(s)`,
        "",
        "## Specs",
        "",
    ];

    for (const spec of summary.specs) {
        const passed = spec.tests.filter((test) => test.state === "passed").length;
        lines.push(
            `- ${specFailed(spec) ? "FAIL" : "ok"} ${spec.spec.name}: ${passed}/${spec.tests.length} passed, exit ${spec.exitCode}, ${spec.seconds} s (log ${spec.log})`
        );

        for (const test of spec.tests.filter((candidate) => candidate.state === "failed")) {
            lines.push(`    - ${test.suite} > ${test.title}: ${(test.error ?? "").split("\n")[0]}`);

            if (test.screenshot) {
                lines.push(`      screenshot ${test.screenshot}`);
            }
        }
    }

    lines.push("", "## Notes", "");

    if (summary.notes.length === 0) {
        lines.push("- none");
    }

    for (const note of summary.notes) {
        lines.push(`- ${note.at} ${note.source}: ${note.text}`);
    }

    return `${lines.join("\n")}\n`;
}

export function readSummary(runDir: string): RunSummary {
    const path = join(runDir, "summary.json");

    if (!existsSync(path)) {
        throw new Error(`${runDir} has no summary.json (the run did not finish, or it is not a run folder)`);
    }

    return SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as RunSummary;
}

export interface TestChange {
    /** `<spec> > <suite> > <title>`. */
    test: string;
    before: E2eTestState | "absent";
    after: E2eTestState | "absent";
}

/** Every test whose state differs between two runs, the new failures first. */
export function compareRuns(before: RunSummary, after: RunSummary): TestChange[] {
    const states = (summary: RunSummary) => {
        const result = new Map<string, E2eTestState>();

        for (const spec of summary.specs) {
            for (const test of spec.tests) {
                const key = `${test.project ? `${test.project} > ` : ""}${spec.spec.path} > ${test.suite} > ${test.title}`;

                if (result.get(key) !== "failed") {
                    result.set(key, test.state);
                }
            }
        }

        return result;
    };
    const a = states(before);
    const b = states(after);
    const keys = [...new Set([...a.keys(), ...b.keys()])];
    const changes = keys
        .map((test) => ({ test, before: a.get(test) ?? "absent", after: b.get(test) ?? "absent" }) satisfies TestChange)
        .filter((change) => change.before !== change.after);
    const rank = (change: TestChange) => (change.after === "failed" ? 0 : change.before === "failed" ? 1 : 2);
    return changes.sort((x, y) => rank(x) - rank(y) || x.test.localeCompare(y.test));
}
