#!/usr/bin/env bun
/**
 * Measures `FileMetaCache.reconcile()`, the body of the daily `macos-clones-cache-prune` daemon task.
 *
 * Every run works on its own APFS clone (`cp -c`) of the cache DB, so the live file is only ever read,
 * and every run starts from the same rows. Each run is a child process, in one of two arms:
 *
 * - `normal`: plain `bun run`.
 * - `background`: `taskpolicy -b bun run`, the background QoS the launchd daemon (ProcessType=Background)
 *   gives every task: throttled CPU and disk I/O.
 *
 * The arms are interleaved (normal, background, normal, ...), so a load change lands in both. The child
 * reports wall time, its own CPU time (user + system), the probe count, the rows removed by reason and the
 * phase split from the reconcile report.
 *
 * ```
 * bun scripts/benchmarks/clones/cache-reconcile.ts                      # measure and print
 * bun scripts/benchmarks/clones/cache-reconcile.ts --baseline           # record clones-cache-reconcile
 * bun scripts/benchmarks/clones/cache-reconcile.ts --compare            # within 15% of the baseline
 * bun scripts/benchmarks/clones/cache-reconcile.ts --compare --target-pct 50   # at most half of it
 * ```
 *
 * The removed-row counts must equal the baseline's on the same DB: a faster reconcile that removes
 * different rows fails the comparison whatever its timings say.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type BaselineMetrics,
    compareToBaseline,
    formatComparison,
    readBaseline,
    recordBaseline,
} from "@app/benchmark/lib";
import {
    FILE_META_DB_PATH,
    FileMetaCache,
    type ReconcilePhases,
    type ReconcileReport,
} from "@app/macos/lib/clones/file-meta-cache";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";
import { Command } from "commander";

const BASELINE_NAME = "clones-cache-reconcile";
const MODES = ["normal", "background"] as const;
const PHASE_KEYS: Array<keyof ReconcilePhases> = [
    "countMs",
    "ttlMs",
    "sweepFilesMs",
    "sweepDirsMs",
    "vacuumMs",
    "readMs",
    "probeMs",
    "deleteMs",
];
type Mode = (typeof MODES)[number];

interface ChildResult {
    wallMs: number;
    cpuMs: number;
    report: ReconcileReport;
}

interface Flags {
    db: string;
    workDir: string;
    runs: string;
    modes: string;
    baseline?: boolean;
    compare?: boolean;
    targetPct?: string;
    json?: boolean;
    child?: string;
}

async function runChild(dbPath: string): Promise<void> {
    const cache = FileMetaCache.getInstance(dbPath);
    const cpuBefore = process.cpuUsage();
    const startedAt = performance.now();
    const report = await cache.reconcile();
    const wallMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(cpuBefore);
    cache.close();
    const result: ChildResult = {
        wallMs: Math.round(wallMs),
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        report,
    };
    out.print(`${SafeJSON.stringify(result)}\n`);
}

async function spawnText(cmd: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, exitCode };
}

async function measureOnce(input: { source: string; workDir: string; mode: Mode; run: number }): Promise<ChildResult> {
    const runDir = join(input.workDir, `${Date.now()}-${input.mode}-${input.run}`);
    mkdirSync(runDir, { recursive: true });
    const copy = join(runDir, "file-meta.db");
    const cloned = await spawnText(["cp", "-c", input.source, copy]);

    if (cloned.exitCode !== 0) {
        throw new Error(`cp -c ${input.source} failed: ${cloned.stderr.trim()}`);
    }

    const bunRun = [process.execPath, "run", import.meta.path, "--child", copy];
    const cmd = input.mode === "background" ? ["taskpolicy", "-b", ...bunRun] : bunRun;
    const child = await spawnText(cmd);

    if (child.exitCode !== 0) {
        throw new Error(`child (${input.mode}) exited ${child.exitCode}: ${child.stderr.trim().slice(-2000)}`);
    }

    const line = child.stdout.trim().split("\n").pop() ?? "";
    return SafeJSON.parse(line, { strict: true }) as ChildResult;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

function removedOf(report: ReconcileReport): number {
    return report.staleFiles + report.staleDirs + report.goneFiles + report.goneDirs;
}

async function readUptime(): Promise<string> {
    const r = await spawnText(["uptime"]);
    return r.exitCode === 0 ? r.stdout.trim() : "uptime unavailable";
}

async function main(flags: Flags): Promise<void> {
    if (flags.child) {
        await runChild(flags.child);
        return;
    }

    const runCount = Math.max(1, Number.parseInt(flags.runs, 10) || 3);
    const modes = flags.modes.split(",").filter((m): m is Mode => (MODES as readonly string[]).includes(m));
    mkdirSync(flags.workDir, { recursive: true });
    const uptimeBefore = await readUptime();
    const samples = new Map<Mode, ChildResult[]>(modes.map((m) => [m, []]));

    for (let run = 0; run < runCount; run++) {
        for (const mode of run % 2 === 0 ? modes : [...modes].reverse()) {
            out.log.info(`reconcile ${mode} — run ${run + 1}/${runCount}`);
            const result = await measureOnce({ source: flags.db, workDir: flags.workDir, mode, run });
            samples.get(mode)?.push(result);
        }
    }

    const uptimeAfter = await readUptime();
    const metrics: BaselineMetrics = {};
    const removed: BaselineMetrics = {};
    const rows: string[][] = [];

    for (const mode of modes) {
        const results = samples.get(mode) ?? [];
        const walls = results.map((r) => r.wallMs);
        const cpus = results.map((r) => r.cpuMs);
        metrics[`${mode}.wallMs`] = median(walls);
        metrics[`${mode}.cpuMs`] = median(cpus);
        metrics[`${mode}.probes`] = median(results.map((r) => r.report.probes));
        removed[`${mode}.removed`] = median(results.map((r) => removedOf(r.report)));
        rows.push([`${mode} wall ms`, ...walls.map(String), String(median(walls))]);
        rows.push([`${mode} cpu ms`, ...cpus.map(String), String(median(cpus))]);
        rows.push([
            `${mode} probes`,
            ...results.map((r) => String(r.report.probes)),
            String(metrics[`${mode}.probes`]),
        ]);

        for (const key of PHASE_KEYS) {
            const values = results.map((r) => r.report.phases?.[key] ?? 0);
            rows.push([`${mode} ${key}`, ...values.map(String), String(median(values))]);
        }

        rows.push([
            `${mode} removed`,
            ...results.map((r) => String(removedOf(r.report))),
            String(removed[`${mode}.removed`]),
        ]);
    }

    const first = samples.get(modes[0] ?? "normal")?.[0]?.report;
    const setup = first
        ? `${first.fileRows} file rows + ${first.dirRows} dir rows, ${runCount} runs per arm, interleaved, median`
        : "no runs";
    const headers = ["METRIC", ...Array.from({ length: runCount }, (_, i) => `RUN ${i + 1}`), "MEDIAN"];
    out.println(`\nFileMetaCache.reconcile() on a clone of ${flags.db}`);
    out.println(setup);
    out.println(`before: ${uptimeBefore}`);
    out.println(`after:  ${uptimeAfter}\n`);
    out.println(formatTable(rows, headers, { alignRight: headers.map((_, i) => i).filter((i) => i > 0) }));

    if (flags.baseline) {
        const recorded = await recordBaseline({
            name: BASELINE_NAME,
            metrics: { ...metrics, ...removed },
            notes: `${setup} | before: ${uptimeBefore} | after: ${uptimeAfter}`,
        });
        out.println(`\nRecorded baseline ${BASELINE_NAME} at commit ${recorded.commit}.`);
    }

    let compareOk = true;

    if (flags.compare) {
        const targetPct = flags.targetPct ? Number.parseFloat(flags.targetPct) : undefined;
        const tolerancePct = targetPct === undefined ? 15 : targetPct - 100;
        const gated: BaselineMetrics = {};

        for (const mode of modes) {
            gated[`${mode}.wallMs`] = metrics[`${mode}.wallMs`] ?? 0;
            gated[`${mode}.cpuMs`] = metrics[`${mode}.cpuMs`] ?? 0;
        }

        const cmp = await compareToBaseline({ name: BASELINE_NAME, metrics: gated, tolerancePct });
        const unchecked = cmp.missing.filter((m) => !m.endsWith(".probes") && !m.endsWith(".removed"));
        out.println(`\n${formatComparison({ ...cmp, missing: unchecked })}`);
        const base = await readBaseline(BASELINE_NAME);
        const removedMismatch = Object.entries(removed).filter(([key, value]) => base?.metrics[key] !== value);

        for (const [key, value] of removedMismatch) {
            out.println(`removed rows differ: ${key} baseline ${base?.metrics[key] ?? "none"}, now ${value}`);
        }

        const timingOk = Object.values(cmp.deltas).every((d) => d.ok) && cmp.baseline !== null;
        compareOk = timingOk && removedMismatch.length === 0;
        out.println(
            targetPct === undefined
                ? `\nGate: wall and CPU within 15% of the baseline, removed rows equal: ${compareOk ? "PASS" : "FAIL"}`
                : `\nGate: wall and CPU at most ${targetPct}% of the baseline, removed rows equal: ${compareOk ? "PASS" : "FAIL"}`
        );
    }

    if (flags.json) {
        out.result({ metrics, removed, uptimeBefore, uptimeAfter, samples: Object.fromEntries(samples) });
    }

    if (!compareOk) {
        process.exitCode = 1;
    }
}

const program = new Command()
    .name("cache-reconcile")
    .description(
        "Measure FileMetaCache.reconcile() on an APFS clone of the clones cache DB, at normal and background QoS"
    )
    .option("--db <path>", "Cache DB to clone for every run (read only)", FILE_META_DB_PATH)
    .option("--work-dir <dir>", "Where the per-run clones go", join(tmpdir(), "gt-bench-clones-reconcile"))
    .option("--runs <n>", "Runs per arm; the median is reported", "3")
    .option("--modes <list>", "Arms to run: normal,background", "normal,background")
    .option("--baseline", "Record the medians as the baseline")
    .option("--compare", "Measure again and compare with the baseline")
    .option("--target-pct <n>", "With --compare: pass only when wall and CPU are at most this % of the baseline")
    .option("--json", "Emit the machine-readable result on stdout")
    .option("--child <db>", "Internal: run one reconcile on this DB copy and print the result");

await program.parseAsync(process.argv);
await main(program.opts<Flags>());
