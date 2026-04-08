import { getDaemonPid } from "@app/daemon/daemon";
import { getDaemonStatus, uninstallLaunchd } from "@app/daemon/lib/launchd";
import { safeSigterm, waitForDaemonRestart } from "@app/daemon/lib/wait-for-restart";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

export function registerStopCommand(program: Command): void {
    program
        .command("stop")
        .description("Stop the running daemon")
        .option("--uninstall", "Also uninstall from launchd (permanent stop)")
        .action(async (opts: { uninstall?: boolean }) => {
            const status = await getDaemonStatus();
            const fgPid = getDaemonPid();
            const pid = status.pid ?? fgPid;

            if (!pid && !status.running) {
                p.log.info("Daemon is not running.");
                return;
            }

            if (opts.uninstall && status.installed) {
                await uninstallLaunchd();
                p.log.success("Daemon uninstalled from launchd and stopped");
                return;
            }

            if (pid) {
                safeSigterm(pid);
            }

            if (!status.installed) {
                p.log.success(`Sent SIGTERM to daemon (PID ${pid})`);
                return;
            }

            const s = p.spinner();
            s.start("Launchd restarting daemon...");

            const result = await waitForDaemonRestart(pid);

            if (result) {
                s.stop(`Daemon bounced (PID ${pid} → ${result.pid})`);
                p.log.info(pc.dim(`To stop permanently: ${pc.cyan("tools daemon uninstall")}`));
            } else {
                s.stop("Daemon stopped");
                p.log.warn(`Launchd did not restart within 10s. Check: ${pc.cyan("tools daemon logs")}`);
            }
        });
}
