import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeRecursive } from "@genesiscz/utils/fs";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { ImportGraph } from "./types";

const prof = profiler.scope("ts");
const WORKER = join(import.meta.dir, "measure-worker.ts");

export interface MeasureOptions {
    graph: ImportGraph;
    /**
     * Deadline for ONE import inside the worker. Defaults to a third of `timeoutMs`, so a run
     * survives a few hanging modules instead of being killed by the first.
     */
    moduleTimeoutMs?: number;
    /** Post-order module ids (children first). Only "file" and "package" nodes are importable. */
    order: string[];
    /** Fresh processes per mode; the minimum per module is kept. */
    runs: number;
    /** Kill a worker that has not finished after this long. Partial results survive. */
    timeoutMs: number;
    /** Working directory for the worker, so package resolution matches the entry's. */
    cwd: string;
}

export interface WorkerSample {
    ms: number;
    /**
     * `hang`: the import had not settled after the per-module deadline. Its `ms` is the deadline,
     * not a measurement, so it is a LOWER BOUND and must never be presented as a self time.
     */
    status: "ok" | "exit" | "error" | "hang";
    message?: string;
}

export interface MeasureResult {
    /** Best (minimum) self time per module id, over every run. */
    self: Map<string, WorkerSample>;
    /** Best cold import of the entry (the last plan line) in a process that imported nothing else. */
    cold: WorkerSample | undefined;
    stderr: string;
    timedOut: boolean;
}

function parseResults(text: string): Map<number, WorkerSample> {
    const samples = new Map<number, WorkerSample>();

    for (const line of text.split("\n")) {
        if (line.length === 0) {
            continue;
        }

        const [index, ms, status, message] = line.split("\t");
        const parsedIndex = Number.parseInt(index, 10);
        const parsedMs = Number.parseFloat(ms);

        if (Number.isNaN(parsedIndex) || Number.isNaN(parsedMs)) {
            continue;
        }

        samples.set(parsedIndex, {
            ms: parsedMs,
            status: status === "exit" || status === "error" || status === "hang" ? status : "ok",
            message,
        });
    }

    return samples;
}

async function runWorker(options: {
    planPath: string;
    outPath: string;
    mode: "each" | "cold";
    cwd: string;
    timeoutMs: number;
    moduleTimeoutMs: number;
}): Promise<{ samples: Map<number, WorkerSample>; stderr: string; timedOut: boolean }> {
    writeFileSync(options.outPath, "");
    logger.debug({ mode: options.mode, plan: options.planPath, worker: WORKER }, "ts: spawning measure worker");

    const proc = Bun.spawn({
        cmd: [process.execPath, "run", WORKER],
        cwd: options.cwd,
        // stdin closed: a module that opens a prompt fails at once instead of waiting on a TTY.
        // stdout dropped: commander help and stray console.log are not part of the protocol.
        stdio: ["ignore", "ignore", "pipe"],
        env: {
            ...process.env,
            GT_TS_PLAN: options.planPath,
            GT_TS_OUT: options.outPath,
            GT_TS_MODE: options.mode,
            GT_TS_MODULE_MS: String(options.moduleTimeoutMs),
            // A module that reads these at import time would otherwise open prompts or colour.
            FORCE_COLOR: "0",
            NO_COLOR: "1",
        },
    });

    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
    }, options.timeoutMs);
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    clearTimeout(timer);

    if (timedOut) {
        logger.warn({ mode: options.mode, timeoutMs: options.timeoutMs }, "ts: measure worker timed out");
    }

    return { samples: parseResults(readFileSync(options.outPath, "utf8")), stderr, timedOut };
}

function keepBest(into: Map<string, WorkerSample>, id: string, sample: WorkerSample): void {
    const current = into.get(id);

    if (!current || sample.ms < current.ms) {
        into.set(id, sample);
    }
}

/**
 * Time every module in `order` inside fresh `bun` processes. Per run, ONE process imports the
 * whole plan children-first, so each import's duration is that module's own evaluation (its
 * children are already cached). A separate process imports only the entry, which is the number
 * a user actually pays. Each mode runs `runs` times and the minimum is kept: startup cost is a
 * floor, so the minimum is the estimate least polluted by whatever else the machine was doing.
 */
export async function measureGraph(options: MeasureOptions): Promise<MeasureResult> {
    const importable = options.order.filter((id) => {
        const node = options.graph.nodes.get(id);
        return node !== undefined && (node.kind === "file" || node.kind === "package");
    });
    const dir = mkdtempSync(join(tmpdir(), "gt-ts-measure-"));
    const planPath = join(dir, "plan.txt");
    writeFileSync(planPath, `${importable.join("\n")}\n`);

    const eachModuleTimeoutMs = options.moduleTimeoutMs ?? Math.max(1_000, Math.floor(options.timeoutMs / 3));
    // Cold imports the entry in an empty process: that import IS the whole graph, so the
    // per-module deadline has to be the outer timeout, not a third of it.
    const coldModuleTimeoutMs = options.moduleTimeoutMs ?? options.timeoutMs;
    const self = new Map<string, WorkerSample>();
    let cold: WorkerSample | undefined;
    let stderr = "";
    let timedOut = false;

    try {
        for (let run = 0; run < options.runs; run++) {
            const each = await prof.measureAsync(`each run ${run + 1}`, () =>
                runEachPlan({
                    importable,
                    dir,
                    run,
                    cwd: options.cwd,
                    timeoutMs: options.timeoutMs,
                    moduleTimeoutMs: eachModuleTimeoutMs,
                })
            );
            timedOut = timedOut || each.timedOut;
            stderr = each.stderr.length > stderr.length ? each.stderr : stderr;

            for (const [id, sample] of each.self) {
                keepBest(self, id, sample);
            }

            const coldRun = await prof.measureAsync(`cold run ${run + 1}`, () =>
                runWorker({
                    planPath,
                    outPath: join(dir, `cold-${run}.tsv`),
                    mode: "cold",
                    cwd: options.cwd,
                    timeoutMs: options.timeoutMs,
                    moduleTimeoutMs: coldModuleTimeoutMs,
                })
            );
            timedOut = timedOut || coldRun.timedOut;
            const coldSample = coldRun.samples.get(importable.length - 1);

            if (coldSample && (!cold || coldSample.ms < cold.ms)) {
                cold = coldSample;
            }
        }

        logger.debug({ measured: self.size, planned: importable.length, cold: cold?.ms, timedOut }, "ts: measured");
        return { self, cold, stderr, timedOut };
    } finally {
        removeRecursive(dir);
    }
}

/**
 * One `each` plan may take several workers: a hang `realExit`s so later lines are not timed
 * inside a process that is still evaluating the hung module. The tail (skipping the hung id)
 * runs in a fresh worker.
 */
async function runEachPlan(options: {
    importable: string[];
    dir: string;
    run: number;
    cwd: string;
    timeoutMs: number;
    moduleTimeoutMs: number;
}): Promise<{ self: Map<string, WorkerSample>; stderr: string; timedOut: boolean }> {
    const self = new Map<string, WorkerSample>();
    let stderr = "";
    let timedOut = false;
    let offset = 0;

    while (offset < options.importable.length) {
        const slice = options.importable.slice(offset);
        const slicePlan = join(options.dir, `plan-each-${options.run}-${offset}.txt`);
        writeFileSync(slicePlan, `${slice.join("\n")}\n`);
        const each = await runWorker({
            planPath: slicePlan,
            outPath: join(options.dir, `each-${options.run}-${offset}.tsv`),
            mode: "each",
            cwd: options.cwd,
            timeoutMs: options.timeoutMs,
            moduleTimeoutMs: options.moduleTimeoutMs,
        });
        timedOut = timedOut || each.timedOut;
        stderr = each.stderr.length > stderr.length ? each.stderr : stderr;

        let hangIndex: number | undefined;
        let lastIndex = -1;

        for (const [index, sample] of each.samples) {
            const id = slice[index];

            if (!id) {
                continue;
            }

            keepBest(self, id, sample);
            lastIndex = Math.max(lastIndex, index);

            if (sample.status === "hang") {
                hangIndex = index;
            }
        }

        if (each.timedOut) {
            break;
        }

        if (hangIndex !== undefined) {
            offset += hangIndex + 1;
            continue;
        }

        if (lastIndex < slice.length - 1) {
            logger.warn(
                { run: options.run, offset, lastIndex, planned: slice.length },
                "ts: measure worker exited before the plan ended"
            );
        }

        break;
    }

    return { self, stderr, timedOut };
}
