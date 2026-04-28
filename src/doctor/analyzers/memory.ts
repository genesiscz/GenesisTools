import { Analyzer } from "@app/doctor/lib/analyzer";
import { labelForProcess } from "@app/doctor/lib/process-labels";
import { run } from "@app/doctor/lib/run";
import { classifyProcess } from "@app/doctor/lib/safety";
import { formatBytes } from "@app/doctor/lib/size";
import type {
    Action,
    ActionResult,
    AnalyzerCategory,
    AnalyzerContext,
    ExecutorContext,
    Finding,
} from "@app/doctor/lib/types";
import clipboardy from "clipboardy";

export interface VmStatParsed {
    pageSize: number;
    free: number;
    active: number;
    inactive: number;
    speculative: number;
    wired: number;
    compressed: number;
    freeBytes: number;
    activeBytes: number;
    inactiveBytes: number;
    wiredBytes: number;
    compressedBytes: number;
}

export interface SwapusageParsed {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    encrypted: boolean;
}

function parsePageCount(raw: string, label: string): number {
    const re = new RegExp(`^${label}:\\s+(\\d+)\\.?$`, "m");
    const match = raw.match(re);

    if (!match) {
        return 0;
    }

    return Number.parseInt(match[1], 10);
}

export function parseVmStat(raw: string): VmStatParsed {
    const headerMatch = raw.match(/page size of (\d+) bytes/);
    const pageSize = headerMatch ? Number.parseInt(headerMatch[1], 10) : 4096;
    const free = parsePageCount(raw, "Pages free");
    const active = parsePageCount(raw, "Pages active");
    const inactive = parsePageCount(raw, "Pages inactive");
    const speculative = parsePageCount(raw, "Pages speculative");
    const wired = parsePageCount(raw, "Pages wired down");
    const compressed = parsePageCount(raw, "Pages occupied by compressor");

    return {
        pageSize,
        free,
        active,
        inactive,
        speculative,
        wired,
        compressed,
        freeBytes: free * pageSize,
        activeBytes: active * pageSize,
        inactiveBytes: inactive * pageSize,
        wiredBytes: wired * pageSize,
        compressedBytes: compressed * pageSize,
    };
}

export function parseSwapusage(raw: string): SwapusageParsed {
    const match = raw.match(/total = ([\d.]+)M\s+used = ([\d.]+)M\s+free = ([\d.]+)M(\s+\(encrypted\))?/);

    if (!match) {
        return { totalBytes: 0, usedBytes: 0, freeBytes: 0, encrypted: false };
    }

    const toBytes = (mb: string): number => Math.round(Number.parseFloat(mb) * 1024 * 1024);

    return {
        totalBytes: toBytes(match[1]),
        usedBytes: toBytes(match[2]),
        freeBytes: toBytes(match[3]),
        encrypted: Boolean(match[4]),
    };
}

interface TopProcess {
    pid: number;
    rssBytes: number;
    comm: string;
    command: string;
    label: string | null;
}

async function getTopProcessesByRss(limit: number): Promise<TopProcess[]> {
    const res = await run("ps", ["-axo", "pid=,rss=,comm=,command="]);

    if (res.status !== 0) {
        return [];
    }

    const processes: TopProcess[] = [];

    for (const line of res.stdout.split("\n")) {
        const trimmed = line.trim();

        if (!trimmed) {
            continue;
        }

        const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);

        if (!match) {
            continue;
        }

        const pid = Number.parseInt(match[1], 10);
        const rssKb = Number.parseInt(match[2], 10);
        const comm = match[3];
        const command = match[4];
        processes.push({
            pid,
            rssBytes: rssKb * 1024,
            comm,
            command,
            label: labelForProcess({ comm, command }),
        });
    }

    processes.sort((a, b) => b.rssBytes - a.rssBytes);
    return processes.slice(0, limit);
}

function killProcessAction(proc: TopProcess): Action {
    const safety = classifyProcess(proc.comm);
    const suffix = safety.autoRespawn ? " (will restart)" : "";

    return {
        id: "kill-rss-hog",
        label: `Kill PID ${proc.pid} - ${proc.label ?? proc.comm}${suffix}`,
        confirm: "yesno",
        execute: async (_ctx: ExecutorContext, finding): Promise<ActionResult> => {
            const res = await run("kill", [String(proc.pid)]);

            return {
                findingId: finding.id,
                actionId: "kill-rss-hog",
                status: res.status === 0 ? "ok" : "failed",
                error: res.status !== 0 ? `kill exited with ${res.status}` : undefined,
                metadata: { pid: proc.pid, rssBytes: proc.rssBytes },
            };
        },
    };
}

function copyPurgeCommandAction(): Action {
    return {
        id: "copy-purge",
        label: "Copy `sudo purge` to clipboard (run manually)",
        confirm: "none",
        execute: async (_ctx, finding): Promise<ActionResult> => {
            await clipboardy.write("sudo purge");

            return {
                findingId: finding.id,
                actionId: "copy-purge",
                status: "ok",
                metadata: { copied: "sudo purge" },
            };
        },
    };
}

export class MemoryAnalyzer extends Analyzer {
    readonly id = "memory";
    readonly name = "Memory";
    readonly icon = "M";
    readonly category: AnalyzerCategory = "memory";
    readonly cacheTtlMs = 0;

    protected async *run(_ctx: AnalyzerContext): AsyncIterable<Finding> {
        const vmRes = await run("vm_stat", []);
        const swapRes = await run("sysctl", ["vm.swapusage"]);
        const vm = parseVmStat(vmRes.stdout ?? "");
        const swap = parseSwapusage(swapRes.stdout ?? "");
        const swapPressureSevere =
            swap.usedBytes > 10 * 1024 * 1024 * 1024 || (swap.totalBytes > 0 && swap.usedBytes / swap.totalBytes > 0.5);
        const topProcesses = await getTopProcessesByRss(10);

        if (swap.totalBytes > 0) {
            const swapUsedPct = Math.round((swap.usedBytes / swap.totalBytes) * 100);
            const severity = swapPressureSevere ? "cautious" : "safe";
            const actions: Action[] = [];

            for (const proc of topProcesses.slice(0, 3)) {
                if (classifyProcess(proc.comm).severity !== "blocked") {
                    actions.push(killProcessAction(proc));
                }
            }

            actions.push(copyPurgeCommandAction());

            yield {
                id: "mem-swap",
                analyzerId: this.id,
                title: `Swap - ${formatBytes(swap.usedBytes)} used of ${formatBytes(swap.totalBytes)} (${swapUsedPct}%)`,
                detail: swapPressureSevere
                    ? "Swap is under significant pressure - consider killing a top-RSS process or restarting heavy apps."
                    : "Swap in use but within normal range.",
                severity,
                reclaimableBytes: swapPressureSevere ? swap.usedBytes : undefined,
                actions,
                metadata: { swap, vm },
            };
        }

        const totalBytes = (vm.active + vm.inactive + vm.free + vm.wired + vm.speculative) * vm.pageSize;
        const freeRatio = totalBytes > 0 ? (vm.freeBytes + vm.inactiveBytes) / totalBytes : 1;
        const pressure = freeRatio > 0.3 ? "LOW" : freeRatio > 0.1 ? "MED" : "HIGH";
        const pressureSeverity = pressure === "HIGH" ? "dangerous" : pressure === "MED" ? "cautious" : "safe";

        yield {
            id: "mem-pressure",
            analyzerId: this.id,
            title: `Memory pressure - ${pressure}`,
            detail:
                `Wired ${formatBytes(vm.wiredBytes)} - ` +
                `Active ${formatBytes(vm.activeBytes)} - ` +
                `Compressed ${formatBytes(vm.compressedBytes)} - ` +
                `Free ${formatBytes(vm.freeBytes)}`,
            severity: pressureSeverity,
            actions: [],
            metadata: { vm },
        };

        for (const proc of topProcesses.slice(0, 5)) {
            const safety = classifyProcess(proc.comm);
            const actions: Action[] = safety.severity === "blocked" ? [] : [killProcessAction(proc)];

            yield {
                id: `mem-rss-${proc.pid}`,
                analyzerId: this.id,
                title: `PID ${proc.pid} - ${proc.label ?? proc.comm} - ${formatBytes(proc.rssBytes)}`,
                detail: proc.command.length > 120 ? `${proc.command.slice(0, 120)}...` : proc.command,
                severity: safety.severity === "blocked" ? "blocked" : "cautious",
                blacklistReason: safety.reason,
                reclaimableBytes: proc.rssBytes,
                actions,
                metadata: { pid: proc.pid, comm: proc.comm, rssBytes: proc.rssBytes, label: proc.label },
            };
        }
    }
}
