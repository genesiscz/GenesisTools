import { fileURLToPath } from "node:url";
import { registerTask, unregisterTask } from "@app/daemon/lib/register";
import { Executor } from "@genesiscz/utils/cli";
import { printLn } from "@genesiscz/utils/cli/stdout";
import { logger } from "@genesiscz/utils/logger";
import { escapeShellArg } from "@genesiscz/utils/string";
import { Command } from "commander";

const log = logger.child({ component: "clones:daemon-cmd" });
const TASK_NAME = "macos-clones-scan";
const PRUNE_TASK_NAME = "macos-clones-cache-prune";

function resolveScriptCommand(relative: string): string {
    const absBun = Bun.which("bun") ?? process.execPath;
    const absScript = fileURLToPath(new URL(relative, import.meta.url));
    // The registered command is run via shell by `tools daemon`. Quote BOTH
    // paths so spaces / quotes / shell metachars in absBun or absScript
    // can't inject. macOS dev paths often contain spaces (e.g. ~/Library/...).
    return `${escapeShellArg(absBun)} run ${escapeShellArg(absScript)}`;
}

function resolveScanCommand(): string {
    return resolveScriptCommand("../../lib/clones/scan-daemon.ts");
}

function resolvePruneCommand(): string {
    return resolveScriptCommand("../../lib/clones/cache-prune-daemon.ts");
}

export function createDaemonCommand(): Command {
    const daemon = new Command("daemon").description(
        "Daily clone-aware dry-run scan + notify, and the daily cache reconciliation"
    );

    daemon
        .command("enable")
        .description("Register the daily clone-scan task with `tools daemon`")
        .option("--overwrite", "Overwrite an existing registration", true)
        .action(async (opts: { overwrite?: boolean }) => {
            const created = await registerTask({
                name: TASK_NAME,
                command: resolveScanCommand(),
                every: "every day at 03:00",
                overwrite: opts.overwrite !== false,
                notify: true,
                timeoutMs: 30 * 60_000,
                retries: 1,
                retention: { maxAgeDays: 14, minRuns: 14 },
                description: "Clone-aware dry-run scan of watched dirs; notify reclaimable",
            });
            await printLn(created ? `registered ${TASK_NAME}` : `${TASK_NAME} already registered (use --overwrite)`);
            const prune = await registerTask({
                name: PRUNE_TASK_NAME,
                command: resolvePruneCommand(),
                every: "every day at 04:00",
                overwrite: opts.overwrite !== false,
                notify: false,
                timeoutMs: 30 * 60_000,
                retries: 1,
                retention: { maxAgeDays: 14, minRuns: 14 },
                description: "Drop file-meta cache rows that are stale or whose paths are gone; VACUUM when it pays",
            });
            await printLn(
                prune ? `registered ${PRUNE_TASK_NAME}` : `${PRUNE_TASK_NAME} already registered (use --overwrite)`
            );
        });

    daemon
        .command("disable")
        .description("Unregister the clone-scan task")
        .action(async () => {
            const removed = await unregisterTask(TASK_NAME);
            await printLn(removed ? `unregistered ${TASK_NAME}` : `${TASK_NAME} was not registered`);
            const prune = await unregisterTask(PRUNE_TASK_NAME);
            await printLn(prune ? `unregistered ${PRUNE_TASK_NAME}` : `${PRUNE_TASK_NAME} was not registered`);
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
                        line.includes(TASK_NAME) ||
                        line.includes(PRUNE_TASK_NAME) ||
                        line.startsWith("name") ||
                        line.trim() === ""
                )
                .join("\n");
            await printLn(filtered || `${TASK_NAME}: no status (is the daemon running? \`tools daemon start\`)`);
            if (result.exitCode !== 0) {
                log.warn({ exitCode: result.exitCode }, "daemon status returned non-zero");
            }
        });

    return daemon;
}
