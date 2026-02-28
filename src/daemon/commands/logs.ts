import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { runLogViewer } from "../interactive/log-viewer";
import { getLogsBaseDir } from "../lib/config";
import { DAEMON_STDERR_LOG, DAEMON_STDOUT_LOG } from "../lib/launchd";
import { listRunsForTask, parseLogFile } from "../lib/log-reader";

export function registerLogsCommand(program: Command): void {
    program
        .command("logs")
        .description("View task logs")
        .option("-t, --task <name>", "Show logs for a specific task")
        .option("--tail", "Tail daemon stdout/stderr logs")
        .action(async (opts: { task?: string; tail?: boolean }) => {
            if (opts.tail) {
                tailDaemonLogs();
                return;
            }

            if (opts.task) {
                showTaskLogs(opts.task);
                return;
            }

            await runLogViewer();
        });
}

function showTaskLogs(taskName: string): void {
    const logsBaseDir = getLogsBaseDir();
    const runs = listRunsForTask(logsBaseDir, taskName);

    if (runs.length === 0) {
        p.log.info(`No logs found for task "${taskName}".`);
        return;
    }

    const latest = runs[0];
    const entries = parseLogFile(latest.logFile);

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
                console.log(color(`[exit ${entry.code ?? "killed"} in ${formatDuration(entry.duration_ms)}]`));
                break;
            }
        }
    }
}

function tailDaemonLogs(): void {
    const files: string[] = [];

    if (existsSync(DAEMON_STDOUT_LOG)) {
        files.push(DAEMON_STDOUT_LOG);
    }

    if (existsSync(DAEMON_STDERR_LOG)) {
        files.push(DAEMON_STDERR_LOG);
    }

    if (files.length === 0) {
        p.log.warn("No daemon logs found. Is the daemon installed?");
        return;
    }

    p.log.info(`Tailing: ${pc.dim(files.join(", "))}`);
    p.log.info(pc.dim("Press Ctrl+C to stop"));

    const proc = Bun.spawn(["tail", "-f", ...files], {
        stdio: ["ignore", "inherit", "inherit"],
    });

    const cleanup = () => {
        proc.kill();
        process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    proc.exited.then(() => process.exit(0));
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
