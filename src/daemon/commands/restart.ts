import { getDaemonStatus, installLaunchd } from "@app/daemon/lib/launchd";
import { stopWithEscalation, waitForDaemonRestart } from "@app/daemon/lib/wait-for-restart";
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

            if (status.needsMigration) {
                // The user asked for a restart, so this is the moment to move the job under
                // GenesisTools.app: reinstall rewrites the plist and launchd relaunches it.
                const s = p.spinner();
                s.start("Migrating daemon to GenesisTools.app…");

                try {
                    await installLaunchd();
                    const result = await waitForDaemonRestart(status.pid);
                    s.stop(
                        result
                            ? `Daemon restarted under GenesisTools.app (PID ${result.pid})`
                            : "Daemon reinstalled under GenesisTools.app, but did not report a PID within 10s"
                    );
                } catch (err) {
                    // The spinner owns the terminal line: leaving it running hides the error.
                    s.stop("Migration to GenesisTools.app failed");
                    throw err;
                }

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

            const s = p.spinner();
            s.start("Restarting daemon...");

            // Escalating stop (SIGTERM → SIGTERM → SIGKILL): a wedged daemon
            // used to ignore the single SIGTERM and 'restart' just timed out.
            const stopResult = await stopWithEscalation(oldPid);

            if (!stopResult.exited) {
                s.stop(`Daemon (PID ${oldPid}) survived SIGTERM→SIGTERM→SIGKILL — inspect it manually`);
                return;
            }

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
