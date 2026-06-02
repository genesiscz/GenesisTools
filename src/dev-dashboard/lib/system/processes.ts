import type { ProcessInfo, ProcessSort } from "@app/dev-dashboard/lib/system/types";
import { parseEtime } from "@app/macos/lib/swap/scanner";
import { logger } from "@app/logger";

// macOS `ps comm=` yields the full executable path. Surface a readable name:
// the .app bundle name when present, otherwise the binary's basename.
export function friendlyProcessName(comm: string): string {
    const trimmed = comm.trim();
    if (!trimmed) {
        return "—";
    }

    const appMatch = trimmed.match(/\/([^/]+)\.app\//);
    if (appMatch) {
        return appMatch[1];
    }

    const base = trimmed.split("/").pop();
    return base && base.length > 0 ? base : trimmed;
}

/** Parse `ps -axo pid=,rss=,etime=,%cpu=,comm=` into ProcessInfo[] (5-column, cpu added).
 * Kept separate from the swap scanner's 4-column `parsePsOutput` — adding the cpu
 * column there would shift the arity and break `tools macos swap`. */
export function parseProcessRows(output: string): ProcessInfo[] {
    const rows: ProcessInfo[] = [];

    for (const raw of output.split("\n")) {
        const line = raw.trim();

        if (line === "") {
            continue;
        }

        const parts = line.split(/\s+/);

        if (parts.length < 5) {
            continue;
        }

        const pid = Number.parseInt(parts[0], 10);
        const rssKb = Number.parseInt(parts[1], 10);

        if (Number.isNaN(pid) || Number.isNaN(rssKb)) {
            continue;
        }

        const cpuPct = Number.parseFloat(parts[3]);

        rows.push({
            pid,
            rssBytes: rssKb * 1024,
            uptimeMs: parseEtime(parts[2]),
            cpuPct: Number.isNaN(cpuPct) ? 0 : cpuPct,
            name: friendlyProcessName(parts.slice(4).join(" ")),
        });
    }

    return rows;
}

/** Pure: rss desc (ties → pid asc) or name asc (case-insensitive, ties → pid asc). */
export function sortProcesses(list: ProcessInfo[], sort: ProcessSort): ProcessInfo[] {
    const copy = [...list];

    if (sort === "name") {
        copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.pid - b.pid);
    } else {
        copy.sort((a, b) => b.rssBytes - a.rssBytes || a.pid - b.pid);
    }

    return copy;
}

async function runShell(cmd: string[]): Promise<string | null> {
    try {
        const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
        const out = await new Response(proc.stdout).text();
        await proc.exited;

        if (proc.exitCode !== 0) {
            return null;
        }

        return out;
    } catch (err) {
        logger.debug({ err, cmd }, "process-monitor: ps spawn failed");
        return null;
    }
}

export async function collectProcesses(): Promise<ProcessInfo[]> {
    const out = await runShell(["ps", "-axo", "pid=,rss=,etime=,%cpu=,comm="]);

    if (out === null) {
        return [];
    }

    return parseProcessRows(out);
}

/** SIGTERM the pid. Returns false on EPERM/ESRCH/invalid pid (never throws). */
export function killProcess(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 1) {
        return false;
    }

    try {
        process.kill(pid, "SIGTERM");
        return true;
    } catch (err) {
        logger.debug({ err, pid }, "process-monitor: kill failed");
        return false;
    }
}
