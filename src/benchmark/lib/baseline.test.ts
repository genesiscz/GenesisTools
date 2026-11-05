import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SafeJSON } from "@genesiscz/utils/json";
import { baselinePath, compareToBaseline, formatComparison, readBaseline, recordBaseline, recordRun } from "./baseline";

const BENCHMARK_SCRIPTS = ["agent-sessions/prefix-mark.ts", "widget/roster-read.ts", "widget/snapshot.ts"];
const CLI_HOME = mkdtempSync(join(tmpdir(), "gt-benchmark-cli-"));
mkdirSync(join(CLI_HOME, "projects"));
const CLI_ENV = {
    HOME: CLI_HOME,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: CLI_HOME,
    GENESIS_TOOLS_HOME: join(CLI_HOME, "tools"),
    CLAUDE_CONFIG_DIR: CLI_HOME,
    CODEX_HOME: join(CLI_HOME, "codex"),
    GROK_HOME: join(CLI_HOME, "grok"),
};

async function benchmarkCommand({ script, args, preload }: { script: string; args: string[]; preload?: string }) {
    const proc = Bun.spawnSync(
        [
            process.execPath,
            ...(preload ? ["--preload", preload] : []),
            join(import.meta.dir, "../../../scripts/benchmarks", script),
            ...args,
        ],
        { env: CLI_ENV, stdout: "pipe", stderr: "pipe", timeout: 10_000 }
    );
    return {
        exitCode: proc.exitCode,
        stderr: new TextDecoder().decode(proc.stderr),
        stdout: new TextDecoder().decode(proc.stdout),
    };
}
for (const script of BENCHMARK_SCRIPTS) {
    test(`${script} rejects recording and comparing together before reading workload or writing a baseline`, async () => {
        const proc = await benchmarkCommand({ script, args: ["--baseline", "fixture", "--compare", "fixture"] });
        expect(proc.exitCode).not.toBe(0);
        expect(proc.stderr).toContain("--baseline and --compare cannot be used together");
    });
}

test("prefix benchmark refuses an empty project listing before measuring or recording", async () => {
    const proc = await benchmarkCommand({ script: "agent-sessions/prefix-mark.ts", args: ["--baseline", "fixture"] });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr).toContain("No selected transcript has a positive prefix");
});

test("roster CLI records and compares CPU-only metrics while retaining wall-time diagnostics", async () => {
    const preload = join(CLI_HOME, "roster-contract.ts");
    const rosterModule = SafeJSON.stringify(join(import.meta.dir, "../../hub/lib/widget/roster-index.ts"));
    const baselineModule = SafeJSON.stringify(join(import.meta.dir, "index.ts"));
    writeFileSync(
        preload,
        `import { mock } from "bun:test";
mock.module(${rosterModule}, () => ({ readWidgetRoster: async () => ({ rows: [], agents: { parents: [], orphans: [] } }) }));
function check(input, operation) {
    if (Object.keys(input.metrics).join(",") !== "rosterReadCpuMs") throw new Error("incompatible roster baseline metrics");
    process.stderr.write("fixture " + operation + " CPU-only\\n");
}
mock.module(${baselineModule}, () => ({
    recordBaseline: async input => { check(input, "recordBaseline"); },
    compareToBaseline: async input => { check(input, "compareToBaseline"); return { ok: true }; },
    recordRun: async input => { check(input, "recordRun"); },
    formatComparison: () => "fixture comparison passed",
}));
`
    );
    for (const mode of ["baseline", "compare"]) {
        const proc = await benchmarkCommand({
            script: "widget/roster-read.ts",
            preload,
            args: ["--runs", "1", "--gap-ms", "0", `--${mode}`, "fixture", "--record-run", "fixture change", "--json"],
        });
        expect(proc.exitCode).toBe(0);
        expect(proc.stderr).toContain(
            `fixture ${mode === "baseline" ? "recordBaseline" : "compareToBaseline"} CPU-only`
        );
        expect(proc.stderr).toContain("fixture recordRun CPU-only");
        expect(proc.stdout).toContain('"rosterReadWallMs"');
    }
});

const DIR = mkdtempSync(join(tmpdir(), "gt-benchmark-baseline-"));
const TOLERANCE = 10;

describe("baselinePath", () => {
    test("puts a named baseline inside the given directory", () => {
        expect(baselinePath("ai-usage-poll", { dir: DIR })).toBe(join(DIR, "ai-usage-poll.json"));
    });

    test("refuses a name that would escape the directory", () => {
        expect(() => baselinePath("../../etc/passwd", { dir: DIR })).toThrow("Invalid baseline name");
        expect(() => baselinePath("nested/name", { dir: DIR })).toThrow("Invalid baseline name");
    });
});

describe("record and read", () => {
    beforeAll(async () => {
        await recordBaseline({
            name: "demo",
            metrics: { cpuMs: 100, spawns: 4, throughput: 50 },
            notes: "measured on an idle machine",
            dir: DIR,
        });
        await recordBaseline({ name: "zeroed", metrics: { spawns: 0 }, dir: DIR });
    });

    test("round trips the metrics and the provenance", async () => {
        const baseline = await readBaseline("demo", { dir: DIR });

        expect(baseline).not.toBeNull();
        expect(baseline?.name).toBe("demo");
        expect(baseline?.metrics).toEqual({ cpuMs: 100, spawns: 4, throughput: 50 });
        expect(baseline?.notes).toBe("measured on an idle machine");
        expect(baseline?.commit).toMatch(/^([0-9a-f]{7,}|unknown)$/);
        expect(baseline?.loadAvg).toHaveLength(3);
        expect(baseline?.hostname.length).toBeGreaterThan(0);
        expect(Number.isNaN(Date.parse(baseline?.capturedAt ?? ""))).toBe(false);
    });

    test("returns null for a name that was never recorded", async () => {
        expect(await readBaseline("never-recorded", { dir: DIR })).toBeNull();
    });
});

describe("the run history", () => {
    test("each run is appended with its commit and change, and a re-recorded baseline keeps them", async () => {
        await recordBaseline({ name: "history", metrics: { cpuMs: 150 }, dir: DIR });
        await recordRun({
            name: "history",
            metrics: { cpuMs: 70 },
            change: "an index",
            commit: "1111111111",
            dir: DIR,
        });
        await recordRun({ name: "history", metrics: { cpuMs: 40 }, change: "a cache", dir: DIR });
        const read = await readBaseline("history", { dir: DIR });
        expect(read?.metrics).toEqual({ cpuMs: 150 });
        expect(read?.runs?.map((run) => [run.commit, run.metrics.cpuMs, run.change])).toEqual([
            ["1111111111", 70, "an index"],
            [read?.runs?.[1]?.commit ?? "", 40, "a cache"],
        ]);
        expect(read?.runs?.[1]?.commit).toMatch(/^([0-9a-f]{7,}|unknown)$/);

        await recordBaseline({ name: "history", metrics: { cpuMs: 45 }, dir: DIR });
        expect((await readBaseline("history", { dir: DIR }))?.runs).toHaveLength(2);
    });

    test("a run needs a baseline to read against", async () => {
        await expect(recordRun({ name: "no-such-baseline", metrics: { cpuMs: 1 }, dir: DIR })).rejects.toThrow(
            "No baseline"
        );
    });
});

describe("compareToBaseline", () => {
    beforeAll(async () => {
        await recordBaseline({ name: "cmp", metrics: { cpuMs: 100, spawns: 4, throughput: 50 }, dir: DIR });
    });

    test("passes when every metric stays within tolerance", async () => {
        const cmp = await compareToBaseline({
            name: "cmp",
            metrics: { cpuMs: 105, spawns: 4, throughput: 50 },
            tolerancePct: TOLERANCE,
            dir: DIR,
        });

        expect(cmp.ok).toBe(true);
        expect(cmp.deltas.cpuMs.pct).toBeCloseTo(5, 5);
        expect(cmp.deltas.cpuMs.ok).toBe(true);
        expect(cmp.missing).toEqual([]);
    });

    test("fails the metric that regressed past the tolerance", async () => {
        const cmp = await compareToBaseline({
            name: "cmp",
            metrics: { cpuMs: 130, spawns: 4, throughput: 50 },
            tolerancePct: TOLERANCE,
            dir: DIR,
        });

        expect(cmp.ok).toBe(false);
        expect(cmp.deltas.cpuMs.ok).toBe(false);
        expect(cmp.deltas.cpuMs.pct).toBeCloseTo(30, 5);
        expect(cmp.deltas.spawns.ok).toBe(true);
    });

    test("lowerIsBetter flips every metric outside the list to higher-is-better", async () => {
        const cmp = await compareToBaseline({
            name: "cmp",
            metrics: { cpuMs: 60, spawns: 4, throughput: 80 },
            tolerancePct: TOLERANCE,
            lowerIsBetter: ["cpuMs", "spawns"],
            dir: DIR,
        });

        expect(cmp.ok).toBe(true);

        const dropped = await compareToBaseline({
            name: "cmp",
            metrics: { cpuMs: 60, spawns: 4, throughput: 20 },
            tolerancePct: TOLERANCE,
            lowerIsBetter: ["cpuMs", "spawns"],
            dir: DIR,
        });

        expect(dropped.ok).toBe(false);
        expect(dropped.deltas.throughput.ok).toBe(false);
    });

    test("floor passes a change under the absolute floor even when the percentage fails", async () => {
        const dir = mkdtempSync(join(tmpdir(), "baseline-floor-"));
        await recordBaseline({ name: "tiny", metrics: { cpuPercent: 0.16, latencyMs: 300 }, dir });

        const gated = await compareToBaseline({
            name: "tiny",
            metrics: { cpuPercent: 0.19, latencyMs: 360 },
            tolerancePct: 15,
            dir,
        });
        expect(gated.deltas.cpuPercent?.ok).toBe(false);
        expect(gated.deltas.latencyMs?.ok).toBe(false);

        const floored = await compareToBaseline({
            name: "tiny",
            metrics: { cpuPercent: 0.19, latencyMs: 360 },
            tolerancePct: 15,
            floor: { cpuPercent: 0.1 },
            dir,
        });
        expect(floored.deltas.cpuPercent?.ok).toBe(true);
        expect(floored.deltas.latencyMs?.ok).toBe(false);
        expect(floored.ok).toBe(false);
    });

    test("names a metric the baseline does not carry instead of scoring it", async () => {
        const cmp = await compareToBaseline({
            name: "cmp",
            metrics: { cpuMs: 100, spawns: 4, throughput: 50, fsCalls: 12 },
            tolerancePct: TOLERANCE,
            dir: DIR,
        });

        expect(cmp.missing).toEqual(["fsCalls"]);
        expect(cmp.deltas.fsCalls).toBeUndefined();
        expect(cmp.ok).toBe(false);
    });

    test("fails when the current run drops a metric the baseline still carries", async () => {
        const cmp = await compareToBaseline({
            name: "cmp",
            metrics: { cpuMs: 100, spawns: 4 },
            tolerancePct: TOLERANCE,
            dir: DIR,
        });

        expect(cmp.missing).toEqual(["throughput"]);
        expect(cmp.deltas.throughput).toBeUndefined();
        expect(cmp.ok).toBe(false);
    });

    test("treats a missing baseline as a failure, not as a pass", async () => {
        const cmp = await compareToBaseline({
            name: "absent",
            metrics: { cpuMs: 1, spawns: 2 },
            tolerancePct: TOLERANCE,
            dir: DIR,
        });

        expect(cmp.ok).toBe(false);
        expect(cmp.baseline).toBeNull();
        expect(cmp.missing).toEqual(["cpuMs", "spawns"]);
    });

    test("reports growth from a zero baseline as infinite rather than as NaN", async () => {
        const cmp = await compareToBaseline({
            name: "zeroed",
            metrics: { spawns: 3 },
            tolerancePct: TOLERANCE,
            dir: DIR,
        });

        expect(cmp.deltas.spawns.pct).toBe(Number.POSITIVE_INFINITY);
        expect(cmp.deltas.spawns.ok).toBe(false);
        expect(formatComparison(cmp)).toContain("new");
    });
});

describe("formatComparison", () => {
    test("renders one row per metric plus a verdict", async () => {
        const cmp = await compareToBaseline({
            name: "cmp",
            metrics: { cpuMs: 130, spawns: 4, throughput: 50 },
            tolerancePct: TOLERANCE,
            dir: DIR,
        });
        const text = formatComparison(cmp);

        expect(text).toContain("METRIC");
        expect(text).toContain("cpuMs");
        expect(text).toContain("REGRESSED");
        expect(text).toContain("FAIL");
    });

    test("says what to run when no baseline exists", async () => {
        const cmp = await compareToBaseline({ name: "absent", metrics: { a: 1 }, tolerancePct: TOLERANCE, dir: DIR });

        expect(formatComparison(cmp)).toContain("--baseline");
    });
});
