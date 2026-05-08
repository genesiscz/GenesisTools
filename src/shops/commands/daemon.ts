import { type RegisterTaskOptions, registerTask, unregisterTask } from "@app/daemon/lib/register";
import logger from "@app/logger";
import { Executor } from "@app/utils/cli";
import type { Command } from "commander";

const log = logger.child({ component: "shops:daemon-cmd" });

export const SHOPS_DAEMON_TASKS: RegisterTaskOptions[] = [
    {
        name: "shops:watchlist-check",
        command: "tools shops watch tick",
        every: "every 1 hour",
        retries: 3,
        notify: false,
        description: "Evaluate favorites for discount alerts",
    },
    {
        name: "shops:prune-http-requests",
        command: "tools shops db prune-http",
        every: "every 1 day",
        retries: 1,
        description: "Delete http_requests rows older than 30 days",
    },
];

export function registerDaemonCommand(program: Command): void {
    const daemon = program.command("daemon").description("Background tasks (watchlist tick + DB prune)");

    daemon
        .command("enable")
        .description("Register Plan 02's watchlist + prune tasks with `tools daemon`")
        .option("--overwrite", "Overwrite existing task registrations", false)
        .action(async (opts: { overwrite?: boolean }) => {
            for (const t of SHOPS_DAEMON_TASKS) {
                const created = await registerTask({ ...t, overwrite: opts.overwrite });
                console.log(created ? `registered ${t.name}` : `${t.name} already registered (use --overwrite)`);
            }
        });

    daemon
        .command("disable")
        .description("Unregister all Plan 02 tasks")
        .action(async () => {
            for (const t of SHOPS_DAEMON_TASKS) {
                const removed = await unregisterTask(t.name);
                console.log(removed ? `unregistered ${t.name}` : `${t.name} was not registered`);
            }
        });

    daemon
        .command("status")
        .description("Show shops:* tasks via `tools daemon status`")
        .action(async () => {
            const result = await new Executor().exec(["tools", "daemon", "status"]);
            const filtered = result.stdout
                .split("\n")
                .filter((line: string) => line.includes("shops:") || line.startsWith("name") || line.trim() === "")
                .join("\n");
            console.log(filtered);
            if (result.exitCode !== 0) {
                log.warn({ exitCode: result.exitCode }, "daemon status returned non-zero");
            }
        });
}
