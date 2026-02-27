import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { getDaemonPid } from "../daemon";
import { loadConfig } from "../lib/config";
import { formatInterval } from "../lib/interval";
import { getDaemonStatus } from "../lib/launchd";

export function registerStatusCommand(program: Command): void {
    program
        .command("status")
        .description("Show daemon and task status")
        .action(async () => {
            const status = await getDaemonStatus();
            const fgPid = getDaemonPid();

            if (status.running) {
                p.log.success(`Daemon running (launchd, PID ${status.pid})`);
            } else if (fgPid) {
                p.log.success(`Daemon running (foreground, PID ${fgPid})`);
            } else if (status.installed) {
                p.log.warn("Daemon installed but not running");
            } else {
                p.log.info("Daemon not running. Run: tools daemon install");
            }

            const config = await loadConfig();

            if (config.tasks.length === 0) {
                p.log.info("No tasks configured.");
                return;
            }

            console.log("");

            for (const task of config.tasks) {
                const state = task.enabled ? pc.green("enabled") : pc.dim("disabled");
                const retries = task.retries > 0 ? pc.dim(` retries:${task.retries}`) : "";
                p.log.step(
                    `${pc.bold(task.name)} [${state}] ${pc.dim(formatInterval(task.every))}${retries}\n  ${pc.cyan(task.command)}`
                );
            }
        });
}
