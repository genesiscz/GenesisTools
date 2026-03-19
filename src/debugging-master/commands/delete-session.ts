import { SessionManager } from "@app/debugging-master/core/session-manager";
import { parseVariadic } from "@app/utils/cli/variadic";
import { confirm } from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

export function registerDeleteSessionCommand(program: Command): void {
    program
        .command("delete-session")
        .description("Delete debugging sessions")
        .argument("[names...]", "Session names to delete (comma-separated)")
        .option("--inactive", "Delete sessions inactive for >24h")
        .option("--all", "Delete all sessions")
        .option("--force", "Skip confirmation (for non-TTY)")
        .action(async (rawNames: string[], opts: { inactive?: boolean; all?: boolean; force?: boolean }) => {
            const sm = new SessionManager();
            let toDelete: string[] = [];

            if (opts.all) {
                toDelete = await sm.listSessionNames();

                if (toDelete.length === 0) {
                    console.log(pc.dim("No sessions to delete."));
                    return;
                }
            } else if (opts.inactive) {
                const inactive = await sm.getInactiveSessions();
                toDelete = inactive.map((s) => s.name);

                if (toDelete.length === 0) {
                    console.log(pc.dim("No inactive sessions found."));
                    return;
                }
            } else {
                toDelete = parseVariadic(rawNames);

                if (toDelete.length === 0) {
                    console.error(pc.red("No session names provided. Use positional args, --inactive, or --all."));
                    process.exit(1);
                }
            }

            console.log(pc.bold(`Sessions to delete (${toDelete.length}):`));
            for (const name of toDelete) {
                console.log(`  ${name}`);
            }
            console.log("");

            if (process.stdout.isTTY && !opts.force) {
                const confirmed = await confirm({
                    message: `Delete ${toDelete.length} session(s)?`,
                });

                if (typeof confirmed === "symbol" || !confirmed) {
                    console.log(pc.dim("Cancelled."));
                    return;
                }
            } else if (!opts.force) {
                console.error(pc.red("Non-TTY environment. Use --force to skip confirmation."));
                process.exit(1);
            }

            let deleted = 0;
            let notFound = 0;

            for (const name of toDelete) {
                const result = await sm.deleteSession(name);

                if (result) {
                    deleted++;
                    console.log(pc.green(`  Deleted: ${name}`));
                } else {
                    notFound++;
                    console.log(pc.yellow(`  Not found: ${name}`));
                }
            }

            console.log("");
            console.log(pc.bold(`Done: ${deleted} deleted${notFound > 0 ? `, ${notFound} not found` : ""}`));
        });
}
