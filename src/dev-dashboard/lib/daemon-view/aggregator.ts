import { resolve } from "node:path";
import { getLogsBaseDir, loadConfig } from "@app/daemon/lib/config";
import { getDaemonStatus } from "@app/daemon/lib/launchd";
import { listRunsForTask, listTasksWithLogs, parseLogFile } from "@app/daemon/lib/log-reader";
import type { DaemonOverview, LogEntry, RunSummary } from "./types";

export async function getDaemonOverview(): Promise<DaemonOverview> {
    const status = await getDaemonStatus();
    const config = await loadConfig();

    return { status, tasks: config.tasks };
}

export function getRecentRuns(opts: { task: string; limit: number }): RunSummary[] {
    return listRunsForTask(getLogsBaseDir(), opts.task, opts.limit).slice(0, opts.limit);
}

export function getAllRecentRuns(limit: number): RunSummary[] {
    const logsBaseDir = getLogsBaseDir();
    const tasks = listTasksWithLogs(logsBaseDir);
    const all: RunSummary[] = [];
    for (const task of tasks) {
        // Per-task newest-`limit` is enough: the global newest `limit` is a
        // subset, so this stays correct while avoiding a full directory scan.
        all.push(...listRunsForTask(logsBaseDir, task, limit));
    }

    all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    return all.slice(0, limit);
}

export function getRunLog(logFile: string, baseDir: string = getLogsBaseDir()): LogEntry[] {
    // logFile arrives straight from the ?logFile= query param. Contain it to the
    // daemon logs dir so a crafted value can't read arbitrary files.
    const root = resolve(baseDir);
    const resolved = resolve(logFile);

    if (resolved !== root && !resolved.startsWith(`${root}/`)) {
        throw new Error("logFile escapes the daemon logs directory");
    }

    return parseLogFile(resolved);
}
