import { basename } from "node:path";
import { logger } from "@app/logger";

const PS_BATCH_SIZE = 60;

export interface ProcessMeta {
    fullCommand: string;
    /** Short display token (basename of argv0). */
    shortCommand: string;
    /** Epoch ms when the process started, if parseable. */
    startedAtMs: number | null;
}

/**
 * Batch-resolve full argv + start time for many PIDs via a single `ps` per chunk.
 * Shared by the fast port list (main dashboard + port-killer) so path/command never depend
 * on which UI called in.
 */
export async function batchProcessMeta(pids: number[]): Promise<Map<number, ProcessMeta>> {
    const unique = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
    const out = new Map<number, ProcessMeta>();

    for (let i = 0; i < unique.length; i += PS_BATCH_SIZE) {
        const batch = unique.slice(i, i + PS_BATCH_SIZE);
        try {
            const proc = Bun.spawn(["/bin/ps", "-p", batch.join(","), "-o", "pid=,lstart=,command="], {
                stdout: "pipe",
                stderr: "ignore",
            });
            await proc.exited;
            const text = await new Response(proc.stdout).text();
            for (const line of text.split("\n")) {
                const parsed = parsePsPidLstartCommand(line);
                if (parsed) {
                    out.set(parsed.pid, {
                        fullCommand: parsed.command,
                        shortCommand: shortCommandFromArgv(parsed.command),
                        startedAtMs: parsed.startedAtMs,
                    });
                }
            }
        } catch (err) {
            logger.debug({ err, batch }, "ports/resolve: batch ps failed");
        }
    }

    return out;
}

/**
 * Batch-resolve cwd for many PIDs via `lsof -a -d cwd -p …`.
 * Uses field mode (`-Fn`) so paths with spaces stay intact.
 */
export async function batchCwds(pids: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
    const out = new Map<number, string>();

    for (let i = 0; i < unique.length; i += PS_BATCH_SIZE) {
        const batch = unique.slice(i, i + PS_BATCH_SIZE);
        try {
            const proc = Bun.spawn(["lsof", "-a", "-p", batch.join(","), "-d", "cwd", "-Fn"], {
                stdout: "pipe",
                stderr: "ignore",
            });
            await proc.exited;
            const text = await new Response(proc.stdout).text();
            mergeLsofCwdFields(text, out);
        } catch (err) {
            logger.debug({ err, batch }, "ports/resolve: batch cwd failed");
        }
    }

    return out;
}

/** Parse `ps -o pid=,lstart=,command=` line → pid + ISO-able start + full command. */
export function parsePsPidLstartCommand(
    line: string
): { pid: number; startedAtMs: number | null; command: string } | null {
    const trimmed = line.trim();
    if (!trimmed) {
        return null;
    }

    // pid, then lstart is "Www Mmm dd HH:MM:SS yyyy", then command (may contain spaces).
    const match = trimmed.match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/);
    if (!match) {
        // Fallback: pid + rest as command (no start time)
        const loose = trimmed.match(/^(\d+)\s+(.*)$/);
        if (!loose) {
            return null;
        }

        const pid = Number.parseInt(loose[1], 10);
        if (!Number.isFinite(pid) || pid <= 0) {
            return null;
        }

        return { pid, startedAtMs: null, command: loose[2].trim() };
    }

    const pid = Number.parseInt(match[1], 10);
    if (!Number.isFinite(pid) || pid <= 0) {
        return null;
    }

    const started = new Date(match[2]);
    return {
        pid,
        startedAtMs: Number.isNaN(started.getTime()) ? null : started.getTime(),
        command: match[3].trim(),
    };
}

/**
 * Field-mode lsof for cwd: blocks of `p<pid>` then `n<path>`.
 * Pure so unit tests cover multi-pid batches without spawning.
 */
export function mergeLsofCwdFields(stdout: string, into: Map<number, string> = new Map()): Map<number, string> {
    let currentPid: number | null = null;

    for (const raw of stdout.split("\n")) {
        const line = raw.trimEnd();
        if (line.startsWith("p")) {
            const pid = Number.parseInt(line.slice(1), 10);
            currentPid = Number.isFinite(pid) && pid > 0 ? pid : null;
            continue;
        }

        if (line.startsWith("n") && currentPid !== null) {
            const path = line.slice(1).trim();
            if (path.startsWith("/") && !into.has(currentPid)) {
                into.set(currentPid, path);
            }
        }
    }

    return into;
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
