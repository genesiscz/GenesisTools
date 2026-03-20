import { IndexerManager } from "@app/indexer/lib/manager";
import { MailSource } from "@app/indexer/lib/sources/mail-source";
import type { IndexConfig } from "@app/indexer/lib/types";
import { formatBytes, formatDuration } from "@app/utils/format";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

const MAIL_INDEX_NAME = "macos-mail";

export function registerIndexCommand(program: Command): void {
    program
        .command("index")
        .description("Build/update a searchable index of your emails")
        .option("--model <id>", "Embedding model ID (see: tools indexer models --type mail)")
        .option("--limit <n>", "Max emails to index", parseInt)
        .option("--no-embed", "Disable embeddings (fulltext-only)")
        .option("--rebuild", "Force full reindex")
        .action(async (opts: { model?: string; limit?: number; embed?: boolean; rebuild?: boolean }) => {
            p.intro(pc.bgCyan(pc.white(" mail index ")));

            const manager = await IndexerManager.load();

            try {
                const existingNames = manager.getIndexNames();
                const exists = existingNames.includes(MAIL_INDEX_NAME);

                if (exists && !opts.rebuild) {
                    await incrementalSync(manager);
                } else {
                    if (exists && opts.rebuild) {
                        p.log.info("Rebuilding mail index from scratch...");
                        await manager.removeIndex(MAIL_INDEX_NAME);
                    }

                    await createAndSync(manager, opts);
                }
            } finally {
                await manager.close();
            }

            p.outro("Done");
        });
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
        // Use addIndex but listen for progress events via callbacks
        const indexer = await manager.addIndex(config, {
            onScanProgress: (payload) => {
                const pct = payload.total > 0 ? Math.round((payload.scanned / payload.total) * 100) : 0;
                spinner.message(
                    `Scanning... ${payload.scanned.toLocaleString()}/${payload.total.toLocaleString()} (${pct}%)`
                );
            },
            onScanComplete: (payload) => {
                spinner.message(`Stored ${payload.added.toLocaleString()} messages`);
            },
            onChunkFile: (payload) => {
                spinner.message(`Chunking: ${payload.filePath.slice(-60)}`);
            },
            onEmbedProgress: (payload) => {
                const pct = Math.round((payload.completed / payload.total) * 100);
                spinner.message(`Embedding... ${payload.completed}/${payload.total} (${pct}%)`);
            },
        });

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

async function incrementalSync(manager: IndexerManager): Promise<void> {
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

    // Get total emails in Mail.app for comparison
    const mailSource = await MailSource.create();
    const totalInMail = await mailSource.estimateTotal();
    mailSource.dispose();

    const indexed = meta?.stats.totalChunks ?? 0;
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
            onScanProgress: (payload) => {
                const pct = payload.total > 0 ? Math.round((payload.scanned / payload.total) * 100) : 0;
                spinner.message(
                    `Scanning... ${payload.scanned.toLocaleString()}/${payload.total.toLocaleString()} (${pct}%)`
                );
            },
            onScanComplete: (payload) => {
                if (payload.added > 0) {
                    spinner.message(`Scanned: ${payload.added.toLocaleString()} new messages stored`);
                } else {
                    spinner.message("Index is up to date");
                }
            },
            onChunkFile: (payload) => {
                spinner.message(`Chunking: ${payload.filePath.slice(-60)}`);
            },
            onEmbedProgress: (payload) => {
                const pct = Math.round((payload.completed / payload.total) * 100);
                spinner.message(`Embedding... ${payload.completed}/${payload.total} (${pct}%)`);
            },
        });

        spinner.stop("Sync complete");

        const totalChanges = stats.chunksAdded + stats.chunksUpdated + stats.chunksRemoved;

        if (totalChanges === 0) {
            p.log.info("Index is up to date — no changes detected");
        } else {
            p.log.success(
                `Synced: ${pc.green(`+${stats.chunksAdded}`)} added, ` +
                    `${pc.yellow(`~${stats.chunksUpdated}`)} updated, ` +
                    `${pc.red(`-${stats.chunksRemoved}`)} removed ` +
                    `in ${formatDuration(stats.durationMs)}`
            );
        }

        if (stats.embeddingsGenerated > 0) {
            p.log.info(`Generated ${stats.embeddingsGenerated} new embeddings`);
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
