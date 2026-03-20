import { formatDuration } from "@app/utils/format";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { IndexerManager } from "../lib/manager";
import { createProgressCallbacks } from "../lib/progress";

export function registerSyncCommand(program: Command): void {
    program
        .command("sync")
        .description("Incremental sync of an index (re-scan for changes)")
        .argument("[name]", "Index name (syncs all if omitted)")
        .action(async (name?: string) => {
            const manager = await IndexerManager.load();

            try {
                const names = name ? [name] : manager.getIndexNames();

                if (names.length === 0) {
                    p.log.info("No indexes configured. Run: tools indexer add <path>");
                    return;
                }

                for (const indexName of names) {
                    p.intro(pc.bgCyan(pc.white(` sync ${indexName} `)));

                    const spinner = p.spinner();
                    spinner.start("Syncing...");

                    const indexer = await manager.getIndex(indexName);
                    const stats = await indexer.sync(createProgressCallbacks(spinner));

                    spinner.stop("Sync complete");

                    const totalChanges = stats.chunksAdded + stats.chunksUpdated + stats.chunksRemoved;

                    if (totalChanges === 0) {
                        p.log.info("Index is up to date — no changes detected");
                    } else {
                        p.log.success(
                            `${pc.green(`+${stats.chunksAdded}`)} added, ` +
                                `${pc.yellow(`~${stats.chunksUpdated}`)} updated, ` +
                                `${pc.red(`-${stats.chunksRemoved}`)} removed ` +
                                `in ${formatDuration(stats.durationMs)}`
                        );
                    }

                    if (stats.embeddingsGenerated > 0) {
                        p.log.info(`Generated ${stats.embeddingsGenerated} new embeddings`);
                    }
                }

                p.outro("Done");
            } finally {
                await manager.close();
            }
        });
}
