import { formatDuration } from "@app/utils/format";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import type { IndexerCallbacks } from "../lib/events";
import { IndexerManager } from "../lib/manager";

export function registerWatchCommand(program: Command): void {
    program
        .command("watch")
        .description("Watch indexes for changes")
        .argument("[name]", "Index name (omit to watch all)")
        .action(async (name?: string) => {
            const manager = await IndexerManager.load();
            const names = name ? [name] : manager.getIndexNames();

            if (names.length === 0) {
                p.log.info("No indexes configured. Run: tools indexer add <path>");
                return;
            }

            p.intro(pc.bgCyan(pc.white(" indexer watch ")));

            const callbacks: IndexerCallbacks = {
                onSyncStart(payload) {
                    p.log.step(`${pc.dim("sync")} ${pc.bold(payload.indexName)} (${payload.mode})`);
                },
                onSyncComplete(payload) {
                    const { stats } = payload;
                    const parts: string[] = [];

                    if (stats.chunksAdded > 0) {
                        parts.push(`+${stats.chunksAdded}`);
                    }

                    if (stats.chunksUpdated > 0) {
                        parts.push(`~${stats.chunksUpdated}`);
                    }

                    if (stats.chunksRemoved > 0) {
                        parts.push(`-${stats.chunksRemoved}`);
                    }

                    const summary = parts.length > 0 ? parts.join(" ") : "no changes";
                    p.log.success(
                        `${pc.bold(payload.indexName)}: ${summary} ` +
                            `(${stats.filesScanned} files, ${formatDuration(payload.durationMs)})`
                    );
                },
                onSyncError(payload) {
                    p.log.error(`${pc.bold(payload.indexName)}: ${payload.error}`);
                },
            };

            for (const indexName of names) {
                try {
                    const indexer = await manager.getIndex(indexName);

                    // Run an initial sync before starting watch
                    const stats = await indexer.sync(callbacks);
                    p.log.info(
                        `${pc.bold(indexName)}: initial sync done ` +
                            `(${stats.filesScanned} files, ${stats.chunksAdded + stats.chunksUpdated} chunks)`
                    );

                    indexer.startWatch(callbacks);
                    p.log.info(`Watching ${pc.bold(indexName)}`);
                } catch (err) {
                    p.log.error(
                        `Failed to start watch for "${indexName}": ${err instanceof Error ? err.message : String(err)}`
                    );
                }
            }

            p.log.info(pc.dim("Press Ctrl+C to stop watching"));

            process.on("SIGINT", async () => {
                p.log.step("Stopping...");
                await manager.close();
                process.exit(0);
            });

            // Keep process alive
            await new Promise(() => {});
        });
}
