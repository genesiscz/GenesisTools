import * as p from "@clack/prompts";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import { LAUNCHD_MIGRATION_HINT } from "@genesiscz/utils/macos/genesis-app";
import type { Command } from "commander";
import pc from "picocolors";
import { getDaemonPid } from "../daemon";
import { getConfigPath, getLogsBaseDir, loadConfig } from "../lib/config";
import { formatInterval } from "../lib/interval";
import { getDaemonStatus } from "../lib/launchd";
import { effectiveTask } from "./config";

export function registerStatusCommand(program: Command): void {
    program
        .command("status")
        .description("Show daemon and task status")
        .option("--json", "the daemon process and every task with its effective settings, as JSON")
        .action(async (opts: { json?: boolean }) => {
            const status = await getDaemonStatus();
            const fgPid = getDaemonPid();

            if (opts.json) {
                const config = await loadConfig();
                out.result({
                    daemon: { ...status, foregroundPid: fgPid ?? null },
                    configPath: getConfigPath(),
                    logsBaseDir: getLogsBaseDir(),
                    tasks: config.tasks.map(effectiveTask),
                });
                return;
            }

            if (status.running) {
                p.log.success(`Daemon running (launchd, PID ${status.pid})`);
            } else if (fgPid) {
                p.log.success(`Daemon running (foreground, PID ${fgPid})`);
            } else if (status.installed) {
                p.log.warn("Daemon installed but not running");
            } else {
                p.log.info(`Daemon not running. Run: ${toolCommand("daemon install")}`);
            }

            if (status.needsMigration) {
                p.log.warn(`Daemon ${LAUNCHD_MIGRATION_HINT}: ${pc.cyan(toolCommand("daemon restart"))}`);
            }

            const config = await loadConfig();

            if (config.tasks.length === 0) {
                p.log.info("No tasks configured.");
                return;
            }

            out.println("");

            for (const task of config.tasks) {
                const state = task.enabled ? pc.green("enabled") : pc.dim("disabled");
                const retries = task.retries > 0 ? pc.dim(` retries:${task.retries}`) : "";
                p.log.step(
                    `${pc.bold(task.name)} [${state}] ${pc.dim(formatInterval(task.every))}${retries}\n  ${pc.cyan(task.command)}`
                );
            }
        });
}
