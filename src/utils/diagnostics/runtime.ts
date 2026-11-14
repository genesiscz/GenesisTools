import { cpus, freemem, loadavg, release, totalmem } from "node:os";
import { listProcessesWithUsage } from "@genesiscz/utils/process/processes";

const GB = 1024 ** 3;

/** The shared hardware readers used by live triage and failure-time capture. */
export function runtimeLoad() {
    const [one, five, fifteen] = loadavg();
    return { one, five, fifteen, cores: cpus().length };
}

export function runtimeMemory() {
    return { totalGb: totalmem() / GB, freeGb: freemem() / GB };
}

/** `commands: false` skips the command-line column, the most expensive one (about 25 ms instead of 55). */
export function runtimeProcesses(options: { commands?: boolean } = {}) {
    return listProcessesWithUsage({ cpuPercent: true, commands: options.commands }).map((entry) => ({
        pid: entry.pid,
        name: entry.name,
        command: entry.command,
        cpuPercent: entry.cpuPercent ?? null,
        rssBytes: entry.usage?.rssBytes ?? 0,
        startMs: entry.startMs,
    }));
}

/** Small synchronous facts captured after the failure event has been written, without network requests. */
export function captureRuntimeFacts() {
    const errors: string[] = [];
    let rows: ReturnType<typeof runtimeProcesses> = [];
    try {
        // The capture keeps only pid, name, CPU and memory, so it does not pay for the command lines.
        rows = runtimeProcesses({ commands: false });
    } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
    }

    const row = (entry: (typeof rows)[number]) => ({
        pid: entry.pid,
        name: entry.name,
        cpuPercent: entry.cpuPercent,
        rssMb: Math.round(entry.rssBytes / 1024 / 1024),
    });
    return {
        capturedAt: new Date().toISOString(),
        os: { platform: String(process.platform), release: release(), arch: String(process.arch) },
        load: runtimeLoad(),
        memory: runtimeMemory(),
        process: { pid: process.pid, ...process.memoryUsage(), cpu: process.cpuUsage() },
        processCount: rows.length,
        topCpu: [...rows]
            .sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0))
            .slice(0, 5)
            .map(row),
        topMemory: [...rows]
            .sort((a, b) => b.rssBytes - a.rssBytes)
            .slice(0, 5)
            .map(row),
        errors,
    };
}

export type RuntimeFacts = ReturnType<typeof captureRuntimeFacts>;
