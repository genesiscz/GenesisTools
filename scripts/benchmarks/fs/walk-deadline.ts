#!/usr/bin/env bun
/**
 * How `walkFiles` (`@genesiscz/utils/fs/disk-usage`) and the doctor's `measurePath` honour a stop, on real trees
 * (read-only). PR #515 thread t2: the doctor's deadline was checked only between yielded files and before each
 * subdirectory, so the listing of one directory (`getattrlistbulk` buffers every entry before the first yield)
 * ran to its end whatever the deadline said.
 *
 * ARMS, interleaved per run, all in this process (the warm-up run warms the vnode cache, so every measured run
 * reads warm metadata):
 *   - `full`: `walkFiles(root)` with no options. What every caller pays; a stop check must not move it.
 *   - `signal`: a signal that never aborts. The cost of the signal checks.
 *   - `far`: `deadlineAt` an hour away. The cost of the clock checks.
 *   - `deadline`: `deadlineAt` 50 ms away. CPU, files yielded, and `overrunMs` (wall ms from the deadline to the
 *     moment the walk returned). Code without `deadlineAt` ignores it and walks the whole tree.
 *   - `doctor`: `measurePath(root, { deadlineMs: 50 })`, the doctor's real call, with the same overrun.
 *
 * The recorded baseline walked this repo's node_modules (9,169 directories, 87,854 files) and one flat browser cache
 * directory (27,813 files in one listing, the case the doctor missed). Compare with the same roots, since a metric
 * is named after its root's folder:
 *   bun scripts/benchmarks/fs/walk-deadline.ts --compare --runs 5 --root "$PWD/node_modules" \
 *       --root ~/Library/Caches/BraveSoftware/Brave-Browser/Default/Cache/Cache_Data
 * With no --root it walks this repo's node_modules only. `--baseline` records, `--json` prints the result.
 */
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { BaselineMetrics } from "@app/benchmark/lib";
import { measurePath } from "@app/doctor/lib/fs-measure";
import { type WalkOptions, walkFiles } from "@genesiscz/utils/fs/disk-usage";
import { finishBench, parseBenchArgs } from "./shared";

const BASELINE_NAME = "fs-walk-deadline";
const REPO = join(import.meta.dir, "..", "..", "..");
const DEADLINE_MS = 50;
const ARMS = ["full", "signal", "far", "deadline", "doctor"] as const;
type Arm = (typeof ARMS)[number];

interface ArmSample {
    cpuMs: number;
    files: number;
    /** Wall ms the walk ran past its deadline; only the two deadline arms report it. */
    overrunMs?: number;
}

function rootsFrom(argv: string[]): Record<string, string> {
    const roots: Record<string, string> = {};

    for (let i = 0; i < argv.length; i++) {
        if (argv[i] !== "--root") {
            continue;
        }

        const value = argv[i + 1];

        if (!value) {
            throw new Error("--root needs a directory");
        }

        const path = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
        roots[basename(path)] = path;
    }

    if (Object.keys(roots).length === 0) {
        roots.node_modules = join(REPO, "node_modules");
    }

    return roots;
}

function cpuMsSince(start: NodeJS.CpuUsage): number {
    const used = process.cpuUsage(start);
    return (used.user + used.system) / 1000;
}

/** A thrown stop is the expected end of the deadline arm; anything else is a real failure. */
function isStop(err: unknown): boolean {
    return err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
}

function walkArm(root: string, opts: WalkOptions, deadlineAt?: number): ArmSample {
    const start = process.cpuUsage();
    let files = 0;

    try {
        for (const _entry of walkFiles(root, opts)) {
            files++;
        }
    } catch (err) {
        if (!isStop(err)) {
            throw err;
        }
    }

    const sample: ArmSample = { cpuMs: cpuMsSince(start), files };

    if (deadlineAt !== undefined) {
        sample.overrunMs = Math.max(0, Date.now() - deadlineAt);
    }

    return sample;
}

function sample(arm: Arm, root: string): ArmSample {
    switch (arm) {
        case "full":
            return walkArm(root, {});
        case "signal":
            return walkArm(root, { signal: new AbortController().signal });
        case "far":
            return walkArm(root, { deadlineAt: Date.now() + 3_600_000 });
        case "deadline": {
            const deadlineAt = Date.now() + DEADLINE_MS;
            return walkArm(root, { deadlineAt }, deadlineAt);
        }
        case "doctor": {
            const deadlineAt = Date.now() + DEADLINE_MS;
            const start = process.cpuUsage();
            const size = measurePath(root, { deadlineMs: DEADLINE_MS, maxEntries: Number.MAX_SAFE_INTEGER });
            return {
                cpuMs: cpuMsSince(start),
                files: size?.entries ?? 0,
                overrunMs: Math.max(0, Date.now() - deadlineAt),
            };
        }
    }
}

const argv = process.argv.slice(2);
const args = parseBenchArgs(argv);
const roots = rootsFrom(argv);
const runs: BaselineMetrics[] = [];

for (let i = 0; i < args.warmup + args.runs; i++) {
    const metrics: BaselineMetrics = {};

    for (const [name, root] of Object.entries(roots)) {
        for (const arm of ARMS) {
            const { cpuMs, files, overrunMs } = sample(arm, root);
            metrics[`${name}.${arm}.cpuMs`] = cpuMs;
            metrics[`${name}.${arm}.files`] = files;

            if (overrunMs !== undefined) {
                metrics[`${name}.${arm}.overrunMs`] = overrunMs;
            }
        }
    }

    if (i >= args.warmup) {
        runs.push(metrics);
    }
}

const keys = Object.keys(runs[0] ?? {});
/** Fewer files is the point of a deadline arm; on the arms that walk everything, fewer files is a lost entry. */
const stopArm = (key: string) => key.includes(".deadline.") || key.includes(".doctor.");

await finishBench({
    name: BASELINE_NAME,
    title: `walkFiles and measurePath against a ${DEADLINE_MS} ms deadline (CPU ms, files, overrun ms; median)`,
    args,
    runs,
    lowerIsBetter: keys.filter((key) => !key.endsWith(".files") || stopArm(key)),
    floor: Object.fromEntries(keys.map((key) => [key, key.endsWith(".files") ? 50 : 10])),
    notes: `trees ${Object.values(roots).join(", ")}, read-only; warm vnode cache; deadline ${DEADLINE_MS} ms`,
    context: { roots, deadlineMs: DEADLINE_MS, arms: ARMS },
});
