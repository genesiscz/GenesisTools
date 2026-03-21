import { IndexerManager } from "@app/indexer/lib/manager";
import { createProgressCallbacks } from "@app/indexer/lib/progress";
import { MailSource } from "@app/indexer/lib/sources/mail-source";
import type { IndexConfig } from "@app/indexer/lib/types";
import { formatBytes, formatDuration } from "@app/utils/format";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

const MAIL_INDEX_NAME = "macos-mail";

interface DateRange {
    fromDate?: Date;
    toDate?: Date;
}

function parseDate(str: string | undefined, label: string): Date | undefined {
    if (!str) {
        return undefined;
    }

    const d = new Date(str);

    if (Number.isNaN(d.getTime())) {
        p.log.error(`Invalid ${label} date: "${str}". Use YYYY-MM-DD format.`);
        process.exit(1);
    }

    return d;
}

export function registerIndexCommand(program: Command): void {
    program
        .command("index")
        .description("Build/update a searchable index of your emails")
        .option("--model <id>", "Embedding model ID (see: tools indexer models --type mail)")
        .option("--limit <n>", "Max emails to index", parseInt)
        .option("--no-embed", "Disable embeddings (fulltext-only)")
        .option("--rebuild-fulltext", "Drop and re-scan all emails (full reindex)")
        .option("--rebuild-embeddings", "Re-embed all chunks (keeps FTS index)")
        .option("--force", "Skip confirmation for destructive operations")
        .option("--from <date>", "Only index emails from this date (YYYY-MM-DD)")
        .option("--to <date>", "Only index emails up to this date (YYYY-MM-DD)")
        .action(
            async (opts: {
                model?: string;
                limit?: number;
                embed?: boolean;
                rebuildFulltext?: boolean;
                rebuildEmbeddings?: boolean;
                force?: boolean;
                from?: string;
                to?: string;
            }) => {
                p.intro(pc.bgCyan(pc.white(" mail index ")));

                const fromDate = parseDate(opts.from, "--from");
                const toDate = parseDate(opts.to, "--to");

                const manager = await IndexerManager.load();

                try {
                    const existingNames = manager.getIndexNames();
                    const exists = existingNames.includes(MAIL_INDEX_NAME);

                    if (exists && opts.rebuildEmbeddings) {
                        await rebuildEmbeddings(manager, opts, { fromDate, toDate });
                    } else if (exists && !opts.rebuildFulltext) {
                        await incrementalSync(manager, { fromDate, toDate });
                    } else {
                        if (exists && opts.rebuildFulltext) {
                            if (!opts.force) {
                                if (!process.stdout.isTTY) {
                                    p.log.error(
                                        "--rebuild-fulltext is destructive. Use in interactive mode or add --force."
                                    );
                                    process.exit(1);
                                }

                                const meta = manager.listIndexes().find((m) => m.name === MAIL_INDEX_NAME);
                                const chunkCount = meta?.stats.totalChunks ?? 0;
                                const embCount = meta?.stats.totalEmbeddings ?? 0;

                                const confirmed = await p.confirm({
                                    message: `This will delete the entire mail index (${chunkCount.toLocaleString()} chunks, ${embCount.toLocaleString()} embeddings) and rebuild from scratch. Continue?`,
                                });

                                if (p.isCancel(confirmed) || !confirmed) {
                                    p.log.info("Cancelled");
                                    p.outro("Aborted");
                                    return;
                                }
                            } else {
                                p.log.info("Rebuilding (--force, skipping confirmation)...");
                            }

                            p.log.info("Rebuilding mail index from scratch...");
                            await manager.removeIndex(MAIL_INDEX_NAME);
                        }

                        await createAndSync(manager, opts);
                    }
                } finally {
                    await manager.close();
                }

                p.outro("Done");
            }
        );
}

async function createAndSync(
    manager: IndexerManager,
    opts: { model?: string; limit?: number; embed?: boolean }
): Promise<void> {
    const mailSource = await MailSource.create();
    const total = await mailSource.estimateTotal();
    mailSource.dispose();

    p.log.info(`Found ${pc.bold(String(total))} emails in Mail.app`);

    const embeddingEnabled = opts.embed !== false;
    let model = opts.model;
    let provider: string | undefined;

    if (embeddingEnabled && !model) {
        // macOS Mail = macOS only → DarwinKit is always available, free, instant, and
        // trained on general text (perfect for email). No download needed.
        model = "darwinkit";
        provider = "darwinkit";
        p.log.info(`Using model: ${pc.bold("DarwinKit NL")} (512-dim, on-device)`);
    }

    if (model && !provider) {
        const { MODEL_REGISTRY } = await import("@app/indexer/lib/model-registry");
        const found = MODEL_REGISTRY.find((m) => m.id === model);
        provider = found?.provider;
    }

    const config: IndexConfig = {
        name: MAIL_INDEX_NAME,
        baseDir: "~",
        type: "mail",
        chunking: "message",
        embedding: {
            enabled: embeddingEnabled,
            provider,
            model,
        },
    };

    const spinner = p.spinner();
    spinner.start("Indexing emails...");

    try {
        const indexer = await manager.addIndex(config, createProgressCallbacks(spinner));

        const stats = indexer.stats;
        spinner.stop("Indexing complete");

        p.log.success(
            `Indexed ${pc.bold(String(stats.totalFiles))} emails, ` +
                `${pc.bold(String(stats.totalChunks))} chunks, ` +
                `${pc.bold(formatBytes(stats.dbSizeBytes))} on disk`
        );

        if (stats.totalEmbeddings > 0) {
            p.log.info(
                `Generated ${pc.bold(String(stats.totalEmbeddings))} embeddings ` + `(${stats.embeddingDimensions}-dim)`
            );
        }
    } catch (err) {
        spinner.stop("Indexing failed");
        p.log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
}

async function rebuildEmbeddings(
    manager: IndexerManager,
    opts: { model?: string; force?: boolean },
    dateRange: DateRange = {}
): Promise<void> {
    const metas = manager.listIndexes();
    const meta = metas.find((m) => m.name === MAIL_INDEX_NAME);

    if (!meta) {
        p.log.error("Mail index not found. Run without --rebuild-embeddings first.");
        process.exit(1);
    }

    const currentModel = meta.indexEmbedding?.model ?? "darwinkit";
    const newModel = opts.model ?? currentModel;

    p.log.info(`Index: ${pc.bold(MAIL_INDEX_NAME)}`);
    p.log.info(`  ${pc.dim("Chunks:")} ${meta.stats.totalChunks.toLocaleString()}`);
    p.log.info(`  ${pc.dim("Current model:")} ${currentModel}`);

    if (opts.model && opts.model !== currentModel) {
        p.log.info(`  ${pc.dim("New model:")} ${pc.bold(newModel)}`);
    }

    if (dateRange.fromDate || dateRange.toDate) {
        const range = [
            dateRange.fromDate ? dateRange.fromDate.toISOString().slice(0, 10) : "beginning",
            dateRange.toDate ? dateRange.toDate.toISOString().slice(0, 10) : "now",
        ];
        p.log.info(`  ${pc.dim("Date range:")} ${range[0]} → ${range[1]}`);
    }

    const embCount = meta.stats.totalEmbeddings;

    if (embCount > 0 && !opts.force) {
        if (!process.stdout.isTTY) {
            p.log.error("--rebuild-embeddings is destructive. Use in interactive mode or add --force.");
            process.exit(1);
        }

        const scopeMsg =
            dateRange.fromDate || dateRange.toDate ? "in the date range" : `(all ${embCount.toLocaleString()})`;

        const confirmed = await p.confirm({
            message: `This will drop embeddings ${scopeMsg} and re-generate them. Continue?`,
        });

        if (p.isCancel(confirmed) || !confirmed) {
            p.log.info("Cancelled");
            p.outro("Aborted");
            return;
        }
    } else if (opts.force && embCount > 0) {
        p.log.info("Rebuilding embeddings (--force, skipping confirmation)...");
    }

    const spinner = p.spinner();
    spinner.start("Dropping old embeddings...");

    try {
        const indexer = await manager.getIndex(MAIL_INDEX_NAME);

        let embedded: number;

        if (dateRange.fromDate || dateRange.toDate) {
            const mailSource = await MailSource.create();
            const entries = await mailSource.scan({ fromDate: dateRange.fromDate, toDate: dateRange.toDate });
            mailSource.dispose();

            const sourceIds = entries.map((e) => e.id);
            p.log.info(`  ${pc.dim("Scoped to:")} ${sourceIds.length.toLocaleString()} emails in date range`);

            embedded = await indexer.reembedBySourceIds(sourceIds, {
                onEmbedProgress: (payload) => {
                    const pct = Math.round((payload.completed / payload.total) * 100);
                    spinner.message(
                        `Embedding... ${payload.completed.toLocaleString()}/${payload.total.toLocaleString()} (${pct}%)`
                    );
                },
            });
        } else {
            embedded = await indexer.reembed({
                onEmbedProgress: (payload) => {
                    const pct = Math.round((payload.completed / payload.total) * 100);
                    spinner.message(
                        `Embedding... ${payload.completed.toLocaleString()}/${payload.total.toLocaleString()} (${pct}%)`
                    );
                },
            });
        }

        spinner.stop("Embeddings rebuilt");
        p.log.success(`Generated ${pc.bold(String(embedded))} embeddings with ${newModel}`);

        await indexer.close();
    } catch (err) {
        spinner.stop("Rebuild failed");
        const msg = err instanceof Error ? err.message : String(err);

        if (msg) {
            p.log.error(msg);
        }

        process.exit(1);
    }
}

async function incrementalSync(manager: IndexerManager, dateRange: DateRange = {}): Promise<void> {
    // Show current index state
    const metas = manager.listIndexes();
    const meta = metas.find((m) => m.name === MAIL_INDEX_NAME);

    if (meta) {
        const model = meta.indexEmbedding
            ? `${meta.indexEmbedding.model} (${meta.indexEmbedding.dimensions}-dim)`
            : "none";

        p.log.info(`Index: ${pc.bold(MAIL_INDEX_NAME)}`);
        p.log.info(
            `  ${pc.dim("Indexed:")} ${meta.stats.totalFiles.toLocaleString()} messages ` +
                `(${meta.stats.totalChunks.toLocaleString()} chunks), ` +
                `${formatBytes(meta.stats.dbSizeBytes)} on disk`
        );
        p.log.info(`  ${pc.dim("Model:")} ${model}`);

        if (meta.lastSyncAt) {
            const ago = formatDuration(Date.now() - meta.lastSyncAt);
            p.log.info(`  ${pc.dim("Last sync:")} ${ago} ago`);
        }
    }

    if (dateRange.fromDate || dateRange.toDate) {
        const range = [
            dateRange.fromDate ? dateRange.fromDate.toISOString().slice(0, 10) : "beginning",
            dateRange.toDate ? dateRange.toDate.toISOString().slice(0, 10) : "now",
        ];
        p.log.info(`  ${pc.dim("Date range:")} ${range[0]} → ${range[1]}`);
    }

    // Get total emails in Mail.app for comparison
    const mailSource = await MailSource.create();
    const totalInMail = await mailSource.estimateTotal({ fromDate: dateRange.fromDate, toDate: dateRange.toDate });
    mailSource.dispose();

    const indexed = meta?.stats.totalFiles ?? 0;
    const diff = totalInMail - indexed;

    if (diff > 0) {
        p.log.info(
            `  ${pc.dim("Mail.app:")} ${totalInMail.toLocaleString()} emails (${pc.green(`+${diff.toLocaleString()}`)} new)`
        );
    } else {
        p.log.info(`  ${pc.dim("Mail.app:")} ${totalInMail.toLocaleString()} emails`);
    }

    const spinner = p.spinner();
    spinner.start("Syncing...");

    try {
        const indexer = await manager.getIndex(MAIL_INDEX_NAME);

        const stats = await indexer.sync({
            scanOptions: { fromDate: dateRange.fromDate, toDate: dateRange.toDate },
            ...createProgressCallbacks(spinner),
        });

        spinner.stop("Sync complete");

        const totalChanges = stats.chunksAdded + stats.chunksUpdated + stats.chunksRemoved;

        if (totalChanges === 0) {
            p.log.info("Index is up to date — no changes detected");
        } else {
            p.log.success(
                `${stats.filesScanned.toLocaleString()} emails scanned, ` +
                    `${pc.green(`+${stats.chunksAdded.toLocaleString()}`)} chunks added, ` +
                    `${pc.yellow(`~${stats.chunksUpdated.toLocaleString()}`)} updated, ` +
                    `${pc.red(`-${stats.chunksRemoved.toLocaleString()}`)} removed ` +
                    `in ${formatDuration(stats.durationMs)}`
            );
        }

        if (stats.embeddingsGenerated > 0) {
            p.log.info(`Generated ${stats.embeddingsGenerated.toLocaleString()} new embeddings`);
        }
    } catch (err) {
        spinner.stop("Sync failed");
        const msg = err instanceof Error ? err.message : String(err);

        if (msg) {
            p.log.error(msg);
        }

        process.exit(1);
    }
}
