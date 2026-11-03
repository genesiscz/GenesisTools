/**
 * Peekaboo against the native recorder on the same scene, interleaved: `bun src/control/scripts/recorder-benchmark.ts
 * [--runs 3] [--seconds 60] [--out <dir>] [--only native|peekaboo]`.
 *
 * The scene (recorder-benchmark-scene.swift) is a small borderless panel in the bottom-right corner of every display
 * that flips colour and number every 2 s and logs each change; it never takes focus. Each run records every display
 * at once through FRAME_RECORDERS with the meetings defaults (1 fps active, 0.1 fps idle, long side 2880) and a 1 %
 * threshold, so the panel's change is above it. While it runs, the recorder's whole process tree is sampled every
 * 500 ms. Printed and saved as JSON: CPU (mean, p90, max), RSS (max), missed changes, gaps between kept frames while
 * the scene changes, samples with no CPU in a window with a change, and lag (a change to the kept frame's file).
 */
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureBinaryAsync } from "@app/control/lib/runner";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { tmpdir } from "@genesiscz/utils/paths";
import { descendantPids, readProcessUsages } from "@genesiscz/utils/process/processes";
import { FRAME_RECORDERS } from "@genesiscz/utils/screen-recorder/recorders";
import type { CaptureResult, DisplayInfo, FrameRecorderId } from "@genesiscz/utils/screen-recorder/types";
import { z } from "zod";

const { log } = logger.scoped("recorder-benchmark");

const SAMPLE_MS = 500;
const sceneEvent = z.object({ event: z.string(), at: z.number().optional() });
const CHANGE_EVERY_MS = 2_000;
const THRESHOLD_PERCENT = 1;

function flag(name: string): string | undefined {
    const at = process.argv.indexOf(name);
    return at >= 0 ? process.argv[at + 1] : undefined;
}

const runs = Number(flag("--runs") ?? 3);
const seconds = Number(flag("--seconds") ?? 60);
const only = flag("--only");
const outDir = flag("--out") ?? mkdtempSync(join(tmpdir({ preferRoot: false }), "recorder-benchmark-"));
mkdirSync(outDir, { recursive: true });

interface TreeSample {
    at: number;
    cpuPercent: number;
    rssBytes: number;
}

/** Samples the CPU and RSS of every descendant of this process except the scene, every SAMPLE_MS. */
function sampleTree(exclude: () => Set<number>): { stop: () => TreeSample[] } {
    const samples: TreeSample[] = [];
    const seen = new Map<number, number>();
    let last = performance.now();
    const timer = setInterval(() => {
        const skip = exclude();
        const pids = descendantPids(process.pid).filter((pid) => !skip.has(pid));
        const usages = readProcessUsages(pids);
        const now = performance.now();
        let cpuMs = 0;
        let rssBytes = 0;

        for (const [pid, usage] of usages) {
            cpuMs += Math.max(0, usage.cpuTimeMs - (seen.get(pid) ?? 0));
            seen.set(pid, usage.cpuTimeMs);
            rssBytes += usage.rssBytes;
        }

        samples.push({ at: Date.now(), cpuPercent: (cpuMs / (now - last)) * 100, rssBytes });
        last = now;
    }, SAMPLE_MS);
    return {
        stop: () => {
            clearInterval(timer);
            return samples;
        },
    };
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

const mean = (values: number[]) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0);

/** The scene helper, with the time of every change it made. */
async function startScene(): Promise<{ pid: number; changes: number[]; stop: () => void }> {
    const script = join(moduleDir(import.meta), "recorder-benchmark-scene.swift");
    const proc = Bun.spawn(["swift", script, String(CHANGE_EVERY_MS / 1000)], { stdout: "pipe", stderr: "inherit" });
    const changes: number[] = [];
    let ready: () => void = () => undefined;
    const isReady = new Promise<void>((resolve) => {
        ready = resolve;
    });
    void (async () => {
        let pending = "";

        for await (const chunk of proc.stdout) {
            pending += new TextDecoder().decode(chunk);
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";

            for (const line of lines.filter(Boolean)) {
                const event = sceneEvent.parse(SafeJSON.parse(line, { strict: true }));

                if (event.event === "ready") {
                    ready();
                } else if (event.event === "change" && event.at) {
                    changes.push(event.at);
                }
            }
        }
    })();
    const deadline = setTimeout(() => ready(), 60_000);
    await isReady;
    clearTimeout(deadline);
    return { pid: proc.pid, changes, stop: () => proc.kill("SIGTERM") };
}

/** The frontmost app, to show that the scene never took the focus. */
function frontmostApp(): string {
    const front = Bun.spawnSync(["lsappinfo", "front"], { stdout: "pipe" }).stdout.toString().trim();
    const info = Bun.spawnSync(["lsappinfo", "info", "-only", "name", front], { stdout: "pipe" }).stdout.toString();
    return info.match(/"([^"]+)"/)?.[1] ?? info.trim().slice(0, 80);
}

/** `main`: the main display only; `all`: every display at once (peekaboo cannot, it holds one capture lock). */
type Scope = "main" | "all";

interface RunResult {
    backend: FrameRecorderId;
    scope: Scope;
    run: number;
    displays: number;
    frames: number;
    cpu: { mean: number; p90: number; max: number };
    rssMaxMb: number;
    changes: number;
    missed: number;
    /** Largest gap between two kept frames of one display while the scene changed, in ms. */
    maxGapMs: number;
    /** Gaps longer than twice the change interval. */
    longGaps: number;
    starvedSamples: number;
    lagMs: { mean: number; p90: number; max: number };
    errors: string[];
}

async function oneRun(options: {
    backend: FrameRecorderId;
    scope: Scope;
    run: number;
    scene: { pid: number; changes: number[] };
}): Promise<RunResult> {
    const { backend, scope, run, scene } = options;
    const recorder = FRAME_RECORDERS[backend]({ axTool: async (options) => [await ensureBinaryAsync(options)] });
    const ready = await recorder.available();

    if (!ready.ok) {
        throw new Error(`${backend} is not available: ${ready.reason}`);
    }

    const connected: DisplayInfo[] = await recorder.displays();
    const displays = scope === "all" ? connected : connected.filter((display) => display.main);
    const sceneTree = () => new Set([scene.pid, ...descendantPids(scene.pid)]);
    const sampler = sampleTree(sceneTree);
    const startedAt = Date.now();
    const settled = await Promise.allSettled(
        displays.map((display) => {
            const dir = join(outDir, `${backend}-${scope}-${run}-d${display.id}`);
            mkdirSync(dir, { recursive: true });
            return recorder.capture({
                target: { kind: "display", displayId: display.id },
                durationSec: seconds,
                activeFps: 1,
                idleFps: 0.1,
                thresholdPercent: THRESHOLD_PERCENT,
                maxLongSidePx: 2880,
                outDir: dir,
            });
        })
    );
    const endedAt = Date.now();
    const samples = sampler.stop();
    const changes = scene.changes.filter((at) => at >= startedAt + 3_000 && at <= endedAt - 2_000);
    const errors: string[] = [];
    const lags: number[] = [];
    let frames = 0;
    let missed = 0;
    let maxGapMs = 0;
    let longGaps = 0;

    for (const [index, outcome] of settled.entries()) {
        if (outcome.status === "rejected") {
            errors.push(
                `display ${displays[index]?.id}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`
            );
            missed += changes.length;
            continue;
        }

        const landed = landedTimes(outcome.value);
        frames += landed.length;

        for (const change of changes) {
            const first = landed.find((at) => at >= change);

            if (first === undefined || first - change > CHANGE_EVERY_MS) {
                missed += 1;
            } else {
                lags.push(first - change);
            }
        }

        const during = landed.filter((at) => at >= (changes[0] ?? 0) && at <= (changes.at(-1) ?? 0) + CHANGE_EVERY_MS);

        for (let i = 1; i < during.length; i++) {
            const gap = (during[i] ?? 0) - (during[i - 1] ?? 0);
            maxGapMs = Math.max(maxGapMs, gap);
            longGaps += gap > 2 * CHANGE_EVERY_MS ? 1 : 0;
        }
    }

    const starvedSamples = samples.filter(
        (sample) => sample.cpuPercent === 0 && changes.some((at) => at <= sample.at && at > sample.at - SAMPLE_MS)
    ).length;
    const cpu = samples.slice(1).map((sample) => sample.cpuPercent);
    return {
        backend,
        scope,
        run,
        displays: displays.length,
        frames,
        cpu: { mean: mean(cpu), p90: percentile(cpu, 90), max: Math.max(0, ...cpu) },
        rssMaxMb: Math.max(0, ...samples.map((sample) => sample.rssBytes)) / 1_000_000,
        changes: changes.length * displays.length,
        missed,
        maxGapMs,
        longGaps,
        starvedSamples,
        lagMs: { mean: mean(lags), p90: percentile(lags, 90), max: Math.max(0, ...lags) },
        errors,
    };
}

/** When each kept frame reached the disk: the same clock for both recorders. */
function landedTimes(result: CaptureResult): number[] {
    return result.frames
        .map((frame) => statSync(frame.path, { throwIfNoEntry: false })?.mtimeMs)
        .filter((at): at is number => at !== undefined)
        .sort((a, b) => a - b);
}

const plan: Array<{ backend: FrameRecorderId; scope: Scope }> = [
    { backend: "native", scope: "main" },
    { backend: "peekaboo", scope: "main" },
    { backend: "native", scope: "all" },
].filter((one): one is { backend: FrameRecorderId; scope: Scope } => !only || one.backend === only);
const frontBefore = frontmostApp();
const scene = await startScene();
const results: RunResult[] = [];

try {
    for (let run = 1; run <= runs; run++) {
        for (const { backend, scope } of plan) {
            log.info({ backend, scope, run }, "benchmark run");
            const result = await oneRun({ backend, scope, run, scene }).catch((error: unknown) => {
                log.warn({ error, backend, scope, run }, "benchmark run failed");
                return undefined;
            });

            if (result) {
                results.push(result);
                process.stderr.write(`${SafeJSON.stringify(result)}\n`);
            }
        }
    }
} finally {
    scene.stop();
}

const frontAfter = frontmostApp();
const summary = { runs, seconds, thresholdPercent: THRESHOLD_PERCENT, frontBefore, frontAfter, outDir, results };
writeFileSync(join(outDir, "results.json"), SafeJSON.stringify(summary, null, 2));
process.stdout.write(`${SafeJSON.stringify(summary, null, 2)}\n`);
