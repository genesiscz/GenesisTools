import { basename, resolve } from "node:path";
import { formatDuration } from "@app/utils/format";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { IndexerManager } from "../lib/manager";
import { createProgressCallbacks } from "../lib/progress";

/** Resolve a name-or-path argument to an index name */
function resolveIndexName(arg: string, knownNames: string[]): string | null {
    // Direct name match
    if (knownNames.includes(arg)) {
        return arg;
    }

    // Path match — resolve to absolute, then match by basename or baseDir
    const absPath = resolve(arg);
    const base = basename(absPath);

    if (knownNames.includes(base)) {
        return base;
    }

    return null;
}

export function registerSyncCommand(program: Command): void {
    program
        .command("sync")
        .description("Incremental sync of an index (re-scan for changes)")
        .argument("[name-or-path]", "Index name or path (syncs all if omitted)")
        .action(async (nameOrPath?: string) => {
            const manager = await IndexerManager.load();

            try {
                let names: string[];

                if (nameOrPath) {
                    const resolved = resolveIndexName(nameOrPath, manager.getIndexNames());

                    if (!resolved) {
                        p.log.error(`No index found for "${nameOrPath}". Known indexes: ${manager.getIndexNames().join(", ")}`);
                        process.exit(1);
                    }

                    names = [resolved];
                } else {
                    names = manager.getIndexNames();
                }

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
                            `${stats.filesScanned.toLocaleString()} files scanned, ` +
                                `${pc.green(`+${stats.chunksAdded.toLocaleString()}`)} chunks added, ` +
                                `${pc.yellow(`~${stats.chunksUpdated.toLocaleString()}`)} updated, ` +
                                `${pc.red(`-${stats.chunksRemoved.toLocaleString()}`)} removed ` +
                                `in ${formatDuration(stats.durationMs)}`
                        );
                    }

                    if (stats.embeddingsGenerated > 0) {
                        p.log.info(`Generated ${stats.embeddingsGenerated.toLocaleString()} new embeddings`);
                    }
                }

                p.outro("Done");
            } finally {
                await manager.close();
            }
        });
}
