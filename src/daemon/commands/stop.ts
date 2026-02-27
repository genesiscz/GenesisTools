import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { getDaemonPid } from "../daemon";
import { getDaemonStatus, uninstallLaunchd } from "../lib/launchd";

export function registerStopCommand(program: Command): void {
    program
        .command("stop")
        .description("Stop the running daemon")
        .action(async () => {
            const pid = getDaemonPid();

            if (!pid) {
                p.log.info("Daemon is not running.");
                return;
            }

            const status = await getDaemonStatus();

            if (status.installed && status.running) {
                p.log.warn(
                    `Daemon is managed by launchd (KeepAlive). Use ${pc.cyan("tools daemon uninstall")} to fully stop it.`
                );

                const confirm = await p.confirm({
                    message: "Uninstall from launchd and stop?",
                });

                if (p.isCancel(confirm) || !confirm) {
                    return;
                }

                await uninstallLaunchd();
                p.log.success("Daemon uninstalled from launchd and stopped");
                return;
            }

            process.kill(pid, "SIGTERM");
            p.log.success(`Sent SIGTERM to daemon (PID ${pid})`);
        });
}
