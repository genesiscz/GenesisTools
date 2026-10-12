#!/usr/bin/env bun
/**
 * Ways of reading the start of a file, the end of a file, and a file's size and mtime, on the real session files
 * (read-only). Each sample is a fresh process (`read-child.ts`) that does the job twice: cold (a CLI process) and
 * warm (a resident server). Arms are interleaved. `*.check` must agree between the arms of a job.
 *
 *   head: stream (a ReadableStream's first chunk, what Codex discovery used), slice (Bun.file().slice().text()),
 *         promises (fs/promises open + read), sync (openSync + readSync), ffi (libSystem open + pread), readFile
 *         (the whole file, as a reference).
 *   tail: sliceTwice (what readTailBytes did: the tail, then one more byte to check the line start), slice (one
 *         slice that includes that byte), sync (openSync + fstatSync + readSync), ffi (open + lseek + pread).
 *   stat: statSync, lstatSync, promises (fs/promises stat, all at once), bunFile (Bun.file().stat()), ffi (libSystem
 *         stat into a reused buffer).
 *
 * Usage:
 *   bun scripts/benchmarks/fs/read-primitives.ts --baseline
 *   bun scripts/benchmarks/fs/read-primitives.ts --compare
 */
import { join } from "node:path";
import type { BaselineMetrics } from "@app/benchmark/lib";
import { SafeJSON } from "@genesiscz/utils/json";
import { finishBench, parseBenchArgs } from "./shared";
import { READ_ARMS } from "./walk-trees";

const BASELINE_NAME = "fs-read-primitives";
const REPO = join(import.meta.dir, "..", "..", "..");

interface Sample {
    coldCpuMs: number;
    warmCpuMs: number;
    check: number;
    files: number;
}

async function sample(job: string, arm: string): Promise<Sample> {
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "read-child.ts"), job, arm], {
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
        throw new Error(`read-child ${job} ${arm} exited ${exitCode}: ${errText.slice(0, 500)}`);
    }

    return SafeJSON.parse(text, { strict: true }) as Sample;
}

const args = parseBenchArgs(process.argv.slice(2));
const runs: BaselineMetrics[] = [];

for (let i = 0; i < args.warmup + args.runs; i++) {
    const metrics: BaselineMetrics = {};

    for (const [job, arms] of Object.entries(READ_ARMS)) {
        for (const arm of arms) {
            const { coldCpuMs, warmCpuMs, check, files } = await sample(job, arm);
            metrics[`${job}.${arm}.cold.cpuMs`] = coldCpuMs;
            metrics[`${job}.${arm}.warm.cpuMs`] = warmCpuMs;
            metrics[`${job}.${arm}.check`] = check;
            metrics[`${job}.files`] = files;
        }
    }

    if (i >= args.warmup) {
        runs.push(metrics);
    }
}

const keys = Object.keys(runs[0] ?? {});
await finishBench({
    name: BASELINE_NAME,
    title: "Reading heads, tails and stats of session files (CPU ms, median; checks must agree per job)",
    args,
    runs,
    lowerIsBetter: keys.filter((key) => key.endsWith("cpuMs")),
    floor: Object.fromEntries(keys.map((key) => [key, key.endsWith("cpuMs") ? 5 : 50])),
    notes: "live session files, read-only; each sample is a fresh process (cold pass, then warm pass)",
    context: { arms: READ_ARMS, bytes: 64 * 1024 },
});
