#!/usr/bin/env bun
/**
 * Regression benchmark for `tools watch --follow <glob>` (`src/watch/index.ts`).
 *
 * WHAT IT PROTECTS. `src/watch/index.ts` is about to lose its 50 ms
 * `setInterval` (index.ts:588), which runs `existsSync` + `statSync` over every
 * matched file on top of chokidar `usePolling: true, interval: 100`, a per-file
 * `fs.watch`, and a full glob rescan every `--seconds`. Removing a watcher is
 * only safe if the events it was covering still arrive, so this script measures
 * the cost AND asserts the three behaviours that must survive: an append
 * prints, a brand-new matching file is discovered and printed, and Ctrl-C exits
 * cleanly.
 *
 * MEASURED BY SPAWNING THE FILE, NOT `tools watch`. `tools` on PATH runs the
 * MAIN repo checkout, so a branch under test would not be the code measured.
 * The child is `<bun> run src/watch/index.ts`, resolved from this file's repo.
 *
 * OUTPUT LANDS ON STDERR. `src/watch/index.ts` prints through `logger.info`,
 * and this repo's logger writes its console mirror to stderr. A run that only
 * captured stdout would see zero bytes and read as "the watcher printed
 * nothing". Both streams are merged into one marker buffer here.
 *
 * THREE APPEND PHASES, ON PURPOSE. The watcher installs one `fs.watch` per
 * matched file, and on bun 1.3.13 the first `FSWatcher.close()` in a process
 * leaves every watcher created after it deaf past one event. So a single
 * append number, taken on the first-watched file of a fresh process, can read
 * healthy while most of the process's watchers are dead. `appendLatencyMs`
 * (first-watched file), `appendLastWatchedLatencyMs` (last-watched file, the
 * control) and `appendAfterNewFileLatencyMs` (last-watched file after
 * discovery) agree on this baseline; a rewrite that makes them disagree has
 * changed which watcher actually delivers.
 *
 * SYSCALL COUNTING IS NOT INCLUDED. `fs_usage` on macOS refuses to run without
 * root ("'fs_usage' must be run as root..."), and this benchmark must stay
 * runnable unprivileged, so `syscallsPerSec` is deliberately absent. The idle
 * CPU number is the stand-in: the 50 ms loop's cost shows up there.
 *
 * Usage:
 *   bun scripts/benchmarks/fs/tools-watch.ts --baseline
 *   bun scripts/benchmarks/fs/tools-watch.ts --compare
 *   bun scripts/benchmarks/fs/tools-watch.ts --files 50 --runs 5 --json
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BaselineMetrics } from "@app/benchmark/lib";
import { sampleProcess } from "@app/benchmark/lib";
import { findProjectRoot } from "@genesiscz/utils/fs/project-root";
import { logger, out } from "@genesiscz/utils/logger";
import {
    type BenchArgs,
    benchTmpDir,
    finishBench,
    MarkerWaiter,
    parseBenchArgs,
    type SampleSummary,
    sleep,
    summarize,
} from "./shared";

const { log } = logger.scoped("bench-tools-watch");

const BASELINE_NAME = "fs-tools-watch";
const IDLE_WINDOW_MS = 5_000;
const APPEND_SAMPLES = 10;
const NEW_FILE_SAMPLES = 5;
/** Long enough that a slow machine does not fake a regression, short enough to fail fast. */
const MARKER_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 10_000;
/** chokidar's awaitWriteFinish is 50 ms; spacing appends wider keeps them separate events. */
const BETWEEN_EVENTS_MS = 400;

const foundRoot = findProjectRoot(import.meta.dir);

if (foundRoot === null) {
    throw new Error("Could not find the repo root from scripts/benchmarks/fs/tools-watch.ts");
}

const repoRoot = foundRoot;

function pump(stream: ReadableStream<Uint8Array>, waiter: MarkerWaiter): void {
    const decoder = new TextDecoder();

    void (async () => {
        try {
            for await (const chunk of stream) {
                waiter.feed(decoder.decode(chunk, { stream: true }));
            }
        } catch (err) {
            log.debug({ err }, "child output stream ended with an error");
        }
    })();
}

function seedFiles(dir: string, count: number): string[] {
    const paths: string[] = [];

    for (let index = 0; index < count; index++) {
        const path = join(dir, `seed-${String(index).padStart(3, "0")}.log`);
        writeFileSync(path, `seed line one for ${index}\nseed line two for ${index}\n`);
        paths.push(path);
    }

    return paths;
}

interface RunResult {
    metrics: BaselineMetrics;
    dir: string;
    samples: Record<string, SampleSummary>;
}

/** A negative `runIndex` is a discarded warm-up run. */
async function runOnce(args: BenchArgs, runIndex: number): Promise<RunResult> {
    const label = runIndex < 0 ? "warmup" : `run${runIndex + 1}`;
    const dir = benchTmpDir(`tools-watch-${label}`);
    const files = seedFiles(dir, args.files);
    const waiter = new MarkerWaiter();
    const nonce = `${Date.now().toString(36)}${label}`;

    const spawnedAt = performance.now();
    const child = Bun.spawn([process.execPath, "run", "src/watch/index.ts", "--follow", join(dir, "*.log")], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
    });
    log.debug({ pid: child.pid, dir, files: files.length }, "watcher child spawned");
    pump(child.stdout, waiter);
    pump(child.stderr, waiter);

    // The watcher prints this last, after the initial glob scan and every
    // per-file dump, so it is the only honest "idle now" signal.
    await waiter.wait("Watch-glob is running", READY_TIMEOUT_MS);
    const startupMs = performance.now() - spawnedAt;
    await waiter.wait("Watcher initialized and ready", READY_TIMEOUT_MS);
    await sleep(BETWEEN_EVENTS_MS);

    const idle = await sampleProcess(child.pid, { windowMs: IDLE_WINDOW_MS });

    if (!idle.alive) {
        throw new Error(`the watcher pid ${child.pid} could not be sampled; it probably died during the idle window`);
    }

    // The watcher installs one `fs.watch` per matched file in glob order, and
    // the bun defect below spares whichever one was created first. Measuring
    // only the first file would report a healthy sub-millisecond append for a
    // process whose other 19 watchers are deaf, so the first and last watched
    // files are measured separately.
    const firstWatched = files[0] as string;
    const lastWatched = files[files.length - 1] as string;

    async function measureAppends(tag: string, target: string): Promise<SampleSummary> {
        const latencies: number[] = [];

        for (let index = 0; index < APPEND_SAMPLES; index++) {
            const marker = `GTBENCH-${tag}-${nonce}-${index}`;
            const startedAt = performance.now();
            appendFileSync(target, `${marker}\n`);
            const arrivedAt = await waiter.wait(marker, MARKER_TIMEOUT_MS);
            latencies.push(arrivedAt - startedAt);
            await sleep(BETWEEN_EVENTS_MS);
        }

        return summarize(latencies);
    }

    const appendSamples = await measureAppends("APPEND", firstWatched);
    // Control for the phase below: before anything is rebuilt, a file's
    // position in the watch order must not change its append latency. If this
    // and `appendLatencyMs` ever diverge, the comparison after discovery means
    // nothing.
    const appendLastWatchedSamples = await measureAppends("APPENDLAST", lastWatched);
    const newFileLatencies: number[] = [];

    for (let index = 0; index < NEW_FILE_SAMPLES; index++) {
        const marker = `GTBENCH-NEWFILE-${nonce}-${index}`;
        const path = join(dir, `created-${nonce}-${index}.log`);
        const startedAt = performance.now();
        writeFileSync(path, `${marker}\n`);
        const arrivedAt = await waiter.wait(marker, MARKER_TIMEOUT_MS);
        newFileLatencies.push(arrivedAt - startedAt);
        await sleep(BETWEEN_EVENTS_MS);
    }

    // The same file as the control above, now that discovery has run.
    //
    // On this baseline it matches the control, and the reason matters. The only
    // path that closes a live watcher is `setupFileWatchers()`, which runs from
    // the rescan behind `currentFiles.length > matchedFiles.size`; chokidar's
    // `add` handler wins the race and inserts the file first, so that guard is
    // already false and no rebuild happens (verified with `--verbose`: "File
    // added event" appears, "Found N new file(s) during rescan" never does).
    //
    // The metric is here because a rewrite that reinstates a close-then-recreate
    // cycle would be invisible otherwise. On bun 1.3.13 the FIRST
    // `FSWatcher.close()` in a process leaves every watcher created after it
    // deaf past one event — measured directly: a fresh watcher on an untouched
    // file delivered 1 of 10 appends once any close had happened, against 10 of
    // 10 while nothing had been closed. A rebuild would therefore push this
    // number from under a millisecond up to the chokidar poll, and the 50 ms
    // interval at index.ts:588 would be the only thing keeping it lower.
    const appendAfterNewFileSamples = await measureAppends("APPEND2", lastWatched);
    const newFileSamples = summarize(newFileLatencies);

    child.kill("SIGINT");
    const exited = await Promise.race([child.exited, sleep(EXIT_TIMEOUT_MS).then(() => null)]);
    let exitedCleanly = 0;

    if (exited === 0) {
        exitedCleanly = 1;
    } else if (exited === null) {
        log.warn({ pid: child.pid }, "the watcher ignored SIGINT within the deadline; sending SIGKILL");
        child.kill("SIGKILL");
        await child.exited;
    } else {
        log.warn({ pid: child.pid, exitCode: exited }, "the watcher exited non-zero after SIGINT");
    }

    return {
        dir,
        samples: {
            append: appendSamples,
            appendLastWatched: appendLastWatchedSamples,
            newFile: newFileSamples,
            appendAfterNewFile: appendAfterNewFileSamples,
        },
        metrics: {
            startupMs,
            idleCpuPercent: idle.cpuPercent,
            idleCpuTimeMs: idle.cpuTimeMs,
            idleRssBytes: idle.rssBytes,
            appendLatencyMs: appendSamples.median,
            appendLastWatchedLatencyMs: appendLastWatchedSamples.median,
            newFileLatencyMs: newFileSamples.median,
            appendAfterNewFileLatencyMs: appendAfterNewFileSamples.median,
            exitedCleanly,
        },
    };
}

const args = parseBenchArgs(Bun.argv.slice(2));
const runs: BaselineMetrics[] = [];
const dirs: string[] = [];
const samples: Record<string, SampleSummary>[] = [];

for (let index = 0; index < args.warmup; index++) {
    out.log.step(`warm-up run ${index + 1} of ${args.warmup} (discarded)`);
    await runOnce(args, -1);
}

for (let index = 0; index < args.runs; index++) {
    out.log.step(`run ${index + 1} of ${args.runs} — ${args.files} watched files`);
    const result = await runOnce(args, index);
    runs.push(result.metrics);
    dirs.push(result.dir);
    samples.push(result.samples);
}

await finishBench({
    name: BASELINE_NAME,
    title: "tools watch --follow",
    args,
    runs,
    // fs.watch delivers an append in well under a millisecond either way; a 0.3 ms move is
    // scheduling jitter. Idle CPU is quantised to 0.2 points by ps's 10 ms resolution over 5 s.
    floor: {
        appendLatencyMs: 1,
        appendLastWatchedLatencyMs: 1,
        appendAfterNewFileLatencyMs: 1,
        idleCpuPercent: 0.2,
        idleCpuTimeMs: 10,
    },
    lowerIsBetter: [
        "startupMs",
        "idleCpuPercent",
        "idleCpuTimeMs",
        "idleRssBytes",
        "appendLatencyMs",
        "appendLastWatchedLatencyMs",
        "newFileLatencyMs",
        "appendAfterNewFileLatencyMs",
    ],
    notes: `files=${args.files} runs=${args.runs} warmup=${args.warmup} idleWindowMs=${IDLE_WINDOW_MS} appends=${APPEND_SAMPLES} newFiles=${NEW_FILE_SAMPLES}`,
    context: {
        scratchDirs: dirs,
        samplesPerRun: samples,
        bunVersion: Bun.version,
        outputStream: "stderr (src/watch/index.ts logs through logger.info)",
        syscallsPerSec: "skipped — fs_usage requires root on macOS",
        fsWatchNote:
            "bun 1.3.13 on darwin: once any FSWatcher.close() has run, every fs.watch created afterwards in that process delivers one event and then goes deaf. That is why appendLatencyMs and appendAfterNewFileLatencyMs are separate metrics.",
    },
});
