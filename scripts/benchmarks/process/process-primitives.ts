#!/usr/bin/env bun
/**
 * The old spawn (`lsof`, `ps`, `top`) against the libproc / libSystem read that replaced it, per job, on this
 * machine's live process table (read-only). Each sample is a fresh process (`process-child.ts`) that does the job
 * twice: cold (a CLI call) and warm (a resident server). Arms are interleaved. CPU includes the spawned children.
 * `*.check` must agree between the arms of a job (processes can come and go between samples, so a difference of
 * one or two is churn, not a bug; say so when it happens).
 *
 * Usage:
 *   bun scripts/benchmarks/process/process-primitives.ts --runs 7 --baseline
 *   bun scripts/benchmarks/process/process-primitives.ts --runs 7 --compare
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { BaselineMetrics } from "@app/benchmark/lib";
import { SafeJSON } from "@genesiscz/utils/json";
import { finishBench, parseBenchArgs } from "../fs/shared";
import { CWD_PIDS, PROCESS_ARMS } from "./process-arms";

const BASELINE_NAME = "process-primitives";
const REPO = join(import.meta.dir, "..", "..", "..");

interface Sample {
    coldCpuMs: number;
    warmCpuMs: number;
    check: number;
}

/** The oldest `CWD_PIDS` processes of this user (lowest pids), so the set barely moves between samples. */
function ownPids(): number[] {
    const uid = process.getuid?.() ?? -1;
    const stdout = spawnSync("ps", ["-axo", "pid=,uid="], { encoding: "utf8" }).stdout ?? "";
    const pids: number[] = [];

    for (const line of stdout.split("\n")) {
        const [pid, owner] = line.trim().split(/\s+/).map(Number);

        if (owner === uid && pid !== undefined && pid > 1) {
            pids.push(pid);
        }
    }

    return pids.sort((a, b) => a - b).slice(0, CWD_PIDS);
}

async function sample(job: string, arm: string, pids: number[]): Promise<Sample> {
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "process-child.ts"), job, arm, pids.join(",")], {
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
        throw new Error(`process-child ${job} ${arm} exited ${exitCode}: ${errText.slice(0, 500)}`);
    }

    return SafeJSON.parse(text, { strict: true }) as Sample;
}

const args = parseBenchArgs(process.argv.slice(2));
const pids = ownPids();
const runs: BaselineMetrics[] = [];

for (let i = 0; i < args.warmup + args.runs; i++) {
    const metrics: BaselineMetrics = {};

    for (const [job, arms] of Object.entries(PROCESS_ARMS)) {
        // Alternate which arm goes first, so neither one always runs right after the other's spawns.
        const ordered = i % 2 === 0 ? [...arms] : [...arms].reverse();

        for (const arm of ordered) {
            const { coldCpuMs, warmCpuMs, check } = await sample(job, arm, pids);
            metrics[`${job}.${arm}.cold.cpuMs`] = coldCpuMs;
            metrics[`${job}.${arm}.warm.cpuMs`] = warmCpuMs;
            metrics[`${job}.${arm}.check`] = check;
        }
    }

    if (i >= args.warmup) {
        runs.push(metrics);
    }
}

const keys = Object.keys(runs[0] ?? {});
await finishBench({
    name: BASELINE_NAME,
    title: "Process-table reads: the old spawn against libproc (CPU ms incl. children, median; checks per job)",
    args,
    runs,
    lowerIsBetter: keys.filter((key) => key.endsWith("cpuMs")),
    floor: Object.fromEntries(keys.map((key) => [key, key.endsWith("cpuMs") ? 5 : 3])),
    notes: `live process table, read-only; ${pids.length} own pids for cwd; each sample is a fresh process`,
    context: { arms: PROCESS_ARMS, cwdPids: pids.length },
});
