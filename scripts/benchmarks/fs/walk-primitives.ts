#!/usr/bin/env bun
/**
 * Walk options for "which session files changed recently", on the real session trees (read-only).
 *
 * ARMS, each in a fresh process per sample (`walk-child.ts`), interleaved arm by arm:
 *   - `native`: `fastWalk` on macOS. No C of our own: `open`, `getattrlistbulk` and `close` straight from
 *     `libSystem` through `bun:ffi`, each directory's entries (name, type, mtime, size) read in TypeScript, so no
 *     file gets its own stat. Its cold pass carries the JIT warm-up of the parse loop.
 *   - `clang`: the same walk in C (`fastwalk.c`, a fixture kept for this comparison), built once by
 *     `defineNativeLibrary` into its cache and opened from there.
 *   - `tcc`: the same C compiled in the process by Bun's built-in TinyCC (`cc` from `bun:ffi`), so no clang. Its
 *     cold pass includes the compile, which a TinyCC build pays in every process.
 *   - `js`: `fastWalk`'s portable walker, `readdir` with types plus an `lstat` per returned file.
 *   - `walkSourceRoots`: what session discovery uses today, plus the stat per file the listing then needs
 *     for the mtime. Its folder-listing cache makes the warm pass cheaper in a resident process.
 * Each sample reports a cold pass (a CLI process) and a warm pass (the same process again, a resident server).
 *
 * The trees are live, so `*.files` can move by a few between samples while sessions are written.
 *
 * Usage:
 *   bun scripts/benchmarks/fs/walk-primitives.ts --baseline
 *   bun scripts/benchmarks/fs/walk-primitives.ts --compare
 *   bun scripts/benchmarks/fs/walk-primitives.ts --runs 5 --json
 */
import { join } from "node:path";
import type { BaselineMetrics } from "@app/benchmark/lib";
import { SafeJSON } from "@genesiscz/utils/json";
import { finishBench, parseBenchArgs } from "./shared";
import { WALK_ARMS, WALK_TREES } from "./walk-trees";

const BASELINE_NAME = "fs-walk-primitives";
const REPO = join(import.meta.dir, "..", "..", "..");

interface Sample {
    coldCpuMs: number;
    warmCpuMs: number;
    files: number;
}

async function sample(arm: string, tree: string): Promise<Sample> {
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "walk-child.ts"), arm, tree], {
        cwd: REPO,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [text, errText, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (exitCode !== 0) {
        throw new Error(`walk-child ${arm} ${tree} exited ${exitCode}: ${errText.slice(0, 500)}`);
    }

    return SafeJSON.parse(text, { strict: true }) as Sample;
}

const args = parseBenchArgs(process.argv.slice(2));
const runs: BaselineMetrics[] = [];

for (let i = 0; i < args.warmup + args.runs; i++) {
    const metrics: BaselineMetrics = {};

    for (const tree of Object.keys(WALK_TREES)) {
        for (const arm of WALK_ARMS) {
            const { coldCpuMs, warmCpuMs, files } = await sample(arm, tree);
            metrics[`${tree}.${arm}.cold.cpuMs`] = coldCpuMs;
            metrics[`${tree}.${arm}.warm.cpuMs`] = warmCpuMs;
            metrics[`${tree}.${arm}.files`] = files;
        }
    }

    if (i >= args.warmup) {
        runs.push(metrics);
    }
}

const keys = Object.keys(runs[0] ?? {});
await finishBench({
    name: BASELINE_NAME,
    title: "Walk options per session tree (CPU ms, median; files found)",
    args,
    runs,
    lowerIsBetter: keys.filter((key) => key.endsWith("cpuMs")),
    floor: Object.fromEntries(keys.map((key) => [key, key.endsWith("cpuMs") ? 10 : 50])),
    notes: "live session trees, read-only; each sample is a fresh process (cold pass, then warm pass)",
    context: { trees: WALK_TREES, arms: WALK_ARMS },
});
