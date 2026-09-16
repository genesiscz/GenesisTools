#!/usr/bin/env bun
/**
 * Regression benchmark for `FileTailer` (`src/utils/fs/file-tailer.ts`).
 *
 * WHAT IT PROTECTS. `FileTailer` pairs an `fs.watch` on the file with a 300 ms
 * `setInterval` poll (file-tailer.ts:85). Each tick runs `existsSync`, an
 * `openSync`/`fstatSync`/`closeSync` size read and a 64-byte head fingerprint
 * read, per tailed file, for the life of the process. The dev-dashboard holds
 * several of these open permanently. Raising or removing the poll is only safe
 * if appends still arrive, so this measures idle burn AND asserts that all
 * 1000 appended JSONL lines are delivered.
 *
 * THE POLL IS WHAT IS MEASURED, ON PURPOSE. `armClosedWatcherState()` runs
 * before the first run and puts `fs.watch` into the degraded state every
 * long-lived tailer host reaches (see its doc comment). In that state the
 * 300 ms poll is the only delivery path, so `appendLatencyMs` tracks the poll
 * interval exactly and a change to it cannot pass unnoticed. Without the
 * arming step, run 1 measures around 4 ms through a healthy `fs.watch` and
 * runs 2+ measure 300 ms, and the recorded median would depend on `--runs`.
 *
 * `withFsCounter` DOES NOT SEE THIS MODULE. `file-tailer.ts` imports its fs
 * functions as ES named bindings (`import { closeSync, existsSync, … } from
 * "node:fs"`), and a named import binds the function VALUE at import time, so
 * patching the `node:fs` module object afterwards cannot reach it. The counter
 * is still run, with a deliberate positive control: `CONTROL_FS_CALLS` calls
 * made through the module object inside the same window. `idleFsCalls` is the
 * total minus that control, so a reading of 0 next to a control that counted
 * proves "not intercepted" rather than "no calls happened". Idle CPU is the
 * metric that actually carries the poll's cost here.
 *
 * Usage:
 *   bun scripts/benchmarks/fs/utils-FileTailer.ts --baseline
 *   bun scripts/benchmarks/fs/utils-FileTailer.ts --compare
 *   bun scripts/benchmarks/fs/utils-FileTailer.ts --runs 5 --json
 */
import fs, { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BaselineMetrics } from "@app/benchmark/lib";
import { sampleSelf, withFsCounter } from "@app/benchmark/lib";
import { FileTailer } from "@genesiscz/utils/fs/file-tailer";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import {
    armClosedWatcherState,
    benchTmpDir,
    finishBench,
    MarkerWaiter,
    parseBenchArgs,
    type SampleSummary,
    sleep,
    summarize,
} from "./shared";

const { log } = logger.scoped("bench-file-tailer");

const BASELINE_NAME = "fs-file-tailer";
const IDLE_WINDOW_MS = 5_000;
const BATCHES = 10;
const LINES_PER_BATCH = 100;
const TOTAL_LINES = BATCHES * LINES_PER_BATCH;
const MARKER_TIMEOUT_MS = 15_000;
/** Arms the fs counter inside the measured window so a zero can be read correctly. */
const CONTROL_FS_CALLS = 5;

interface TailedLine {
    marker?: string;
    seq: number;
}

function batchPayload(batch: number, marker: string): string {
    const lines: string[] = [];

    for (let index = 0; index < LINES_PER_BATCH; index++) {
        const seq = batch * LINES_PER_BATCH + index;
        const entry: TailedLine = index === LINES_PER_BATCH - 1 ? { seq, marker } : { seq };
        lines.push(SafeJSON.stringify(entry));
    }

    return `${lines.join("\n")}\n`;
}

/** A negative `runIndex` is a discarded warm-up run. */
interface RunResult {
    metrics: BaselineMetrics;
    dir: string;
    controlCounted: number;
    appendSamples: SampleSummary;
}

async function runOnce(runIndex: number): Promise<RunResult> {
    const label = runIndex < 0 ? "warmup" : `run${runIndex + 1}`;
    const dir = benchTmpDir(`file-tailer-${label}`);
    const path = join(dir, "feed.jsonl");
    writeFileSync(path, `${SafeJSON.stringify({ seq: -1 })}\n`);

    const waiter = new MarkerWaiter();
    let received = 0;

    const tailer = new FileTailer<TailedLine>(path, {
        onLine: (entry) => {
            received++;

            if (entry.marker !== undefined) {
                waiter.feed(entry.marker);
            }
        },
    });
    tailer.start();
    log.debug({ path }, "FileTailer started");

    const counted = await withFsCounter(async () => {
        const sample = await sampleSelf({ windowMs: IDLE_WINDOW_MS, countThreads: false });

        for (let index = 0; index < CONTROL_FS_CALLS; index++) {
            fs.statSync(path);
        }

        return sample;
    });
    const idle = counted.result;
    const controlCounted = counted.calls.statSync ?? 0;
    const idleFsCalls = Math.max(0, counted.total - CONTROL_FS_CALLS);

    if (received !== 0) {
        throw new Error(`FileTailer delivered ${received} lines during an idle window that appended nothing`);
    }

    const nonce = `${Date.now().toString(36)}${label}`;
    const latencies: number[] = [];
    const throughputStart = performance.now();

    for (let batch = 0; batch < BATCHES; batch++) {
        const marker = `GTBENCH-TAILER-${nonce}-${batch}`;
        const payload = batchPayload(batch, marker);
        const startedAt = performance.now();
        appendFileSync(path, payload);
        const arrivedAt = await waiter.wait(marker, MARKER_TIMEOUT_MS);
        latencies.push(arrivedAt - startedAt);
    }

    const throughputMs = performance.now() - throughputStart;
    // The marker sits on the batch's LAST line, so a resolved wait means every
    // earlier line of that batch was already delivered; a short settle only
    // covers a handler still draining the final chunk.
    await sleep(200);
    tailer.stop();

    const appendSamples = summarize(latencies);

    return {
        dir,
        controlCounted,
        appendSamples,
        metrics: {
            idleCpuPercent: idle.cpuPercent,
            idleCpuTimeMs: idle.cpuTimeMs,
            idleRssBytes: idle.rssBytes,
            idleFsCalls,
            appendLatencyMs: appendSamples.median,
            linesPerSec: (TOTAL_LINES / throughputMs) * 1000,
            linesReceived: received,
        },
    };
}

const args = parseBenchArgs(Bun.argv.slice(2));
armClosedWatcherState(benchTmpDir("file-tailer-arm"));
const runs: BaselineMetrics[] = [];
const dirs: string[] = [];
const appendSamples: SampleSummary[] = [];
let controlCounted = 0;

for (let index = 0; index < args.warmup; index++) {
    out.log.step(`warm-up run ${index + 1} of ${args.warmup} (discarded)`);
    await runOnce(-1);
}

for (let index = 0; index < args.runs; index++) {
    out.log.step(`run ${index + 1} of ${args.runs} — ${TOTAL_LINES} JSONL lines in ${BATCHES} batches`);
    const result = await runOnce(index);
    runs.push(result.metrics);
    dirs.push(result.dir);
    appendSamples.push(result.appendSamples);
    controlCounted = result.controlCounted;
}

await finishBench({
    name: BASELINE_NAME,
    title: "FileTailer (src/utils/fs/file-tailer.ts)",
    args,
    runs,
    lowerIsBetter: ["idleCpuPercent", "idleCpuTimeMs", "idleRssBytes", "idleFsCalls", "appendLatencyMs"],
    // 0.28% versus 0.37% of a core over 5 s is 4 ms of CPU: noise, not a regression.
    floor: { idleCpuPercent: 0.2, idleCpuTimeMs: 10 },
    notes: `runs=${args.runs} warmup=${args.warmup} idleWindowMs=${IDLE_WINDOW_MS} batches=${BATCHES} linesPerBatch=${LINES_PER_BATCH}`,
    context: {
        scratchDirs: dirs,
        appendSamplesPerRun: appendSamples,
        fsCounterInterceptedTarget: false,
        fsCounterControlCalls: CONTROL_FS_CALLS,
        fsCounterControlCounted: controlCounted,
        fsCounterNote:
            "file-tailer.ts uses node:fs NAMED imports, which bind the function value at import time, so withFsCounter cannot intercept them; the control proves the counter was armed.",
    },
});
