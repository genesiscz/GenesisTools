import { fileURLToPath } from "node:url";
import { registerTask, unregisterTask } from "@app/daemon/lib/register";
import logger from "@app/logger";
import { Executor } from "@app/utils/cli";
import { Command } from "commander";

const log = logger.child({ component: "clones:daemon-cmd" });
const TASK_NAME = "macos-clones-scan";

/** POSIX shell single-quote: wrap in single quotes and escape embedded ones.
 *  Safe for any path including spaces, quotes, dollar signs, backticks. */
function shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}

function resolveScanCommand(): string {
    const absBun = Bun.which("bun") ?? process.execPath;
    const absScanScript = fileURLToPath(new URL("../../lib/clones/scan-daemon.ts", import.meta.url));
    // The registered command is run via shell by `tools daemon`. Quote BOTH
    // paths so spaces / quotes / shell metachars in absBun or absScanScript
    // can't inject. macOS dev paths often contain spaces (e.g. ~/Library/...).
    return `${shellQuote(absBun)} run ${shellQuote(absScanScript)}`;
}

export function createDaemonCommand(): Command {
    const daemon = new Command("daemon").description("Once/24h clone-aware dry-run scan + notify (report-only)");

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
            console.log(created ? `registered ${TASK_NAME}` : `${TASK_NAME} already registered (use --overwrite)`);
        });

    daemon
        .command("disable")
        .description("Unregister the clone-scan task")
        .action(async () => {
            const removed = await unregisterTask(TASK_NAME);
            console.log(removed ? `unregistered ${TASK_NAME}` : `${TASK_NAME} was not registered`);
        });

    daemon
        .command("status")
        .description("Show the clone-scan task via `tools daemon status`")
        .action(async () => {
            const result = await new Executor().exec(["tools", "daemon", "status"]);
            const filtered = result.stdout
                .split("\n")
                .filter((line) => line.includes(TASK_NAME) || line.startsWith("name") || line.trim() === "")
                .join("\n");
            console.log(filtered || `${TASK_NAME}: no status (is the daemon running? \`tools daemon start\`)`);
            if (result.exitCode !== 0) {
                log.warn({ exitCode: result.exitCode }, "daemon status returned non-zero");
            }
        });

    return daemon;
}
