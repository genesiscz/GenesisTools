import { basename } from "node:path";
import { canReadProcessCwd } from "@genesiscz/utils/process/cwd";
import { readProcess } from "@genesiscz/utils/process/processes";
import { batchCwd } from "@genesiscz/utils/process/ps";

export interface ProcessMeta {
    fullCommand: string;
    /** Short display token (basename of argv0). */
    shortCommand: string;
    /** Epoch ms when the process started, if parseable. */
    startedAtMs: number | null;
}

/**
 * Resolve full argv and start time for each PID through the process layer.
 * Shared by the fast port list (main dashboard + port-killer) so path/command never depend
 * on which UI called in.
 */
export async function batchProcessMeta(pids: number[]): Promise<Map<number, ProcessMeta>> {
    const out = new Map<number, ProcessMeta>();
    for (const pid of new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))) {
        const entry = readProcess(pid);
        if (entry?.command) {
            out.set(pid, {
                fullCommand: entry.command,
                shortCommand: shortCommandFromArgv(entry.command),
                startedAtMs: entry.startMs,
            });
        }
    }
    return out;
}

/**
 * Batch-resolve cwd for many PIDs. Where the kernel can be read (libproc on macOS, `/proc` on Linux) that is
 * `batchCwd` at microseconds a pid; elsewhere the result is unknown and the map stays empty.
 */
export async function batchCwds(pids: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
    return canReadProcessCwd() ? batchCwd(unique) : new Map();
}

export function shortCommandFromArgv(fullCommand: string): string {
    const first = fullCommand.trim().split(/\s+/)[0] ?? "";
    if (!first) {
        return "unknown";
    }

    // Cursor Helper (Plugin): … — keep a readable token, not the full path.
    if (/^Cursor(\s|$)/i.test(fullCommand) || first.includes("Cursor")) {
        return "Cursor";
    }

    if (first.includes("ControlCenter") || first.endsWith("/ControlCenter")) {
        return "ControlCenter";
    }

    if (/\/Warp\.app\/|\/stable$/i.test(first) || first.endsWith("/stable")) {
        return "Warp";
    }

    return basename(first) || first;
}
