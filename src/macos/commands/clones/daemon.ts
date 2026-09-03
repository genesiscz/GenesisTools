import {
    ensureClonesDaemonTasks,
    PRUNE_TASK_NAME,
    removeClonesDaemonTasks,
    SCAN_TASK_NAME,
} from "@app/macos/lib/clones/daemon-tasks";
import { Executor } from "@genesiscz/utils/cli";
import { printLn } from "@genesiscz/utils/cli/stdout";
import { logger } from "@genesiscz/utils/logger";
import { Command } from "commander";

const log = logger.child({ component: "clones:daemon-cmd" });

export function createDaemonCommand(): Command {
    const daemon = new Command("daemon").description(
        "Daily clone-aware dry-run scan + notify, and the daily cache reconciliation"
    );

    daemon
        .command("enable")
        .description("Register the daily clone-scan task with `tools daemon` (a finished reclaim plan does this too)")
        .option("--overwrite", "Overwrite an existing registration", true)
        .action(async (opts: { overwrite?: boolean }) => {
            const done = await ensureClonesDaemonTasks({ overwrite: opts.overwrite !== false });
            await printLn(
                done.scan ? `registered ${SCAN_TASK_NAME}` : `${SCAN_TASK_NAME} already registered (use --overwrite)`
            );
            await printLn(
                done.prune ? `registered ${PRUNE_TASK_NAME}` : `${PRUNE_TASK_NAME} already registered (use --overwrite)`
            );
        });

    daemon
        .command("disable")
        .description("Unregister the clone-scan task")
        .action(async () => {
            const removed = await removeClonesDaemonTasks();
            await printLn(removed.scan ? `unregistered ${SCAN_TASK_NAME}` : `${SCAN_TASK_NAME} was not registered`);
            await printLn(removed.prune ? `unregistered ${PRUNE_TASK_NAME}` : `${PRUNE_TASK_NAME} was not registered`);
        });

    daemon
        .command("status")
        .description("Show the clone-scan task via `tools daemon status`")
        .action(async () => {
            const result = await new Executor().exec(["tools", "daemon", "status"]);
            const filtered = result.stdout
                .split("\n")
                .filter(
                    (line) =>
                        line.includes(SCAN_TASK_NAME) ||
                        line.includes(PRUNE_TASK_NAME) ||
                        line.startsWith("name") ||
                        line.trim() === ""
                )
                .join("\n");
            await printLn(filtered || `${SCAN_TASK_NAME}: no status (is the daemon running? \`tools daemon start\`)`);
            if (result.exitCode !== 0) {
                log.warn({ exitCode: result.exitCode }, "daemon status returned non-zero");
            }
        });

    return daemon;
}
