import { mkdirSync } from "node:fs";
import { hostname, loadavg } from "node:os";
import { join } from "node:path";
import { findProjectRoot } from "@genesiscz/utils/fs/project-root";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";

const { log } = logger.scoped("benchmark-baseline");

/** Baselines are git-tracked so a "before" number survives the branch that produced it. */
const BASELINE_SUBDIR = join("scripts", "benchmarks", "baselines");

const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface BaselineMetrics {
    [metric: string]: number;
}

export interface Baseline {
    name: string;
    /** ISO 8601, from the machine that recorded it. */
    capturedAt: string;
    /** `git rev-parse --short HEAD`, or "unknown" when git could not answer. */
    commit: string;
    /** 1, 5 and 15 minute load average, so a suspiciously fast "after" can be questioned. */
    loadAvg: number[];
    hostname: string;
    metrics: BaselineMetrics;
    notes?: string;
}

export interface BaselineDelta {
    before: number;
    after: number;
    /** Percent change from before to after. Infinite when the baseline was zero. */
    pct: number;
    ok: boolean;
}

export interface BaselineComparison {
    ok: boolean;
    baseline: Baseline | null;
    deltas: Record<string, BaselineDelta>;
    /** Metrics present on only one side of the comparison. */
    missing: string[];
}

export interface BaselineDirOption {
    /** Override the baselines directory. Tests pass a temp dir; nothing else should. */
    dir?: string;
}

function repoRoot(): string | null {
    return findProjectRoot(import.meta.dir);
}

function defaultDir(): string {
    const root = repoRoot();

    if (root === null) {
        throw new Error("Could not find the repo root from src/benchmark/lib; pass { dir } explicitly.");
    }

    return join(root, BASELINE_SUBDIR);
}

/**
 * Where a named baseline lives: `<repo>/scripts/benchmarks/baselines/<name>.json`.
 * The name may not contain a path separator, so a caller cannot write outside it.
 */
export function baselinePath(name: string, opts?: BaselineDirOption): string {
    if (!VALID_NAME.test(name)) {
        throw new Error(`Invalid baseline name "${name}"; use letters, digits, dot, dash and underscore.`);
    }

    return join(opts?.dir ?? defaultDir(), `${name}.json`);
}

/**
 * The HEAD of the repo holding the code being measured, not of the baselines
 * directory: a test writing into a temp dir still records the real commit.
 */
async function currentCommit(): Promise<string> {
    const cwd = repoRoot() ?? process.cwd();
    const proc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;

    if (proc.exitCode !== 0) {
        log.warn({ cwd, exitCode: proc.exitCode, stderr: stderr.trim() }, "git rev-parse failed; commit is unknown");
        return "unknown";
    }

    return stdout.trim();
}

/**
 * Write the "before" numbers for a fix, so the "after" run has something to
 * argue with. Overwrites an existing baseline of the same name.
 */
export async function recordBaseline(input: {
    name: string;
    metrics: BaselineMetrics;
    notes?: string;
    dir?: string;
}): Promise<Baseline> {
    const path = baselinePath(input.name, { dir: input.dir });
    const dir = input.dir ?? defaultDir();
    mkdirSync(dir, { recursive: true });

    const baseline: Baseline = {
        name: input.name,
        capturedAt: new Date().toISOString(),
        commit: await currentCommit(),
        loadAvg: loadavg(),
        hostname: hostname(),
        metrics: input.metrics,
        ...(input.notes === undefined ? {} : { notes: input.notes }),
    };

    await Bun.write(path, `${SafeJSON.stringify(baseline, null, 4)}\n`);
    log.debug({ path, metrics: Object.keys(input.metrics).length }, "baseline recorded");
    return baseline;
}

/** Read a named baseline, or null when it was never recorded. */
export async function readBaseline(name: string, opts?: BaselineDirOption): Promise<Baseline | null> {
    const path = baselinePath(name, opts);
    const file = Bun.file(path);

    if (!(await file.exists())) {
        log.debug({ path }, "no baseline recorded under that name");
        return null;
    }

    try {
        return SafeJSON.parse(await file.text(), { strict: true }) as Baseline;
    } catch (err) {
        log.warn({ err, path }, "baseline file could not be parsed; treating it as absent");
        return null;
    }
}

/**
 * Compare fresh metrics against a recorded baseline.
 *
 * Every metric is lower-is-better by default, which is what a CPU campaign
 * measures: CPU milliseconds, spawn counts, fs calls, stall milliseconds. Name
 * the exceptions in `lowerIsBetter` and everything outside that list flips to
 * higher-is-better (throughput, cache hit rate).
 *
 * A metric passes when it stays within `tolerancePct` of the baseline. The
 * comparison is `ok` only when a baseline exists, no measured metric is missing
 * from it, and every delta passes. The tolerance math assumes non-negative
 * baseline values, which is true of counts and durations.
 */
export async function compareToBaseline(input: {
    name: string;
    metrics: BaselineMetrics;
    tolerancePct: number;
    lowerIsBetter?: string[];
    /**
     * Absolute tolerance per metric, in the metric's own unit. A delta whose magnitude is under the
     * floor passes whatever the percentage says. A percentage gate is meaningless on a tiny
     * magnitude: 0.16% of a core going to 0.19% is a 23% "regression" and 1.8 ms of CPU over five
     * seconds, which is noise. Set the floor to the smallest change that would matter.
     */
    floor?: Record<string, number>;
    dir?: string;
}): Promise<BaselineComparison> {
    const baseline = await readBaseline(input.name, { dir: input.dir });

    if (baseline === null) {
        return { ok: false, baseline: null, deltas: {}, missing: Object.keys(input.metrics) };
    }

    const deltas: Record<string, BaselineDelta> = {};
    const missing: string[] = [];

    for (const [metric, after] of Object.entries(input.metrics)) {
        const before = baseline.metrics[metric];

        if (before === undefined) {
            missing.push(metric);
            continue;
        }

        const lowerBetter = input.lowerIsBetter === undefined || input.lowerIsBetter.includes(metric);
        const limit = lowerBetter ? before * (1 + input.tolerancePct / 100) : before * (1 - input.tolerancePct / 100);
        const withinFloor = Math.abs(after - before) <= (input.floor?.[metric] ?? 0);
        const ok = withinFloor || (lowerBetter ? after <= limit : after >= limit);
        let pct = 0;

        if (before !== 0) {
            pct = ((after - before) / before) * 100;
        } else if (after !== 0) {
            pct = after > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
        }

        deltas[metric] = { before, after, pct, ok };
    }

    for (const metric of Object.keys(baseline.metrics)) {
        if (!(metric in input.metrics)) {
            missing.push(metric);
        }
    }

    const ok = missing.length === 0 && Object.values(deltas).every((delta) => delta.ok);
    log.debug({ name: input.name, ok, missing: missing.length }, "baseline comparison finished");
    return { ok, baseline, deltas, missing };
}

function formatNumber(value: number): string {
    if (!Number.isFinite(value)) {
        return value > 0 ? "new" : "gone";
    }

    if (Number.isInteger(value)) {
        return String(value);
    }

    return value.toFixed(2);
}

function formatPercent(value: number): string {
    if (!Number.isFinite(value)) {
        return value > 0 ? "new" : "gone";
    }

    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
}

/**
 * Render a comparison as a plain padded table for a benchmark script to print
 * through `out.println`. Returns the text; it never writes anywhere itself.
 */
export function formatComparison(cmp: BaselineComparison): string {
    if (cmp.baseline === null) {
        return "No baseline recorded. Run the script with --baseline first.";
    }

    const rows = Object.entries(cmp.deltas).map(([metric, delta]) => [
        metric,
        formatNumber(delta.before),
        formatNumber(delta.after),
        formatPercent(delta.pct),
        delta.ok ? "ok" : "REGRESSED",
    ]);
    const table = formatTable(rows, ["METRIC", "BEFORE", "AFTER", "DELTA", "STATUS"], { alignRight: [1, 2, 3] });
    const header = [
        `Baseline ${cmp.baseline.name} — commit ${cmp.baseline.commit}, captured ${cmp.baseline.capturedAt}`,
        `Recorded on ${cmp.baseline.hostname} at load ${cmp.baseline.loadAvg.map((n) => n.toFixed(2)).join(" ")}`,
    ];
    const lines = [...header, "", table];

    if (cmp.missing.length > 0) {
        lines.push("", `Contract mismatch (present on only one side): ${cmp.missing.join(", ")}`);
    }

    lines.push("", cmp.ok ? "PASS — every metric is within tolerance." : "FAIL — see the rows marked REGRESSED.");
    return lines.join("\n");
}
