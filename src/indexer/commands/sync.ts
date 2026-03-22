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

            // Auto-resume interrupted indexes
            const interrupted = manager.interruptedOnLoad;

            if (interrupted.length > 0) {
                const interruptedNames = interrupted.map((i) => i.name).join(", ");
                p.log.warn(`Detected ${interrupted.length} interrupted index(es): ${interruptedNames}. Resuming...`);

                for (const { name } of interrupted) {
                    const spinner = p.spinner();
                    spinner.start(`Resuming ${name}...`);
                    await manager.resumeIndex(name, createProgressCallbacks(spinner));
                    spinner.stop(`Resumed ${name}`);
                }
            }

            try {
                let names: string[];

                if (nameOrPath) {
                    const resolved = resolveIndexName(nameOrPath, manager.getIndexNames());

                    if (!resolved) {
                        p.log.error(
                            `No index found for "${nameOrPath}". Known indexes: ${manager.getIndexNames().join(", ")}`
                        );
                        process.exitCode = 1;
                        return;
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

                // Auto-start watchers for indexes that opt in
                const watchStarted: string[] = [];

                for (const indexName of names) {
                    try {
                        const indexer = await manager.getIndex(indexName);
                        const watchConfig = indexer.getConfig().watch;

                        if (watchConfig?.autoStart) {
                            await indexer.startWatch();
                            watchStarted.push(indexName);
                        }
                    } catch {
                        // Watcher start failure should not block sync completion
                    }
                }

                if (watchStarted.length > 0) {
                    p.log.info(
                        `Auto-started watcher for: ${watchStarted.map((n) => pc.bold(n)).join(", ")}`
                    );
                    p.log.info(pc.dim("Press Ctrl+C to stop watching"));

                    process.on("SIGINT", async () => {
                        await manager.close();
                        process.exit(0);
                    });

                    // Keep process alive while watchers run
                    await new Promise(() => {});
                } else {
                    p.outro("Done");
                }
            } finally {
                await manager.close();
            }
        });
}
