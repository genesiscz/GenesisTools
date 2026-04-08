import { IndexerManager } from "@app/indexer/lib/manager";
import { createProgressCallbacks } from "@app/indexer/lib/progress";
import { MailSource } from "@app/indexer/lib/sources/mail-source";
import type { IndexConfig } from "@app/indexer/lib/types";
import { isInteractive, suggestCommand } from "@app/utils/cli";
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
        .option("--provider <type>", "Embedding provider (ollama, darwinkit, coreml, cloud)")
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
                provider?: string;
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

/** Default model per provider when --model is not given. */
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
    ollama: "nomic-embed-text",
    darwinkit: "darwinkit",
    coreml: "coreml-contextual",
};

/** Provider display labels for the selection menu. */
const PROVIDER_LABELS: Record<string, string> = {
    "ollama:nomic-embed-text": "Ollama \u2014 nomic-embed-text (768-dim, GPU Metal)",
    "ollama:snowflake-arctic-embed": "Ollama \u2014 snowflake-arctic-embed (768-dim, GPU)",
    coreml: "CoreML contextual (512-dim, on-device)",
    darwinkit: "DarwinKit NL (512-dim, on-device, slow)",
    cloud: "Cloud \u2014 OpenAI text-embedding-3-small",
};

interface ProviderSelection {
    provider: string;
    model: string;
}

/** Check if Ollama is running by hitting its API. */
async function isOllamaRunning(): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1000);
        const res = await fetch("http://localhost:11434/api/tags", { signal: controller.signal });
        clearTimeout(timeout);
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Interactive provider selection for embedding.
 * Returns provider + model, or null if cancelled.
 */
async function selectEmbeddingProvider(): Promise<ProviderSelection | null> {
    const ollamaUp = await isOllamaRunning();
    const hasOpenAiKey = !!process.env.OPENAI_API_KEY;
    const isMac = process.platform === "darwin";

    const options: Array<{ value: ProviderSelection; label: string; hint?: string }> = [];

    if (ollamaUp) {
        options.push({
            value: { provider: "ollama", model: "nomic-embed-text" },
            label: PROVIDER_LABELS["ollama:nomic-embed-text"],
            hint: "recommended",
        });
        options.push({
            value: { provider: "ollama", model: "snowflake-arctic-embed" },
            label: PROVIDER_LABELS["ollama:snowflake-arctic-embed"],
        });
    }

    if (isMac) {
        options.push({
            value: { provider: "coreml", model: "coreml-contextual" },
            label: PROVIDER_LABELS.coreml,
        });
        options.push({
            value: { provider: "darwinkit", model: "darwinkit" },
            label: PROVIDER_LABELS.darwinkit,
        });
    }

    if (hasOpenAiKey) {
        options.push({
            value: { provider: "cloud", model: "text-embedding-3-small" },
            label: PROVIDER_LABELS.cloud,
        });
    }

    if (!ollamaUp) {
        p.log.warning(
            `Ollama is not running. For best performance:\n` +
                `  ${pc.dim("$")} ollama serve\n` +
                `  ${pc.dim("$")} ollama pull nomic-embed-text`
        );
    }

    if (options.length === 0) {
        p.log.error("No embedding providers available. Install Ollama or set OPENAI_API_KEY.");
        process.exit(1);
    }

    const choice = await p.select({
        message: "Embedding provider",
        options,
    });

    if (p.isCancel(choice)) {
        return null;
    }

    return choice;
}

/** Log the chosen provider + model in a human-friendly way. */
function logProviderChoice(provider: string, model: string): void {
    const dimMap: Record<string, string> = {
        "nomic-embed-text": "768-dim, GPU",
        "snowflake-arctic-embed": "768-dim, GPU",
        darwinkit: "512-dim, on-device",
        "coreml-contextual": "512-dim, on-device",
        "text-embedding-3-small": "1536-dim, cloud",
    };
    const dim = dimMap[model] ?? "";
    const suffix = dim ? ` (${dim})` : "";
    const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
    p.log.info(`Using model: ${pc.bold(`${providerName} ${model}`)}${suffix}`);
}

async function createAndSync(
    manager: IndexerManager,
    opts: { model?: string; provider?: string; limit?: number; embed?: boolean }
): Promise<void> {
    const mailSource = await MailSource.create();
    const total = await mailSource.estimateTotal();
    mailSource.dispose();

    p.log.info(`Found ${pc.bold(String(total))} emails in Mail.app`);

    const embeddingEnabled = opts.embed !== false;
    let model = opts.model;
    let provider = opts.provider;

    if (embeddingEnabled && !model) {
        if (provider) {
            // --provider given without --model: use default model for that provider
            model = PROVIDER_DEFAULT_MODELS[provider] ?? provider;
            logProviderChoice(provider, model);
        } else if (isInteractive()) {
            const selection = await selectEmbeddingProvider();

            if (!selection) {
                p.log.info("Cancelled");
                p.outro("Aborted");
                return;
            }

            provider = selection.provider;
            model = selection.model;
            logProviderChoice(provider, model);
        } else {
            p.log.error("--provider required in non-interactive mode.");
            p.log.info(suggestCommand("tools macos mail index", { add: ["--provider", "ollama"] }));
            process.exit(1);
        }
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
