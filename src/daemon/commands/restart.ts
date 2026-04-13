import { getDaemonStatus } from "@app/daemon/lib/launchd";
import { safeSigterm, waitForDaemonRestart } from "@app/daemon/lib/wait-for-restart";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

export function registerRestartCommand(program: Command): void {
    program
        .command("restart")
        .description("Restart the daemon (kill and let launchd re-launch)")
        .action(async () => {
            const status = await getDaemonStatus();

            if (!status.installed) {
                p.log.error(`Daemon is not installed via launchd. Run ${pc.cyan("tools daemon install")} first.`);
                return;
            }

            if (!status.running || !status.pid) {
                p.log.warn("Daemon is not currently running.");

                const s = p.spinner();
                s.start("Waiting for launchd to start...");
                const result = await waitForDaemonRestart(null);

                if (result) {
                    s.stop(`Daemon started (PID ${result.pid})`);
                } else {
                    s.stop("Daemon did not start within 10s");
                    p.log.warn(`Check logs: ${pc.cyan("tools daemon logs")}`);
                }

                return;
            }

            const oldPid = status.pid;
            safeSigterm(oldPid);

            const s = p.spinner();
            s.start("Restarting daemon...");

            const result = await waitForDaemonRestart(oldPid);

            if (result) {
                s.stop(`Daemon restarted (PID ${oldPid} → ${result.pid})`);
            } else {
                s.stop("Restart timed out");
                p.log.warn(
                    `Daemon did not restart within 10s. Check: ${pc.cyan("tools daemon status")} or ${pc.cyan("tools daemon logs")}`
                );
            }
        });
}
