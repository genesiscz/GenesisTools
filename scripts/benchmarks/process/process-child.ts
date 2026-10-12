#!/usr/bin/env bun
/**
 * One sample for `process-primitives.ts`: one arm of one job, twice in this fresh process (cold, then warm),
 * printed as `{ coldCpuMs, warmCpuMs, check }`. The CPU figure is this process PLUS every child it waited for
 * (`getrusage(RUSAGE_CHILDREN)`), because the old arms spend nearly all of their time in `lsof`, `ps` or `top`.
 * `check` must agree between the arms of a job.
 *
 *   bun scripts/benchmarks/process/process-child.ts <job> <arm> [pids,comma,separated]
 */
import { FFIType } from "bun:ffi";
import { defineSystemLibrary } from "@genesiscz/utils/bun/compiler";
import { SafeJSON } from "@genesiscz/utils/json";
import { batchCwd, batchCwdViaLsof } from "@genesiscz/utils/process/ps";
import { PROCESS_ARMS, type ProcessJob } from "./process-arms";

const [job, arm, pidList = ""] = process.argv.slice(2) as [ProcessJob, string, string?];
const arms: readonly string[] | undefined = PROCESS_ARMS[job];

if (!arms?.includes(arm)) {
    throw new Error(`usage: process-child.ts <${Object.keys(PROCESS_ARMS).join("|")}> <arm> [pids]`);
}

/** `getrusage` is not in node:process for children; `<sys/resource.h>`: RUSAGE_CHILDREN -1, ru_utime 0, ru_stime 16. */
const rusage = defineSystemLibrary({
    path: "/usr/lib/libSystem.B.dylib",
    platforms: ["darwin"],
    symbols: { getrusage: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } },
});
const RUSAGE_CHILDREN = -1;
/** `struct rusage` is 144 bytes; each `timeval` is a 64-bit `tv_sec` (two words) and a 32-bit `tv_usec`. */
const rusageWords = new Uint32Array(144 / 4);

function childrenCpuMs(): number {
    const calls = rusage();

    if (calls?.getrusage(RUSAGE_CHILDREN, rusageWords) !== 0) {
        return 0;
    }

    const seconds = rusageWords[0] + rusageWords[1] * 2 ** 32 + rusageWords[4] + rusageWords[5] * 2 ** 32;
    const micros = rusageWords[2] + rusageWords[6];
    return seconds * 1000 + micros / 1000;
}

function cpuNowMs(): number {
    const self = process.cpuUsage();
    return (self.user + self.system) / 1000 + childrenCpuMs();
}

const pids = pidList
    .split(",")
    .filter((value) => value !== "")
    .map(Number);

async function runOnce(): Promise<number> {
    if (job === "cwd") {
        return (arm === "lsof" ? batchCwdViaLsof(pids) : batchCwd(pids)).size;
    }

    throw new Error(`no job ${job}`);
}

async function measure(): Promise<{ cpuMs: number; check: number }> {
    const before = cpuNowMs();
    const check = await runOnce();
    return { cpuMs: cpuNowMs() - before, check };
}

const cold = await measure();
const warm = await measure();
process.stdout.write(
    `${SafeJSON.stringify({ coldCpuMs: cold.cpuMs, warmCpuMs: warm.cpuMs, check: warm.check }, { strict: true })}\n`
);
