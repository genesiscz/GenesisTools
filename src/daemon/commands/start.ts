import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { getDaemonPid, startDaemon } from "../daemon";
import { getDaemonStatus } from "../lib/launchd";

export function registerStartCommand(program: Command): void {
    program
        .command("start")
        .description("Run the daemon in foreground")
        .action(async () => {
            const existing = getDaemonPid();

            if (existing) {
                p.log.info(`Daemon already running (PID ${existing})`);
                return;
            }

            const status = await getDaemonStatus();

            if (status.running) {
                p.log.warn(
                    `Daemon is already running via launchd (PID ${status.pid}). Use ${pc.cyan("tools daemon uninstall")} first to avoid duplicate execution.`
                );
                return;
            }

            p.log.info("Starting daemon in foreground... (Ctrl+C to stop)");
            await startDaemon();
        });
}
