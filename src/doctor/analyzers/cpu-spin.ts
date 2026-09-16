import { basename } from "node:path";
import { killPidAction } from "@app/doctor/analyzers/processes";
import { Analyzer } from "@app/doctor/lib/analyzer";
import { labelForProcess } from "@app/doctor/lib/process-labels";
import { classifyProcess } from "@app/doctor/lib/safety";
import type { Action, AnalyzerCategory, AnalyzerContext, Finding } from "@app/doctor/lib/types";
import { capture, parseCpuTime } from "@genesiscz/utils/process/ps";

export { parseCpuTime };

const PS_LINE = /^\s*(\d+)\s+(\S+)\s+(.*)$/;
const GENESIS_FACE = /GenesisTools\.app\/Contents\/MacOS\/GenesisTools(?:\s+--(?:rpc|window)\b|\s*$)/;
const GENESIS_TOOL = /\/GenesisTools\/(?:src|scripts)\/|\/\.genesis-tools\/bin\/gt-/;

export const CPU_SPIN_ANALYZER_ID = "cpu-spin";
export const DEFAULT_CPU_SPIN_WINDOW_MS = 1_500;
export const DEFAULT_CPU_SPIN_THRESHOLD_PERCENT = 25;

export interface CpuTimeSample {
    pid: number;
    cpuMs: number;
    command: string;
}

export interface SpinningProcess extends CpuTimeSample {
    /** CPU time burned between the two samples, as a share of one core over the window. */
    percent: number;
    deltaMs: number;
}

export interface CpuSpinOptions {
    /** Gap between the two `ps` samples. */
    windowMs?: number;
    /** Share of one core, over the window, at or above which a process is reported. */
    thresholdPercent?: number;
}

export type ProcessOwner = "genesis-face" | "genesis-tool" | null;

/** Output of `ps -axo pid=,cputime=,command=`, keyed by pid. Lines that do not parse are skipped. */
export function parseCpuTimeSamples(raw: string): Map<number, CpuTimeSample> {
    const samples = new Map<number, CpuTimeSample>();

    for (const line of raw.split(/\r?\n/)) {
        const match = line.match(PS_LINE);

        if (!match) {
            continue;
        }

        const cpuMs = parseCpuTime(match[2]);

        if (cpuMs === null) {
            continue;
        }

        const pid = Number.parseInt(match[1], 10);
        samples.set(pid, { pid, cpuMs, command: match[3].trim() });
    }

    return samples;
}

/**
 * Processes that burned at least `thresholdPercent` of one core between two samples. Two readings
 * of accumulated CPU time are exact where `ps -o pcpu` is a decaying average: pcpu smears a spin
 * that started a minute ago and hides one that started a second ago. A process born inside the
 * window has no first sample and is not judged.
 */
export function spinningProcesses(
    before: Map<number, CpuTimeSample>,
    after: Map<number, CpuTimeSample>,
    windowMs: number,
    thresholdPercent: number
): SpinningProcess[] {
    const found: SpinningProcess[] = [];

    for (const [pid, now] of after) {
        const earlier = before.get(pid);

        if (!earlier || earlier.command !== now.command) {
            continue;
        }

        const deltaMs = now.cpuMs - earlier.cpuMs;
        const percent = (deltaMs / windowMs) * 100;

        if (percent >= thresholdPercent) {
            found.push({ ...now, deltaMs, percent });
        }
    }

    return found.sort((a, b) => b.percent - a.percent);
}

/**
 * The two shapes this repo owns. A "face" is an argument-less or `--rpc`/`--window` instance of
 * GenesisTools.app, the class that spun at 60% for an hour on 2026-09-16 (`RunLoop.run` with no
 * sources returns at once); a "tool" is any bun process running this repo's code.
 */
export function processOwner(command: string): ProcessOwner {
    if (GENESIS_FACE.test(command)) {
        return "genesis-face";
    }

    if (GENESIS_TOOL.test(command)) {
        return "genesis-tool";
    }

    return null;
}

function commOf(command: string): string {
    return basename(command.split(/\s+/)[0] ?? command);
}

function displayName(record: SpinningProcess): string {
    const comm = commOf(record.command);
    const label = labelForProcess({ comm, command: record.command });

    if (label) {
        return label;
    }

    const owner = processOwner(record.command);

    if (owner === "genesis-tool") {
        const script = record.command.match(/\/GenesisTools\/((?:src|scripts)\/\S+)/)?.[1];
        return script ? `tools ${script}` : comm;
    }

    return comm;
}

function ownerHint(owner: ProcessOwner): string {
    if (owner === "genesis-face") {
        return " Stale GenesisTools.app face: `bun run app` rebuilds and reaps it.";
    }

    if (owner === "genesis-tool") {
        return " A GenesisTools process: check ~/.genesis-tools/logs/<today>.log for what it is doing.";
    }

    return "";
}

export class CpuSpinAnalyzer extends Analyzer {
    readonly id = CPU_SPIN_ANALYZER_ID;
    readonly name = "CPU spin";
    readonly icon = "S";
    readonly category: AnalyzerCategory = "processes";
    readonly cacheTtlMs = 0;
    readonly windowMs: number;
    readonly thresholdPercent: number;

    constructor(options: CpuSpinOptions = {}) {
        super();
        this.windowMs = options.windowMs ?? DEFAULT_CPU_SPIN_WINDOW_MS;
        this.thresholdPercent = options.thresholdPercent ?? DEFAULT_CPU_SPIN_THRESHOLD_PERCENT;
    }

    protected async *run(_ctx: AnalyzerContext): AsyncIterable<Finding> {
        const before = await this.sample();

        if (!before) {
            return;
        }

        await Bun.sleep(this.windowMs);
        const after = await this.sample();

        if (!after) {
            return;
        }

        const windowSeconds = (this.windowMs / 1000).toFixed(1);

        for (const record of spinningProcesses(before, after, this.windowMs, this.thresholdPercent)) {
            if (record.pid === process.pid) {
                continue;
            }

            const comm = commOf(record.command);
            const safety = classifyProcess(comm);
            const owner = processOwner(record.command);
            const name = displayName(record);
            const actions: Action[] = safety.severity === "blocked" ? [] : [killPidAction(record.pid, name)];
            const command = record.command.length > 160 ? `${record.command.slice(0, 160)}...` : record.command;

            yield {
                id: `cpu-spin-${record.pid}`,
                analyzerId: this.id,
                title: `${name} - ${record.percent.toFixed(0)}% of a core over ${windowSeconds}s (PID ${record.pid})`,
                detail: `${command}${ownerHint(owner)}`,
                severity: safety.severity === "blocked" ? "blocked" : "cautious",
                blacklistReason: safety.reason,
                actions,
                metadata: {
                    pid: record.pid,
                    percent: Number(record.percent.toFixed(1)),
                    deltaMs: record.deltaMs,
                    windowMs: this.windowMs,
                    command: record.command,
                    owner,
                },
            };
        }
    }

    private async sample(): Promise<Map<number, CpuTimeSample> | null> {
        const res = await capture("ps", ["-axo", "pid=,cputime=,command="], { timeoutMs: 5_000 });

        if (res.status !== 0) {
            return null;
        }

        return parseCpuTimeSamples(res.stdout);
    }
}
