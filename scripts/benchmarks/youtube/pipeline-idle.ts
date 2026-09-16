#!/usr/bin/env bun

/**
 * What the youtube pipeline costs while it sits idle, and how fast it picks up a burst.
 *
 * `Pipeline.start()` (src/youtube/lib/pipeline.ts) spawns one worker per stage slot up
 * front — 48 of them at the default concurrency — and each one calls
 * `db.claimNextJob(workerId, { stage })` every `DEFAULT_POLL_MS` (250 ms) forever. On an
 * empty queue that is 192 SQLite write transactions a second for no work at all. This
 * script records that as the "before" number, so the on-demand worker pool that replaces
 * the fixed bank has something to argue with.
 *
 * The fixture matches `src/youtube/lib/__tests__/pipeline.test.ts`: an in-memory database,
 * a config rooted in a temp dir, and a no-op handler for every stage. `pollMs` is left
 * unset on purpose, so the production default is what gets measured.
 *
 * Usage:
 *   bun scripts/benchmarks/youtube/pipeline-idle.ts --baseline
 *   bun scripts/benchmarks/youtube/pipeline-idle.ts --compare
 *   bun scripts/benchmarks/youtube/pipeline-idle.ts --seconds 10 --burst 200 --json
 */

import type { Database as BunDatabase } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
    type BaselineMetrics,
    compareToBaseline,
    formatComparison,
    recordBaseline,
    sampleSelf,
} from "@app/benchmark/lib";
import { YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { Pipeline } from "@app/youtube/lib/pipeline";
import type { PipelineHandlerMap, StageHandler } from "@app/youtube/lib/pipeline.types";
import { logger, out } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";

const { log } = logger.scoped("bench-youtube-pipeline");

const BASELINE_NAME = "youtube-pipeline-idle";

/** A burst that never drains is not a measurement, so give up rather than hang. */
const DRAIN_TIMEOUT_MS = 60_000;

interface Counters {
    /** Calls into the bun:sqlite handle. Every one of them in this codebase is executed
     *  immediately (`db.query(sql).get(...)`), so this is the statement-execution count. */
    statements: () => number;
    /** Calls to `db.claimNextJob`, which is the poll the fixed worker bank performs. */
    claims: () => number;
}

interface IdleSample {
    cpuPercent: number;
    statementsPerSec: number;
    claimsPerSec: number;
    rssBytes: number;
}

interface BurstSample {
    enqueueMs: number;
    firstStartMs: number;
    drainMs: number;
    cpuTimeMs: number;
    cpuPercent: number;
    peakWorkers: number;
    peakWorkersSource: string;
    enqueued: number;
}

/**
 * Count every call into the database handle, and separately every claim poll.
 *
 * The wrappers replace the methods on the INSTANCE, so the originals stay reachable on the
 * prototype and nothing else in the process is affected. `query` caches its compiled
 * statement, so this counts statement lookups rather than sqlite3_step calls; the pipeline
 * executes every statement it looks up, which makes the two the same number here.
 */
function installCounters(db: YoutubeDatabase): Counters {
    let statements = 0;
    let claims = 0;
    const handle: BunDatabase = db.getDb();

    type QueryFn = BunDatabase["query"];
    type PrepareFn = BunDatabase["prepare"];
    type RunFn = BunDatabase["run"];
    type ExecFn = BunDatabase["exec"];
    type ClaimFn = YoutubeDatabase["claimNextJob"];

    const originalQuery = handle.query.bind(handle) as QueryFn;
    const originalPrepare = handle.prepare.bind(handle) as PrepareFn;
    const originalRun = handle.run.bind(handle) as RunFn;
    const originalExec = handle.exec.bind(handle) as ExecFn;
    const originalClaim = db.claimNextJob.bind(db) as ClaimFn;

    handle.query = ((sql: string) => {
        statements += 1;
        return originalQuery(sql);
    }) as QueryFn;

    handle.prepare = ((...args: Parameters<PrepareFn>) => {
        statements += 1;
        return originalPrepare(...args);
    }) as PrepareFn;

    handle.run = ((...args: Parameters<RunFn>) => {
        statements += 1;
        return originalRun(...args);
    }) as RunFn;

    handle.exec = ((...args: Parameters<ExecFn>) => {
        statements += 1;
        return originalExec(...args);
    }) as ExecFn;

    db.claimNextJob = ((workerId, opts) => {
        claims += 1;
        return originalClaim(workerId, opts);
    }) as ClaimFn;

    return { statements: () => statements, claims: () => claims };
}

/**
 * A no-op handler per stage, written out rather than generated so a new stage in
 * `JOB_STAGES` fails this file at compile time instead of at run time.
 */
function makeHandlers(): PipelineHandlerMap {
    const noop: StageHandler = async () => {};

    return {
        discover: noop,
        metadata: noop,
        comments: noop,
        captions: noop,
        audio: noop,
        video: noop,
        transcribe: noop,
        qaIndex: noop,
        summarize: noop,
        qa: noop,
        reportSynthesize: noop,
    };
}

interface WorkerCountReader {
    read: () => number;
    source: string;
}

/**
 * Read the live worker count, however this build of the pipeline is willing to report it.
 *
 * `workerStats()` is what the on-demand pool is expected to expose, and is preferred. The
 * fixed-bank pipeline has no such method, so this falls back to the length of its private
 * `workers` array — which is the real spawned count, and which `stop()` empties rather than
 * replaces, so the reference stays live for the whole run.
 */
function workerCountReader(pipeline: Pipeline): WorkerCountReader {
    const stats = Reflect.get(pipeline, "workerStats");

    if (typeof stats === "function") {
        const read = (): number => {
            const value: unknown = Reflect.apply(stats, pipeline, []);

            if (
                typeof value === "object" &&
                value !== null &&
                "workers" in value &&
                typeof value.workers === "number"
            ) {
                return value.workers;
            }

            log.warn({ value }, "workerStats() did not return a numeric `workers` field");
            return 0;
        };

        return { read, source: "pipeline.workerStats()" };
    }

    const workers = Reflect.get(pipeline, "workers");

    if (Array.isArray(workers)) {
        return { read: () => workers.length, source: "pipeline.workers.length (private field)" };
    }

    log.warn({}, "the pipeline reports no worker count; peakWorkers will read 0");
    return { read: () => 0, source: "unavailable" };
}

async function measureIdle(counters: Counters, seconds: number): Promise<IdleSample> {
    const statementsBefore = counters.statements();
    const claimsBefore = counters.claims();
    // countThreads costs a `ps` spawn; it lands outside the CPU window but still
    // between phases, and the thread count is not one of the recorded metrics.
    const sample = await sampleSelf({ windowMs: seconds * 1000, countThreads: false });
    const windowSec = sample.windowMs / 1000;

    return {
        cpuPercent: sample.cpuPercent,
        statementsPerSec: (counters.statements() - statementsBefore) / windowSec,
        claimsPerSec: (counters.claims() - claimsBefore) / windowSec,
        rssBytes: sample.rssBytes,
    };
}

/**
 * Enqueue `count` distinct jobs and time how long the pool takes to notice and to drain.
 *
 * The enqueue loop is synchronous, so no worker can run inside it and `firstStartMs` is
 * always the wake latency of a queue that is already full. CPU is read with
 * `process.cpuUsage()` rather than `sampleSelf`, because the drain has no length known in
 * advance and `sampleSelf` owns its own window.
 */
async function measureBurst(pipeline: Pipeline, count: number): Promise<BurstSample> {
    let firstStartAt: number | null = null;
    let terminal = 0;
    let resolveDrain: (() => void) | null = null;
    const drained = new Promise<void>((resolve) => {
        resolveDrain = resolve;
    });

    const countTerminal = (): void => {
        terminal += 1;

        if (terminal >= count) {
            resolveDrain?.();
        }
    };
    const offStarted = pipeline.on("job:started", () => {
        firstStartAt ??= performance.now();
    });
    const offCompleted = pipeline.on("job:completed", countTerminal);
    const offFailed = pipeline.on("job:failed", countTerminal);

    const workerCount = workerCountReader(pipeline);
    let peakWorkers = workerCount.read();
    // lint-rules-ignore: benchmark probe; 10 ms is the resolution the peak-worker count needs
    const sampler = setInterval(() => {
        peakWorkers = Math.max(peakWorkers, workerCount.read());
    }, 10);

    const enqueueStartedAt = performance.now();
    let enqueued = 0;

    for (let i = 0; i < count; i++) {
        const result = pipeline.enqueue({
            targetKind: "video",
            // 11 characters, the shape of a real video id, and distinct per index so the
            // fingerprint dedupe in `enqueueJob` cannot fold two of them together.
            target: `bench-${String(i).padStart(5, "0")}`,
            stages: ["metadata"],
        });

        if (result.job !== null && !result.reused) {
            enqueued += 1;
        }
    }

    const enqueueEndedAt = performance.now();
    const cpuBefore = process.cpuUsage();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        resolveDrain?.();
    }, DRAIN_TIMEOUT_MS);

    await drained;
    const drainEndedAt = performance.now();
    const cpu = process.cpuUsage(cpuBefore);
    clearTimeout(timer);
    clearInterval(sampler);
    offStarted();
    offCompleted();
    offFailed();

    if (timedOut) {
        throw new Error(
            `burst did not drain in ${DRAIN_TIMEOUT_MS} ms: ${terminal}/${count} jobs reached a terminal state`
        );
    }

    const drainMs = drainEndedAt - enqueueEndedAt;
    const cpuTimeMs = (cpu.user + cpu.system) / 1000;

    return {
        enqueueMs: enqueueEndedAt - enqueueStartedAt,
        firstStartMs: firstStartAt === null ? drainMs : firstStartAt - enqueueEndedAt,
        drainMs,
        cpuTimeMs,
        cpuPercent: drainMs > 0 ? (cpuTimeMs / drainMs) * 100 : 0,
        peakWorkers,
        peakWorkersSource: workerCount.source,
        enqueued,
    };
}

async function runOnce(opts: { seconds: number; burst: number }): Promise<{
    metrics: BaselineMetrics;
    peakWorkersSource: string;
    enqueued: number;
    idleRssBytes: number;
}> {
    const dir = await mkdtemp(join(tmpdir(), "youtube-pipeline-bench-"));
    const db = new YoutubeDatabase(":memory:");
    const config = new YoutubeConfig({ baseDir: dir });
    const counters = installCounters(db);
    const pipeline = new Pipeline(db, config, { handlers: makeHandlers(), workerIdPrefix: "bench" });

    try {
        await pipeline.start();
        const idle = await measureIdle(counters, opts.seconds);
        const burst = await measureBurst(pipeline, opts.burst);
        const postBurst = await measureIdle(counters, opts.seconds);

        return {
            metrics: {
                idleCpuPercent: idle.cpuPercent,
                idleStatementsPerSec: idle.statementsPerSec,
                idleClaimsPerSec: idle.claimsPerSec,
                burstEnqueueMs: burst.enqueueMs,
                burstFirstStartMs: burst.firstStartMs,
                burstDrainMs: burst.drainMs,
                // CPU TIME, not percent. The fix drains the same burst in a third of the wall time,
                // so a rate over that window rises even when the work costs the same: 45% of a core
                // for 22 ms and 170% for 6.5 ms are 9.9 and 11.1 ms of CPU. Percent is kept in the
                // run table for orientation and is deliberately not a gate.
                burstCpuTimeMs: burst.cpuTimeMs,
                peakWorkers: burst.peakWorkers,
                postBurstCpuPercent: postBurst.cpuPercent,
                postBurstStatementsPerSec: postBurst.statementsPerSec,
            },
            peakWorkersSource: burst.peakWorkersSource,
            enqueued: burst.enqueued,
            idleRssBytes: idle.rssBytes,
        };
    } finally {
        await pipeline.stop();
        db.close();
        await rm(dir, { recursive: true, force: true });
    }
}

function formatValue(value: number): string {
    if (Number.isInteger(value)) {
        return String(value);
    }

    return value.toFixed(2);
}

function printMetrics(metrics: BaselineMetrics): void {
    const rows = Object.entries(metrics).map(([metric, value]) => [metric, formatValue(value)]);
    out.println(formatTable(rows, ["METRIC", "VALUE"], { alignRight: [1] }));
}

interface MetricSpread {
    min: number;
    median: number;
    max: number;
}

/** Lower middle on an even count, so every reported number is one that was actually measured. */
function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);

    return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * Min, median and max per metric across the runs.
 *
 * Per-metric rather than "the median run": picking one whole run by one metric would hand the
 * baseline whatever the other nine metrics happened to be in that run, and the timing metrics
 * here spread by 2x between runs on a loaded machine.
 */
function spreadPerMetric(runs: BaselineMetrics[]): Record<string, MetricSpread> {
    const spread: Record<string, MetricSpread> = {};

    for (const metric of Object.keys(runs[0])) {
        const values = runs.map((run) => run[metric]);
        spread[metric] = { min: Math.min(...values), median: median(values), max: Math.max(...values) };
    }

    return spread;
}

function medianMetrics(spread: Record<string, MetricSpread>): BaselineMetrics {
    return Object.fromEntries(Object.entries(spread).map(([metric, values]) => [metric, values.median]));
}

function printSpread(spread: Record<string, MetricSpread>, runs: number): void {
    const rows = Object.entries(spread).map(([metric, values]) => [
        metric,
        formatValue(values.min),
        formatValue(values.median),
        formatValue(values.max),
    ]);
    out.println(`--- min / median / max across ${runs} runs (the median column is what is recorded) ---`);
    out.println(formatTable(rows, ["METRIC", "MIN", "MEDIAN", "MAX"], { alignRight: [1, 2, 3] }));
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            baseline: { type: "boolean", default: false },
            compare: { type: "boolean", default: false },
            seconds: { type: "string", default: "5" },
            burst: { type: "string", default: "50" },
            runs: { type: "string", default: "5" },
            json: { type: "boolean", default: false },
        },
    });

    const seconds = Number(values.seconds);
    const burst = Number(values.burst);
    const runs = Number(values.runs);

    if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(burst) || burst <= 0) {
        out.printlnErr("--seconds and --burst must both be positive numbers.");
        process.exitCode = 1;
        return;
    }

    if (!Number.isFinite(runs) || runs < 1) {
        out.printlnErr("--runs must be a positive whole number.");
        process.exitCode = 1;
        return;
    }

    const collected: BaselineMetrics[] = [];
    let peakWorkersSource = "";
    let enqueued = 0;
    let idleRssBytes = 0;

    for (let run = 0; run < runs; run++) {
        const result = await runOnce({ seconds, burst });
        collected.push(result.metrics);
        peakWorkersSource = result.peakWorkersSource;
        enqueued = result.enqueued;
        idleRssBytes = result.idleRssBytes;

        if (runs > 1) {
            out.println(`--- run ${run + 1} of ${runs} ---`);
            printMetrics(result.metrics);
        }
    }

    const spread = spreadPerMetric(collected);
    const metrics = runs > 1 ? medianMetrics(spread) : collected[0];
    const load = loadavg();

    if (runs > 1) {
        printSpread(spread, runs);
    } else {
        printMetrics(metrics);
    }

    out.println(
        `${enqueued}/${burst} jobs enqueued distinctly · peakWorkers ${peakWorkersSource} · ` +
            `idle rss ${(idleRssBytes / 1024 / 1024).toFixed(1)} MB · load ${load.map((n) => n.toFixed(2)).join(" ")}`
    );

    if (values.baseline) {
        const notes =
            `${seconds}s idle window, burst of ${burst}, per-metric median of ${runs} run(s); ` +
            `load ${load.map((n) => n.toFixed(2)).join(" ")}; peakWorkers ${peakWorkersSource}`;
        const baseline = await recordBaseline({ name: BASELINE_NAME, metrics, notes });
        out.println(`Recorded baseline ${baseline.name} at commit ${baseline.commit}.`);
    }

    if (values.compare) {
        const cmp = await compareToBaseline({
            name: BASELINE_NAME,
            metrics,
            tolerancePct: 10,
            lowerIsBetter: Object.keys(metrics),
        });
        out.println(formatComparison(cmp));

        if (!cmp.ok) {
            process.exitCode = 1;
        }
    }

    if (values.json) {
        out.result(metrics);
    }
}

await main();
