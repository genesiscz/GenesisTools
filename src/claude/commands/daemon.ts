import { resolve } from "node:path";
import { getDaemonStatus } from "@app/daemon/lib/launchd";
import { isTaskRegistered, registerTask, unregisterTask } from "@app/daemon/lib/register";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

const TASK_NAME = "claude-usage-poll";
const POLL_SCRIPT = resolve(import.meta.dir, "../lib/usage/poll-daemon.ts");

function bunPath(): string {
    return Bun.which("bun") ?? "bun";
}

export function registerDaemonCommand(program: Command): void {
    const daemon = program.command("daemon").description("Manage background usage polling via the daemon scheduler");

    daemon
        .command("register")
        .description("Register usage polling as a daemon task")
        .option("-i, --interval <interval>", "Polling interval", "every 1 minute")
        .action(async (opts: { interval: string }) => {
            const created = await registerTask({
                name: TASK_NAME,
                command: `${bunPath()} run ${POLL_SCRIPT}`,
                every: opts.interval,
                retries: 1,
                description: "Poll Claude usage API and record to history DB",
                overwrite: true,
            });

            if (created) {
                p.log.success(`Registered task ${pc.cyan(TASK_NAME)} (${opts.interval})`);
            } else {
                p.log.info(`Updated task ${pc.cyan(TASK_NAME)} (${opts.interval})`);
            }

            const status = await getDaemonStatus();

            if (!status.running) {
                p.log.warn(
                    `Daemon is not running. Start it with: ${pc.cyan("tools daemon start")} or ${pc.cyan("tools daemon install")}`
                );
            }
        });

    daemon
        .command("unregister")
        .description("Remove usage polling from daemon")
        .action(async () => {
            const removed = await unregisterTask(TASK_NAME);

            if (removed) {
                p.log.success(`Removed task ${pc.cyan(TASK_NAME)}`);
            } else {
                p.log.warn(`Task ${pc.cyan(TASK_NAME)} was not registered`);
            }
        });

    daemon
        .command("status")
        .description("Check if usage polling is registered and daemon status")
        .action(async () => {
            const registered = await isTaskRegistered(TASK_NAME);
            const daemonStatus = await getDaemonStatus();

            if (registered) {
                p.log.success(`Task ${pc.cyan(TASK_NAME)} is registered`);
            } else {
                p.log.warn(
                    `Task ${pc.cyan(TASK_NAME)} is not registered. Run: ${pc.cyan("tools claude daemon register")}`
                );
            }

            if (daemonStatus.running) {
                p.log.success(`Daemon running (PID ${daemonStatus.pid})`);
            } else if (daemonStatus.installed) {
                p.log.warn("Daemon installed but not running");
            } else {
                p.log.info(`Daemon not installed. Run: ${pc.cyan("tools daemon install")}`);
            }
        });
}
