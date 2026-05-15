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
    return listRunsForTask(getLogsBaseDir(), opts.task).slice(0, opts.limit);
}

export function getAllRecentRuns(limit: number): RunSummary[] {
    const logsBaseDir = getLogsBaseDir();
    const tasks = listTasksWithLogs(logsBaseDir);
    const all: RunSummary[] = [];
    for (const task of tasks) {
        all.push(...listRunsForTask(logsBaseDir, task));
    }

    all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    return all.slice(0, limit);
}

export function getRunLog(logFile: string): LogEntry[] {
    return parseLogFile(logFile);
}
