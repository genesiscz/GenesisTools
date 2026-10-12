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
import { statfsSync } from "node:fs";
import {
    parseCpuIdlePct,
    parseDfRoot,
    parseMemoryFreePct,
    parseVmStat,
    runShell,
} from "@app/dev-dashboard/lib/system/collector";
import { parseSwapUsage } from "@app/macos/lib/swap/scanner";
import { defineSystemLibrary } from "@genesiscz/utils/bun/compiler";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    readMemoryFreePercent,
    readMemorySizeBytes,
    readSwapUsage,
    readVmPageCounts,
    sampleCpuBusyPercent,
} from "@genesiscz/utils/macos/host-stats";
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

function answered(values: Array<number | null>): number {
    return values.filter((value) => value !== null && Number.isFinite(value)).length;
}

/** What `collectCpu`, `collectMem`, `collectSwap` and `collectDisk` ran before the host reads replaced them. */
async function pulseViaSpawn(): Promise<number> {
    const [top, vmStat, pageSize, memSize, pressure, swapText, df] = await Promise.all([
        runShell(["top", "-l", "1", "-n", "0"]),
        runShell(["vm_stat"]),
        runShell(["sysctl", "-n", "hw.pagesize"]),
        runShell(["sysctl", "-n", "hw.memsize"]),
        runShell(["memory_pressure"]),
        runShell(["sysctl", "vm.swapusage"]),
        runShell(["df", "-k", "/"]),
    ]);
    const page = Number(pageSize?.trim());
    const swap = swapText === null ? null : parseSwapUsage(swapText);
    const disk = df === null ? null : parseDfRoot(df);

    return answered([
        top === null ? null : parseCpuIdlePct(top),
        vmStat === null ? null : parseVmStat(vmStat, page).usedBytes,
        Number(memSize?.trim()),
        pressure === null ? null : parseMemoryFreePct(pressure),
        swap?.usedBytes ?? null,
        swap?.totalBytes ?? null,
        disk?.freeBytes ?? null,
        disk?.totalBytes ?? null,
    ]);
}

async function pulseViaHost(): Promise<number> {
    const cpu = await sampleCpuBusyPercent();
    const pages = readVmPageCounts();
    const swap = readSwapUsage();
    const disk = statfsSync("/");

    return answered([
        cpu,
        pages === null ? null : (pages.active + pages.wired + pages.compressed) * pages.pageSize,
        readMemorySizeBytes(),
        readMemoryFreePercent(),
        swap?.usedBytes ?? null,
        swap?.totalBytes ?? null,
        disk.bavail * disk.bsize,
        disk.blocks * disk.bsize,
    ]);
}

async function runOnce(): Promise<number> {
    if (job === "cwd") {
        return (arm === "lsof" ? batchCwdViaLsof(pids) : batchCwd(pids)).size;
    }

    if (job === "pulse") {
        return arm === "spawn" ? pulseViaSpawn() : pulseViaHost();
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
