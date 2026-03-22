import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { IndexerManager } from "../lib/manager";

interface RemoveOptions {
    force?: boolean;
}

export function registerRemoveCommand(program: Command): void {
    program
        .command("remove")
        .description("Remove one or more indexes and their data")
        .argument("[name]", "Index name to remove (interactive multiselect if omitted)")
        .option("--force", "Skip confirmation (required in non-TTY)")
        .action(async (name: string | undefined, opts: RemoveOptions) => {
            const manager = await IndexerManager.load();

            try {
                const allNames = manager.getIndexNames();

                if (allNames.length === 0) {
                    p.log.info("No indexes to remove.");
                    return;
                }

                let toRemove: string[];

                if (name) {
                    if (!allNames.includes(name)) {
                        p.log.error(`Index "${name}" not found. Available: ${allNames.join(", ")}`);
                        process.exit(1);
                    }

                    toRemove = [name];
                } else {
                    if (!process.stdout.isTTY || !process.stdin.isTTY) {
                        p.log.error("Specify an index name in non-interactive mode:");
                        p.log.info(`  Available: ${allNames.join(", ")}`);
                        p.log.info("  Usage: tools indexer remove <name> [--force]");
                        process.exit(1);
                    }

                    const selected = await p.multiselect({
                        message: "Select indexes to remove",
                        options: allNames.map((n) => ({ value: n, label: n })),
                        required: true,
                    });

                    if (p.isCancel(selected)) {
                        p.log.info("Cancelled");
                        return;
                    }

                    toRemove = selected as string[];
                }

                if (toRemove.length === 0) {
                    p.log.info("Nothing selected.");
                    return;
                }

                // Confirm each one (unless --force)
                for (const indexName of toRemove) {
                    if (!opts.force) {
                        if (!process.stdout.isTTY || !process.stdin.isTTY) {
                            p.log.error("Use --force in non-interactive mode");
                            process.exit(1);
                        }

                        const confirmed = await p.confirm({
                            message: `Remove "${pc.bold(indexName)}" and all its data?`,
                        });

                        if (p.isCancel(confirmed) || !confirmed) {
                            p.log.info(`Skipped "${indexName}"`);
                            continue;
                        }
                    }

                    await manager.removeIndex(indexName);
                    p.log.success(`Removed "${pc.bold(indexName)}"`);
                }
            } finally {
                await manager.close();
            }
        });
}
