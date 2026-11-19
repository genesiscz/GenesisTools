import { basename } from "node:path";
import { killPidAction } from "@app/doctor/analyzers/processes";
import { Analyzer } from "@app/doctor/lib/analyzer";
import { labelForProcess } from "@app/doctor/lib/process-labels";
import { classifyProcess } from "@app/doctor/lib/safety";
import type { Action, AnalyzerCategory, AnalyzerContext, Finding } from "@app/doctor/lib/types";
import {
    type CpuTimeSample,
    DEFAULT_CPU_SPIN_THRESHOLD_PERCENT,
    DEFAULT_CPU_SPIN_WINDOW_MS,
    type ProcessOwner,
    processOwner,
    type SpinningProcess,
    sampleCpuTimes,
    spinningProcesses,
} from "@genesiscz/utils/process/cpu-spin";

export const CPU_SPIN_ANALYZER_ID = "cpu-spin";

export interface CpuSpinOptions {
    /** Gap between the two `ps` samples. */
    windowMs?: number;
    /** Share of one core, over the window, at or above which a process is reported. */
    thresholdPercent?: number;
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

        const startedAt = performance.now();
        await Bun.sleep(this.windowMs);
        const after = await this.sample();

        if (!after) {
            return;
        }

        const measuredMs = Math.max(1, performance.now() - startedAt);
        const windowSeconds = (measuredMs / 1000).toFixed(1);

        for (const record of spinningProcesses(before, after, measuredMs, this.thresholdPercent)) {
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
                    windowMs: measuredMs,
                    command: record.command,
                    owner,
                },
            };
        }
    }

    private async sample(): Promise<Map<number, CpuTimeSample> | null> {
        return sampleCpuTimes();
    }
}
