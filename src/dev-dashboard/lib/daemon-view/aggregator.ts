import { isAbsolute, relative, resolve } from "node:path";
import { getLogsBaseDir, loadConfig } from "@app/daemon/lib/config";
import { getDaemonStatus } from "@app/daemon/lib/launchd";
import { listRunsForTask, listTasksWithLogs, parseLogFile } from "@app/daemon/lib/log-reader";
import type { DaemonOverview, LogEntry, RunSummary } from "./types";

export async function getDaemonOverview(): Promise<DaemonOverview> {
    const status = await getDaemonStatus();
    const config = await loadConfig();

    return { status, tasks: config.tasks };
}

function clampLimit(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function getRecentRuns(opts: { task: string; limit: number }): RunSummary[] {
    const limit = clampLimit(opts.limit);

    if (limit === 0) {
        return [];
    }

    return listRunsForTask(getLogsBaseDir(), opts.task, limit).slice(0, limit);
}

export function getAllRecentRuns(limit: number): RunSummary[] {
    const safeLimit = clampLimit(limit);

    if (safeLimit === 0) {
        return [];
    }

    const logsBaseDir = getLogsBaseDir();
    const tasks = listTasksWithLogs(logsBaseDir);
    const all: RunSummary[] = [];
    for (const task of tasks) {
        // Per-task newest-`limit` is enough: the global newest `limit` is a
        // subset, so this stays correct while avoiding a full directory scan.
        all.push(...listRunsForTask(logsBaseDir, task, safeLimit));
    }

    all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    return all.slice(0, safeLimit);
}

export function getRunLog(logFile: string, baseDir: string = getLogsBaseDir()): LogEntry[] {
    // logFile arrives straight from the ?logFile= query param. Contain it to the
    // daemon logs dir so a crafted value can't read arbitrary files.
    const root = resolve(baseDir);
    const resolved = resolve(logFile);
    const rel = relative(root, resolved);

    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error("logFile escapes the daemon logs directory");
    }

    return parseLogFile(resolved);
}
