import type { ProcessInfo, ProcessSort } from "@app/dev-dashboard/lib/system/types";
import { logger } from "@genesiscz/utils/logger";
import { listProcessesWithUsage, readExecutablePath } from "@genesiscz/utils/process/processes";
import { readProcessCommand } from "@genesiscz/utils/process-identity";

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

export async function collectProcesses(): Promise<ProcessInfo[]> {
    const now = Date.now();
    return listProcessesWithUsage({ otherUsers: true }).map((entry) => {
        const uptimeMs = entry.startMs === null ? 0 : Math.max(0, now - entry.startMs);
        return {
            pid: entry.pid,
            rssBytes: entry.usage?.rssBytes ?? 0,
            uptimeMs,
            // Lifetime average: the kernel has no ps-style decayed CPU percentage.
            cpuPct: uptimeMs > 0 ? (100 * (entry.usage?.cpuTimeMs ?? 0)) / uptimeMs : 0,
            name: friendlyProcessName(readExecutablePath(entry.pid) ?? entry.name),
        };
    });
}

/**
 * SIGTERM the pid. Returns false on EPERM/ESRCH/invalid pid (never throws).
 *
 * `expectedCommand` is the command the caller listed for this pid. The pid
 * reaches us over HTTP from a table the browser rendered at some earlier
 * moment, so by click time the process may have exited and the kernel may have
 * reissued its number. Mirrors the identity check the port killer already does
 * (see `lib/ports/scanner.ts killPort`).
 */
export function killProcess(pid: number, expectedCommand: string): boolean {
    if (!Number.isInteger(pid) || pid <= 1) {
        return false;
    }

    // Fails CLOSED. An earlier version made this check conditional on the
    // caller supplying a command, which meant any request that simply omitted
    // it got an unchecked SIGTERM straight off the network.
    if (!expectedCommand.trim()) {
        logger.warn({ pid }, "process-monitor: no expected command supplied; refusing to kill");
        return false;
    }

    const live = readProcessCommand(pid);

    if (live === null) {
        return false;
    }

    // Compare the whole listed name, not a fixed-length prefix: `node `,
    // `python3 ` and `bun run ` share long prefixes, so 8 characters does not
    // tell sibling interpreters apart.
    if (!live.toLowerCase().includes(expectedCommand.trim().toLowerCase())) {
        logger.warn({ pid, expectedCommand, live }, "process-monitor: command mismatch; refusing to kill");
        return false;
    }

    try {
        // pid-verified: reached only after the required expectedCommand matched the live command
        process.kill(pid, "SIGTERM");
        return true;
    } catch (err) {
        logger.debug({ err, pid }, "process-monitor: kill failed");
        return false;
    }
}
