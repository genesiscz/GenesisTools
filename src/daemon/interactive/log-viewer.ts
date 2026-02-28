import * as p from "@clack/prompts";
import pc from "picocolors";
import { getLogsBaseDir } from "../lib/config";
import { listRunsForTask, listTasksWithLogs, parseLogFile } from "../lib/log-reader";

export async function runLogViewer(): Promise<void> {
    const logsBaseDir = getLogsBaseDir();

    while (true) {
        const tasks = listTasksWithLogs(logsBaseDir);

        if (tasks.length === 0) {
            p.log.info("No task logs found yet.");
            return;
        }

        const taskName = await p.select({
            message: "Select task",
            options: [...tasks.map((t) => ({ value: t, label: t })), { value: "back", label: pc.dim("← Back") }],
        });

        if (p.isCancel(taskName) || taskName === "back") {
            break;
        }

        await showTaskRuns(taskName);
    }
}

async function showTaskRuns(taskName: string): Promise<void> {
    const logsBaseDir = getLogsBaseDir();

    while (true) {
        const runs = listRunsForTask(logsBaseDir, taskName);

        if (runs.length === 0) {
            p.log.info(`No runs found for "${taskName}".`);
            return;
        }

        const selected = await p.select({
            message: `Runs for ${pc.bold(taskName)}`,
            options: [
                ...runs.slice(0, 50).map((r) => ({
                    value: r.logFile,
                    label: formatRunLabel(r.startedAt, r.exitCode, r.duration_ms, r.attempt),
                })),
                { value: "back", label: pc.dim("← Back") },
            ],
        });

        if (p.isCancel(selected) || selected === "back") {
            break;
        }

        showLogContent(selected);

        const cont = await p.confirm({ message: "View another run?" });

        if (p.isCancel(cont) || !cont) {
            break;
        }
    }
}

function showLogContent(logFile: string): void {
    const entries = parseLogFile(logFile);

    console.log("");

    for (const entry of entries) {
        switch (entry.type) {
            case "meta":
                p.log.info(
                    `${pc.bold(entry.taskName)}  cmd: ${pc.cyan(entry.command)}  attempt: ${entry.attempt}  run: ${entry.runId}`
                );
                break;
            case "stdout":
                console.log(entry.data);
                break;
            case "stderr":
                console.log(pc.yellow(entry.data));
                break;
            case "exit": {
                const color = entry.code === 0 ? pc.green : pc.red;
                console.log(color(`\n[exit ${entry.code ?? "killed"} in ${formatDuration(entry.duration_ms)}]`));
                break;
            }
        }
    }

    console.log("");
}

function formatRunLabel(
    startedAt: string,
    exitCode: number | null,
    durationMs: number | null,
    attempt: number
): string {
    const date = startedAt.replace("T", " ").slice(0, 19);
    const code = exitCode === null ? pc.dim("?") : exitCode === 0 ? pc.green("0") : pc.red(String(exitCode));
    const dur = durationMs !== null ? formatDuration(durationMs) : "?";
    const att = attempt > 1 ? pc.dim(` attempt:${attempt}`) : "";

    return `${pc.dim(date)}  exit:${code}  ${pc.dim(dur)}${att}`;
}

function formatDuration(ms: number): string {
    if (ms < 1000) {
        return `${ms}ms`;
    }

    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }

    return `${(ms / 60_000).toFixed(1)}m`;
}
