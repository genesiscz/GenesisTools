import type { effectiveTask } from "@app/daemon/commands/config";
import type { getDaemonStatus } from "@app/daemon/lib/launchd";
import {
    clonesDaemonTasksRegistered,
    ensureClonesDaemonTasks,
    PRUNE_TASK_NAME,
    removeClonesDaemonTasks,
    SCAN_TASK_NAME,
} from "@app/macos/lib/clones/daemon-tasks";
import { loadClonesConfig, setDaemonEnabled } from "@app/macos/lib/clones/store";
import { Executor } from "@genesiscz/utils/cli";
import { printLn } from "@genesiscz/utils/cli/stdout";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Command } from "commander";

const log = logger.child({ component: "clones:daemon-cmd" });

export interface ClonesDaemonStatus {
    /** False after `clones daemon disable`: plans no longer register the tasks. */
    enabled: boolean;
    daemon: Awaited<ReturnType<typeof getDaemonStatus>>;
    /** The registered clone tasks with their effective settings; a task that is not registered is absent. */
    tasks: Array<ReturnType<typeof effectiveTask>>;
    registered: { scan: boolean; prune: boolean };
}

/** The clone tasks' state read from the daemon's own config and launchd, without spawning `tools`. */
export async function clonesDaemonStatus(): Promise<ClonesDaemonStatus> {
    // Loaded on use: the daemon's command and launchd modules are heavy, and only `status --json` needs them.
    const [{ effectiveTask }, { loadConfig }, { getDaemonStatus }] = await Promise.all([
        import("@app/daemon/commands/config"),
        import("@app/daemon/lib/config"),
        import("@app/daemon/lib/launchd"),
    ]);
    const [clonesConfig, daemonConfig, daemon] = await Promise.all([
        loadClonesConfig(),
        loadConfig(),
        getDaemonStatus(),
    ]);
    const tasks = daemonConfig.tasks
        .filter((task) => task.name === SCAN_TASK_NAME || task.name === PRUNE_TASK_NAME)
        .map(effectiveTask);
    return {
        enabled: clonesConfig.daemon !== false,
        daemon,
        tasks,
        registered: {
            scan: tasks.some((task) => task.name === SCAN_TASK_NAME),
            prune: tasks.some((task) => task.name === PRUNE_TASK_NAME),
        },
    };
}

export function createDaemonCommand(): Command {
    const daemon = new Command("daemon").description(
        "Daily clone-aware dry-run scan + notify, and the daily cache reconciliation"
    );

    daemon
        .command("enable")
        .description(
            `Register the daily clone-scan task with \`${toolCommand("daemon")}\` (a finished reclaim plan does this too)`
        )
        .option("--overwrite", "Overwrite an existing registration", true)
        .option("--json", "print {enabled, newlyRegistered: {scan, prune}, registered: {scan, prune}} as JSON")
        .action(async (opts: { overwrite?: boolean; json?: boolean }) => {
            await setDaemonEnabled(true);
            const done = await ensureClonesDaemonTasks({ overwrite: opts.overwrite !== false });
            if (opts.json) {
                // newlyRegistered: written by this call; registered: the state afterwards ("already there" is true here).
                const registered = await clonesDaemonTasksRegistered();
                await printLn(SafeJSON.stringify({ enabled: true, newlyRegistered: done, registered }, null, 2));
                return;
            }

            await printLn(
                done.scan ? `registered ${SCAN_TASK_NAME}` : `${SCAN_TASK_NAME} already registered (use --overwrite)`
            );
            await printLn(
                done.prune ? `registered ${PRUNE_TASK_NAME}` : `${PRUNE_TASK_NAME} already registered (use --overwrite)`
            );
        });

    daemon
        .command("disable")
        .description("Unregister the clone-scan task and stop plans from re-registering it")
        .option("--json", "print {enabled, removed: {scan, prune}, registered: {scan, prune}} as JSON")
        .action(async (opts: { json?: boolean }) => {
            // The opt-out has to be persisted, not just unregistered: a later
            // `reclaim plan` sees "no task" and would register both again.
            await setDaemonEnabled(false);
            const removed = await removeClonesDaemonTasks();
            if (opts.json) {
                const registered = await clonesDaemonTasksRegistered();
                await printLn(SafeJSON.stringify({ enabled: false, removed, registered }, null, 2));
                return;
            }

            await printLn(removed.scan ? `unregistered ${SCAN_TASK_NAME}` : `${SCAN_TASK_NAME} was not registered`);
            await printLn(removed.prune ? `unregistered ${PRUNE_TASK_NAME}` : `${PRUNE_TASK_NAME} was not registered`);
            await printLn(
                `a finished reclaim plan will not re-register them (${toolCommand("macos clones daemon enable")} does)`
            );
        });

    daemon
        .command("status")
        .description(`Show the clone-scan task via \`${toolCommand("daemon status")}\``)
        .option("--json", "print {enabled, daemon, tasks} for the two clone tasks as JSON")
        .action(async (opts: { json?: boolean }) => {
            if (opts.json) {
                await printLn(SafeJSON.stringify(await clonesDaemonStatus(), null, 2));
                return;
            }

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
            await printLn(
                filtered || `${SCAN_TASK_NAME}: no status (is the daemon running? \`${toolCommand("daemon start")}\`)`
            );
            if (result.exitCode !== 0) {
                log.warn({ exitCode: result.exitCode }, "daemon status returned non-zero");
            }
        });

    return daemon;
}
