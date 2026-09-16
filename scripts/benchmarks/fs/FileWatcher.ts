#!/usr/bin/env bun
/**
 * Regression benchmark for `FileWatcher` (`src/utils/storage/fs.ts`).
 *
 * WHAT IT PROTECTS. `FileWatcher` is the byte-append sibling of `FileTailer`:
 * an `fs.watch` plus a 300 ms `setInterval` poll (storage/fs.ts:52), each tick
 * running a `statSync` on the watched path. It backs `ClaudeSessionTailer` and
 * `debugging-master`'s own tailer, so one long-lived process can hold many.
 * Beyond idle cost and append latency it asserts the one behaviour that is
 * easy to break when the poll is touched: a truncate must fire `onTruncated`
 * and the watcher must keep delivering afterwards.
 *
 * THE POLL IS WHAT IS MEASURED, ON PURPOSE. `armClosedWatcherState()` runs
 * before the first run and puts `fs.watch` into the degraded state every
 * long-lived tailer host reaches (see its doc comment). In that state the
 * 300 ms poll is the only delivery path, so `appendLatencyMs` tracks the poll
 * interval exactly and a change to it cannot pass unnoticed. Without the
 * arming step, run 1 measures a few milliseconds through a healthy `fs.watch`
 * and runs 2+ measure 300 ms, and the median would depend on `--runs`.
 *
 * `withFsCounter` DOES NOT SEE THIS MODULE, for the same reason as
 * `FileTailer`: `storage/fs.ts` imports `statSync`, `openSync`, `readSync` and
 * `closeSync` as ES named bindings, which capture the function value at import
 * time. The counter runs anyway with `CONTROL_FS_CALLS` calls made through the
 * module object inside the window, so a zero can be read as "not intercepted"
 * rather than "nothing happened". Idle CPU carries the poll's real cost.
 *
 * Usage:
 *   bun scripts/benchmarks/fs/FileWatcher.ts --baseline
 *   bun scripts/benchmarks/fs/FileWatcher.ts --compare
 *   bun scripts/benchmarks/fs/FileWatcher.ts --runs 5 --json
 */
import fs, { appendFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BaselineMetrics } from "@app/benchmark/lib";
import { sampleSelf, withFsCounter } from "@app/benchmark/lib";
import { logger, out } from "@genesiscz/utils/logger";
import { FileWatcher } from "@genesiscz/utils/storage/fs";
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

const { log } = logger.scoped("bench-file-watcher");

const BASELINE_NAME = "fs-file-watcher";
const IDLE_WINDOW_MS = 5_000;
const APPEND_SAMPLES = 10;
const POLL_INTERVAL_MS = 300;
const MARKER_TIMEOUT_MS = 15_000;
/** Two poll intervals, so the shrink is observed before anything regrows the file. */
const TRUNCATE_SETTLE_MS = POLL_INTERVAL_MS * 2;
/** Arms the fs counter inside the measured window so a zero can be read correctly. */
const CONTROL_FS_CALLS = 5;

/** A negative `runIndex` is a discarded warm-up run. */
interface RunResult {
    metrics: BaselineMetrics;
    dir: string;
    controlCounted: number;
    appendSamples: SampleSummary;
    postTruncateLatencyMs: number;
}

async function runOnce(runIndex: number): Promise<RunResult> {
    const label = runIndex < 0 ? "warmup" : `run${runIndex + 1}`;
    const dir = benchTmpDir(`file-watcher-${label}`);
    const path = join(dir, "append.log");
    writeFileSync(path, "seed line\n");

    const waiter = new MarkerWaiter();
    let truncations = 0;

    const watcher = new FileWatcher({
        filePath: path,
        pollInterval: POLL_INTERVAL_MS,
        onData: (bytes) => {
            waiter.feed(bytes.toString("utf8"));
        },
        onTruncated: () => {
            truncations++;
        },
    });
    watcher.start();
    log.debug({ path }, "FileWatcher started");

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

    const nonce = `${Date.now().toString(36)}${label}`;
    const latencies: number[] = [];

    for (let index = 0; index < APPEND_SAMPLES; index++) {
        const marker = `GTBENCH-WATCHER-${nonce}-${index}`;
        const startedAt = performance.now();
        appendFileSync(path, `${marker}\n`);
        const arrivedAt = await waiter.wait(marker, MARKER_TIMEOUT_MS);
        latencies.push(arrivedAt - startedAt);
    }

    // Truncation contract: the shrink must be reported, and the watcher must
    // resume delivering afterwards rather than going silent on a stale offset.
    truncateSync(path, 0);
    await sleep(TRUNCATE_SETTLE_MS);
    const truncateDetected = truncations > 0 ? 1 : 0;

    if (truncateDetected === 0) {
        log.warn({ path }, "onTruncated never fired after truncateSync");
    }

    const postMarker = `GTBENCH-POSTTRUNCATE-${nonce}`;
    const postStartedAt = performance.now();
    appendFileSync(path, `${postMarker}\n`);
    const postArrivedAt = await waiter.wait(postMarker, MARKER_TIMEOUT_MS);
    watcher.stop();

    const appendSamples = summarize(latencies);

    return {
        dir,
        controlCounted,
        appendSamples,
        // Reported, not gated. Recovery after a truncate lands in well under a
        // millisecond, so ordinary scheduling jitter of a few tenths reads as a
        // three-figure percentage change and would fail a tolerance check that
        // means nothing. The contract it stands for is enforced two other ways:
        // `truncateDetected` gates that `onTruncated` fired, and the wait for
        // the post-truncate marker throws on timeout, so a watcher that goes
        // silent after a truncate fails the run outright instead of recording
        // a number.
        postTruncateLatencyMs: postArrivedAt - postStartedAt,
        metrics: {
            idleCpuPercent: idle.cpuPercent,
            idleCpuTimeMs: idle.cpuTimeMs,
            idleRssBytes: idle.rssBytes,
            idleFsCalls,
            appendLatencyMs: appendSamples.median,
            truncateDetected,
        },
    };
}

const args = parseBenchArgs(Bun.argv.slice(2));
armClosedWatcherState(benchTmpDir("file-watcher-arm"));
const runs: BaselineMetrics[] = [];
const dirs: string[] = [];
const appendSamples: SampleSummary[] = [];
const postTruncateLatencies: number[] = [];
let controlCounted = 0;

for (let index = 0; index < args.warmup; index++) {
    out.log.step(`warm-up run ${index + 1} of ${args.warmup} (discarded)`);
    await runOnce(-1);
}

for (let index = 0; index < args.runs; index++) {
    out.log.step(`run ${index + 1} of ${args.runs} — ${APPEND_SAMPLES} appends plus a truncate`);
    const result = await runOnce(index);
    runs.push(result.metrics);
    dirs.push(result.dir);
    appendSamples.push(result.appendSamples);
    postTruncateLatencies.push(result.postTruncateLatencyMs);
    controlCounted = result.controlCounted;
}

await finishBench({
    name: BASELINE_NAME,
    title: "FileWatcher (src/utils/storage/fs.ts)",
    args,
    runs,
    lowerIsBetter: ["idleCpuPercent", "idleCpuTimeMs", "idleRssBytes", "idleFsCalls", "appendLatencyMs"],
    // 0.16% versus 0.19% of a core over 5 s is 2 ms of CPU: noise, not a regression.
    floor: { idleCpuPercent: 0.2, idleCpuTimeMs: 10 },
    notes: `runs=${args.runs} warmup=${args.warmup} idleWindowMs=${IDLE_WINDOW_MS} appends=${APPEND_SAMPLES} pollIntervalMs=${POLL_INTERVAL_MS}`,
    context: {
        scratchDirs: dirs,
        appendSamplesPerRun: appendSamples,
        fsCounterInterceptedTarget: false,
        fsCounterControlCalls: CONTROL_FS_CALLS,
        fsCounterControlCounted: controlCounted,
        fsCounterNote:
            "storage/fs.ts uses node:fs NAMED imports, which bind the function value at import time, so withFsCounter cannot intercept them; the control proves the counter was armed.",
    },
});
