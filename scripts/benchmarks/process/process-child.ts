#!/usr/bin/env bun
/**
 * One sample for `process-primitives.ts`: one arm of one job, twice in this fresh process (cold, then warm),
 * printed as `{ coldCpuMs, warmCpuMs, check }`. The CPU figure is this process PLUS every child it waited for
 * (`getrusage(RUSAGE_CHILDREN)`), because the old arms spend nearly all of their time in `lsof`, `ps` or `top`.
 * `check` must agree between the arms of a job.
 *
 *   bun scripts/benchmarks/process/process-child.ts <job> <arm> [pids,comma,separated]
 */
import { statfsSync } from "node:fs";
import { classifyClaudeArgs } from "@app/claude/lib/active-sessions";
import {
    parseCpuIdlePct,
    parseDfRoot,
    parseMemoryFreePct,
    parseVmStat,
    runShell,
} from "@app/dev-dashboard/lib/system/collector";
import { parseSwapUsage } from "@app/macos/lib/swap/scanner";
import { listActiveAgentProcesses, listActiveAgentProcessesViaPs } from "@genesiscz/utils/ai/active-processes";
import { listHostProcesses } from "@genesiscz/utils/cmux/tmux-host";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    readMemoryFreePercent,
    readMemorySizeBytes,
    readSwapUsage,
    readVmPageCounts,
    sampleCpuBusyPercent,
} from "@genesiscz/utils/macos/host-stats";
import { ancestry } from "@genesiscz/utils/process/processes";
import { batchCwd, batchCwdViaLsof, listPsTable } from "@genesiscz/utils/process/ps";
import { listListeningTcpAsLsof } from "@genesiscz/utils/process/socket-owner";
import { processStartMs, readProcessCommand } from "@genesiscz/utils/process-identity";
import { cpuNowMs } from "./cpu";
import { IDENTITY_PIDS, PROCESS_ARMS, type ProcessJob } from "./process-arms";

const [job, arm, pidList = ""] = process.argv.slice(2) as [ProcessJob, string, string?];
const arms: readonly string[] | undefined = PROCESS_ARMS[job];

if (!arms?.includes(arm)) {
    throw new Error(`usage: process-child.ts <${Object.keys(PROCESS_ARMS).join("|")}> <arm> [pids]`);
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

/** The depth the say caller chain (now the identity's `process` facet) walks. */
const MAX_ANCESTRY_DEPTH = 20;

/**
 * What `tools say` ran before the kernel walk, kept here as the benchmark's baseline arm: the pid→ppid table from
 * `ps -axo pid=,ppid=`, a walk up it, then the chain's commands from one `ps -p`.
 */
function ancestryViaPs(startPid: number): number {
    const parents = new Map<number, number>();

    for (const line of Bun.spawnSync(["ps", "-axo", "pid=,ppid="]).stdout.toString().split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);

        if (match) {
            parents.set(Number(match[1]), Number(match[2]));
        }
    }

    const chain: number[] = [];

    for (let pid: number | undefined = startPid; pid !== undefined && pid > 1; pid = parents.get(pid)) {
        if (chain.length >= MAX_ANCESTRY_DEPTH || chain.includes(pid)) {
            break;
        }

        chain.push(pid);
    }

    const listed = Bun.spawnSync(["ps", "-p", chain.join(","), "-o", "pid=,command="]).stdout.toString();
    const named = new Set(
        listed
            .split("\n")
            .flatMap((line) => line.match(/^\s*(\d+)\s/)?.[1] ?? [])
            .map(Number)
    );
    return chain.filter((pid) => named.has(pid)).length;
}

/** What `readProcessCommand` and `processStartMs` ran per pid before the kernel read: `ps -p` twice. */
function identityViaPs(pid: number): number {
    const command = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="])
        .stdout.toString()
        .trim();
    const etime = Bun.spawnSync(["ps", "-p", String(pid), "-o", "etime="])
        .stdout.toString()
        .trim();
    return command.length > 0 && etime.length > 0 ? 1 : 0;
}

async function runOnce(): Promise<number> {
    if (job === "cwd") {
        return (arm === "lsof" ? batchCwdViaLsof(pids) : batchCwd(pids)).size;
    }

    if (job === "pulse") {
        return arm === "spawn" ? pulseViaSpawn() : pulseViaHost();
    }

    if (job === "table") {
        return (arm === "ps" ? await listPsTable() : await listHostProcesses()).length;
    }

    if (job === "who") {
        const scan = { alias: "claude" as const, classify: classifyClaudeArgs };
        return (arm === "ps" ? await listActiveAgentProcessesViaPs(scan) : await listActiveAgentProcesses(scan)).length;
    }

    if (job === "ancestry") {
        return arm === "ps"
            ? ancestryViaPs(process.pid)
            : ancestry(process.pid, MAX_ANCESTRY_DEPTH).filter((entry) => entry.pid > 1).length;
    }

    if (job === "identity") {
        const checked = pids.slice(0, IDENTITY_PIDS);
        return checked.reduce(
            (sum, pid) =>
                sum +
                (arm === "ps"
                    ? identityViaPs(pid)
                    : readProcessCommand(pid) !== null && processStartMs(pid) !== null
                      ? 1
                      : 0),
            0
        );
    }

    if (job === "listen") {
        const text =
            arm === "lsof"
                ? Bun.spawnSync(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]).stdout.toString()
                : (listListeningTcpAsLsof() ?? "");
        return text.split("\n").filter((line) => line.includes("(LISTEN)")).length;
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
