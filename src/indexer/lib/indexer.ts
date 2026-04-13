import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import logger from "@app/logger";
import { findModel } from "@app/utils/ai/ModelRegistry";
import type { Embedder } from "@app/utils/ai/tasks/Embedder";
import type { WatcherSubscription } from "@app/utils/fs/watcher";
import { Stopwatch } from "@app/utils/Stopwatch";
import type { SearchOptions, SearchResult } from "@app/utils/search/types";
import type { ChunkResult } from "./chunker";
import { chunkFile } from "./chunker";
import type { EventName, IndexerCallbacks, IndexerEventMap, SyncStats } from "./events";
import { IndexerEventEmitter } from "./events";
import type { ModelInfo } from "./model-registry";
import { formatModelTable, getMaxEmbedChars, getModelsForType, getTaskPrefix } from "./model-registry";
import { FileSource } from "./sources/file-source";
import type { IndexerSource, SourceEntry } from "./sources/source";
import { getIndexerStorage } from "./storage";
import type { IndexStore } from "./store";
import { createIndexStore } from "./store";
import type { ChunkRecord, IndexConfig, IndexStats } from "./types";
import { DEFAULT_WATCH_INTERVAL_MS, EMBEDDING_BATCH_SIZE, PROVIDER_BATCH_SIZES } from "./types";

export interface SyncOptions extends IndexerCallbacks {
    scanOptions?: Pick<import("./sources/source").ScanOptions, "fromDate" | "toDate">;
}

interface RunSyncOptions {
    mode: "incremental" | "full";
    callbacks?: IndexerCallbacks;
    scanOptions?: SyncOptions["scanOptions"];
}

export class EmbeddingSetupError extends Error {
    readonly reason: string;
    readonly requestedProvider?: string;
    readonly recommendedModels?: ModelInfo[];

    constructor(reason: string, requestedProvider?: string, recommendedModels?: ModelInfo[]) {
        const lines = [`Embedding setup failed: ${reason}`, ""];

        if (recommendedModels && recommendedModels.length > 0) {
            lines.push("Recommended models for this index type:");
            lines.push("");
            lines.push(formatModelTable(recommendedModels));
            lines.push("");
            lines.push("Fix with:");
            lines.push(`  tools indexer add <path> --model <model-id>`);
        } else {
            const providers = [
                "darwinkit  — macOS on-device NaturalLanguage.framework (512-dim, free)",
                "local-hf   — HuggingFace all-MiniLM-L6-v2 (384-dim, ~25MB download)",
                "cloud      — OpenAI text-embedding-3-small (1536-dim, requires OPENAI_API_KEY)",
            ];

            lines.push("Available providers:");
            lines.push(...providers.map((p) => `  ${p}`));
            lines.push("");
            lines.push("Fix with one of:");
            lines.push(`  tools indexer add <path> --provider darwinkit`);
            lines.push(`  tools indexer add <path> --provider local-hf`);
            lines.push(`  tools indexer add <path> --provider cloud`);
        }

        lines.push("");
        lines.push("Or disable embeddings (fulltext-only search, no semantic):");
        lines.push(`  tools indexer add <path> --no-embed`);

        super(lines.join("\n"));
        this.name = "EmbeddingSetupError";
        this.reason = reason;
        this.requestedProvider = requestedProvider;
        this.recommendedModels = recommendedModels;
    }
}

export class Indexer extends IndexerEventEmitter {
    private store: IndexStore;
    private config: IndexConfig;
    private source: IndexerSource;
    private embedder: Embedder | null = null;
    private watchTimer: ReturnType<typeof setInterval> | null = null;
    private watchSubscription: WatcherSubscription | null = null;
    private isSyncing = false;
    private cancellationRequested = false;

    private constructor(store: IndexStore, config: IndexConfig, source: IndexerSource) {
        super();
        this.store = store;
        this.config = config;
        this.source = source;
    }

    /**
     * Derive chunk maxTokens from the embedding model's context window.
     * For "message" chunking (mail/chat), use the model's full context so each message = 1 chunk.
     * For code/files, keep the default 500 for fine-grained search.
     */
    private deriveMaxTokens(): number {
        const DEFAULT_MAX_TOKENS = 500;
        const strategy = this.config.chunking ?? "auto";
        const isMessageType = strategy === "message" || this.config.type === "mail" || this.config.type === "chat";

        if (!isMessageType) {
            return this.config.chunkMaxTokens ?? DEFAULT_MAX_TOKENS;
        }

        const modelId = this.config.embedding?.model;

        if (modelId) {
            const model = findModel(modelId);

            if (model?.contextLength) {
                return model.contextLength;
            }
        }

        // Sensible default for message types — most modern embedding models support 8192
        return 8192;
    }

    static async create(config: IndexConfig): Promise<Indexer> {
        let embedder: Embedder | null = null;
        const embeddingEnabled = config.embedding?.enabled !== false;

        if (embeddingEnabled) {
            try {
                const { Embedder: EmbedderClass } = await import("@app/utils/ai/tasks/Embedder");
                embedder = await EmbedderClass.create({
                    provider: config.embedding?.provider,
                    model: config.embedding?.model,
                });
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                const models = getModelsForType(config.type ?? "files");
                throw new EmbeddingSetupError(reason, config.embedding?.provider, models);
            }
        }

        let source: IndexerSource;

        if (config.source) {
            source = config.source;
        } else if (config.type === "mail") {
            const { MailSource } = await import("./sources/mail-source");
            source = await MailSource.create();
        } else {
            source = new FileSource({
                baseDir: config.baseDir,
                respectGitIgnore: config.respectGitIgnore,
                includedSuffixes: config.includedSuffixes,
                ignoredPaths: config.ignoredPaths,
            });
        }

        const store = await createIndexStore(config, embedder ?? undefined);
        const indexer = new Indexer(store, config, source);
        indexer.embedder = embedder;

        return indexer;
    }

    get name(): string {
        return this.config.name;
    }

    get stats(): IndexStats {
        return this.store.getStats();
    }

    getStore(): IndexStore {
        return this.store;
    }

    getConfig(): IndexConfig {
        return this.config;
    }

    getConsistencyInfo(): {
        pathHashCount: number;
        contentCount: number;
        embeddingCount: number;
        unembeddedCount: number;
        dbSizeBytes: number;
        integrityCheck: string;
    } {
        return {
            pathHashCount: this.store.getPathHashStore().getFileCount(),
            contentCount: this.store.getContentCount(),
            embeddingCount: this.store.getEmbeddingCount(),
            unembeddedCount: this.store.getUnembeddedCount(),
            dbSizeBytes: this.store.getStats().dbSizeBytes,
            integrityCheck: this.store.checkIntegrity(),
        };
    }

    /** Request cancellation of the current sync operation. Non-blocking. */
    requestCancellation(): void {
        this.cancellationRequested = true;
    }

    /** Check if cancellation has been requested. */
    get isCancelled(): boolean {
        return this.cancellationRequested;
    }

    async reindex(callbacks?: IndexerCallbacks): Promise<SyncStats> {
        return this.runSync({ mode: "full", callbacks });
    }

    async sync(opts?: SyncOptions): Promise<SyncStats> {
        return this.runSync({ mode: "incremental", callbacks: opts, scanOptions: opts?.scanOptions });
    }

    /** Drop all embeddings and re-embed. Keeps FTS content intact. */
    async reembed(callbacks?: IndexerCallbacks): Promise<number> {
        this.store.clearEmbeddings();
        return this.embedUnembeddedChunks(callbacks);
    }

    /** Drop embeddings for specific source IDs and re-embed their chunks. */
    async reembedBySourceIds(sourceIds: string[], callbacks?: IndexerCallbacks): Promise<number> {
        this.store.clearEmbeddingsBySourceIds(sourceIds);
        return this.embedUnembeddedChunks(callbacks);
    }

    async search(
        query: string,
        opts?: Partial<SearchOptions> & { callbacks?: IndexerCallbacks }
    ): Promise<SearchResult<ChunkRecord>[]> {
        const meta = this.store.getMeta();
        const wantsVector = opts?.mode === "vector" || opts?.mode === "hybrid";

        if (wantsVector && meta.indexEmbedding && this.embedder) {
            if (meta.indexEmbedding.dimensions !== this.embedder.dimensions) {
                throw new Error(
                    `Index "${this.name}" was built with ${meta.indexEmbedding.model} (${meta.indexEmbedding.dimensions}-dim).\n` +
                        `Current model has ${this.embedder.dimensions} dimensions — incompatible.\n` +
                        `Run: tools indexer rebuild ${this.name} --model ${meta.indexEmbedding.model}`
                );
            }
        }

        const start = performance.now();
        const searchMode = opts?.mode ?? "fulltext";
        const modelId = this.config.embedding?.model ?? "darwinkit";
        const taskPrefix = getTaskPrefix(modelId);

        const searchOpts: SearchOptions = {
            query,
            mode: searchMode,
            limit: opts?.limit ?? 20,
            fields: opts?.fields,
            boost: opts?.boost,
            hybridWeights: opts?.hybridWeights,
            filters: opts?.filters,
        };

        // Apply query prefix for vector/hybrid search on asymmetric models
        if (taskPrefix && (searchMode === "vector" || searchMode === "hybrid")) {
            searchOpts.vectorQuery = `${taskPrefix.query}${query}`;
        }

        const results = await this.store.search(searchOpts);
        const durationMs = performance.now() - start;

        this.store.logSearch({
            query,
            mode: searchMode,
            resultsCount: results.length,
            durationMs,
        });

        const payload = {
            indexName: this.config.name,
            query,
            mode: searchMode,
            results: results.map((r) => ({
                doc: r.doc as unknown as Record<string, unknown>,
                score: r.score,
                method: r.method,
            })),
            resultsCount: results.length,
            durationMs,
            cached: false,
        };

        this.emit("search:query", payload);

        if (opts?.callbacks) {
            this.dispatchCallbacks("search:query", { ...payload, ts: Date.now() }, opts.callbacks);
        }

        return results;
    }

    async startWatch(callbacks?: IndexerCallbacks): Promise<void> {
        if (this.watchSubscription?.active || this.watchTimer) {
            return;
        }

        const debounceMs = this.config.watch?.debounceMs ?? 2000;
        const strategy = this.config.watch?.strategy ?? "native";

        this.emitAndDispatch("watch:start", { indexName: this.config.name, strategy }, callbacks);

        if (strategy === "polling") {
            this.startPollingWatch(callbacks);
            return;
        }

        // Native watcher for file-based indexes
        const { createWatcher } = await import("@app/utils/fs/watcher");

        this.watchSubscription = await createWatcher(
            this.config.baseDir,
            async (events) => {
                if (this.isSyncing) {
                    return;
                }

                this.isSyncing = true;

                try {
                    for (const event of events) {
                        this.emitAndDispatch(
                            "watch:change",
                            {
                                indexName: this.config.name,
                                filePath: event.path,
                                event: event.type === "create" ? "add" : event.type === "update" ? "modify" : "delete",
                            },
                            callbacks
                        );
                    }

                    await this.sync(callbacks);
                } catch {
                    // Watch sync errors are non-fatal
                } finally {
                    this.isSyncing = false;
                }
            },
            {
                debounceMs,
                maxErrors: 10,
                ignorePatterns: this.config.ignoredPaths,
                filter: (event) => {
                    if (this.config.includedSuffixes?.length) {
                        const ext = event.path.split(".").pop()?.toLowerCase();
                        return this.config.includedSuffixes.some((s) => s.replace(/^\./, "") === ext);
                    }

                    return true;
                },
                onTransientError: (err, backoffMs) => {
                    this.emitAndDispatch(
                        "sync:error",
                        {
                            indexName: this.config.name,
                            error: `Transient error, retrying in ${Math.round(backoffMs / 1000)}s: ${err.message}`,
                        },
                        callbacks
                    );
                },
            }
        );
    }

    private startPollingWatch(callbacks?: IndexerCallbacks): void {
        const interval = this.config.watch?.interval ?? DEFAULT_WATCH_INTERVAL_MS;

        this.watchTimer = setInterval(async () => {
            if (this.isSyncing) {
                return;
            }

            this.isSyncing = true;

            try {
                await this.sync(callbacks);
            } catch {
                // Watch sync errors are non-fatal
            } finally {
                this.isSyncing = false;
            }
        }, interval);
    }

    async stopWatch(): Promise<void> {
        if (this.watchSubscription) {
            await this.watchSubscription.unsubscribe();
            this.watchSubscription = null;
        }

        if (this.watchTimer) {
            clearInterval(this.watchTimer);
            this.watchTimer = null;
        }

        this.emit("watch:stop", { indexName: this.config.name });
    }

    async close(): Promise<void> {
        await this.stopWatch();

        if (this.embedder) {
            this.embedder.dispose();
            this.embedder = null;
        }

        this.source.dispose?.();
        await this.store.close();
    }

    // ─── Private helpers ────────────────────────────────────────────

    /** Emit event and dispatch inline callback in one call */
    private emitAndDispatch<K extends EventName>(
        event: K,
        payload: Omit<IndexerEventMap[K], "ts">,
        callbacks?: IndexerCallbacks
    ): void {
        this.emit(event, payload);

        if (callbacks) {
            this.dispatchCallbacks(event, { ...payload, ts: Date.now() } as IndexerEventMap[K], callbacks);
        }
    }

    /** Find highest stored numeric ID for sinceId (mail ROWIDs) */
    private computeSinceId(): string | undefined {
        const maxId = this.store.getPathHashStore().getMaxNumericPath();
        return maxId > 0 ? String(maxId) : undefined;
    }

    /** Chunk a batch of SourceEntry[] into ChunkRecords + path hash data */
    private async chunkEntries(
        entries: SourceEntry[],
        strategy: "ast" | "line" | "heading" | "message" | "json" | "character" | "auto",
        maxTokens: number
    ): Promise<{
        chunks: ChunkRecord[];
        pathEntries: Array<{ path: string; hash: string }>;
        perEntry: Map<string, { chunkCount: number; parser: string }>;
    }> {
        const chunks: ChunkRecord[] = [];
        const pathEntries: Array<{ path: string; hash: string }> = [];
        const perEntry = new Map<string, { chunkCount: number; parser: string }>();

        for (const entry of entries) {
            const result = await chunkFile({
                filePath: entry.path,
                content: entry.content,
                strategy,
                maxTokens,
                indexType: this.config.type,
            });

            for (const chunk of result.chunks) {
                chunk.sourceId = entry.id;

                if (entry.metadata) {
                    chunk.metadata = entry.metadata;
                }
            }

            chunks.push(...result.chunks);

            pathEntries.push({
                path: entry.id,
                hash: this.source.hashEntry(entry),
            });

            perEntry.set(entry.id, {
                chunkCount: result.chunks.length,
                parser: result.parser,
            });
        }

        return { chunks, pathEntries, perEntry };
    }

    /** Find chunk IDs to remove for deleted source paths */
    private resolveDeletedChunks(deletedPaths: string[]): string[] {
        if (deletedPaths.length === 0) {
            return [];
        }

        if (this.source instanceof FileSource) {
            return this.store.getChunkIdsBySourcePaths(deletedPaths);
        }

        return this.store.getChunkIdsBySourceIds(deletedPaths);
    }

    /** Embed all unembedded chunks in streaming pages, return count */
    private async embedUnembeddedChunks(callbacks?: IndexerCallbacks): Promise<number> {
        if (!this.embedder) {
            return 0;
        }

        const totalToEmbed = this.store.getUnembeddedCount();

        if (totalToEmbed === 0) {
            return 0;
        }

        this.emitAndDispatch(
            "embed:start",
            {
                indexName: this.config.name,
                totalChunks: totalToEmbed,
                provider: this.config.embedding?.provider ?? "default",
                dimensions: this.embedder.dimensions,
            },
            callbacks
        );

        // Warm up the embedding model — first call can fail transiently
        try {
            await this.embedder.embed("warmup");
        } catch {
            await new Promise((r) => setTimeout(r, 500));
            await this.embedder.embed("warmup");
        }

        const modelId = this.config.embedding?.model ?? "darwinkit";
        const maxEmbedChars = getMaxEmbedChars(modelId);
        const taskPrefix = getTaskPrefix(modelId);
        const providerType = this.config.embedding?.provider;
        const embedBatchSize = PROVIDER_BATCH_SIZES[providerType ?? ""] ?? EMBEDDING_BATCH_SIZE;
        // Match DB page to batch size so each page = ~1 HTTP call
        const dbPageSize = Math.max(1000, embedBatchSize);
        let embedded = 0;
        let pageCount = 0;
        const zeroDims = this.embedder.dimensions;

        // Stop signal file for cross-process cancellation
        const stopFile = join(getIndexerStorage().getIndexDir(this.config.name), "stop.signal");

        const embedSw = new Stopwatch();
        logger.debug(
            `[embed] starting: provider=${providerType}, model=${modelId}, batchSize=${embedBatchSize}, pageSize=${dbPageSize}, maxChars=${maxEmbedChars}`
        );

        // Stream pages: query -> batch embed -> store -> next page
        while (true) {
            const pageSw = new Stopwatch();
            const page = this.store.getUnembeddedChunksPage(dbPageSize);
            const dbReadLap = pageSw.lap();

            if (page.length === 0) {
                break;
            }

            logger.debug(`[embed] page ${pageCount + 1}: fetched ${page.length} chunks in ${dbReadLap}`);

            const batchEmbeddings = new Map<string, Float32Array>();
            let pageEmbedMs = 0;

            // Process page in embedding batches
            for (let i = 0; i < page.length; i += embedBatchSize) {
                const batch = page.slice(i, i + embedBatchSize);
                const textsToEmbed: string[] = [];
                const idsToEmbed: string[] = [];
                let skippedShort = 0;

                for (const c of batch) {
                    if (c.content.length < 5) {
                        batchEmbeddings.set(c.id, new Float32Array(zeroDims));
                        skippedShort++;
                        continue;
                    }

                    let text = c.content.slice(0, maxEmbedChars);

                    if (taskPrefix) {
                        text = `${taskPrefix.document}${text}`;
                    }

                    textsToEmbed.push(text);
                    idsToEmbed.push(c.id);
                }

                if (textsToEmbed.length > 0) {
                    const avgChars = Math.round(textsToEmbed.reduce((s, t) => s + t.length, 0) / textsToEmbed.length);
                    const batchSw = new Stopwatch();

                    try {
                        const results = await this.embedder.embedBatch(textsToEmbed);
                        const batchMs = batchSw.elapsedMs;
                        pageEmbedMs += batchMs;

                        const rate = (textsToEmbed.length / batchMs) * 1000;
                        logger.debug(
                            `[embed] batch ${Math.floor(i / embedBatchSize) + 1}: ${textsToEmbed.length} texts (avg ${avgChars} chars${skippedShort > 0 ? `, ${skippedShort} skipped` : ""}) → ${batchSw.elapsed()} (${rate.toFixed(0)} emb/s)`
                        );

                        for (let j = 0; j < results.length; j++) {
                            batchEmbeddings.set(idsToEmbed[j], results[j].vector);
                        }
                    } catch (batchErr) {
                        const batchMsg = batchErr instanceof Error ? batchErr.message : String(batchErr);
                        this.emitAndDispatch(
                            "sync:error",
                            {
                                indexName: this.config.name,
                                error: `Batch embed failed (falling back to individual): ${batchMsg}`,
                            },
                            callbacks
                        );

                        for (let j = 0; j < textsToEmbed.length; j++) {
                            try {
                                const result = await this.embedder.embed(textsToEmbed[j]);
                                batchEmbeddings.set(idsToEmbed[j], result.vector);
                            } catch (itemErr) {
                                const itemMsg = itemErr instanceof Error ? itemErr.message : String(itemErr);
                                this.emitAndDispatch(
                                    "sync:error",
                                    {
                                        indexName: this.config.name,
                                        error: `Failed to embed chunk ${idsToEmbed[j]}: ${itemMsg}`,
                                    },
                                    callbacks
                                );
                                batchEmbeddings.set(idsToEmbed[j], new Float32Array(zeroDims));
                            }
                        }
                    }
                }
            }

            // Single DB transaction for all embeddings in this page
            await this.store.insertChunks([], batchEmbeddings);
            const dbWriteLap = pageSw.lap();
            embedded += batchEmbeddings.size;
            pageCount++;

            const pageTotalMs = pageSw.elapsedMs;
            logger.debug(
                `[embed] page ${pageCount} done: ${batchEmbeddings.size} embeddings, ` +
                    `embed=${pageEmbedMs.toFixed(0)}ms, dbRead=${dbReadLap}, dbWrite=${dbWriteLap}, ` +
                    `total=${pageSw.elapsed()} (embed ${((pageEmbedMs / pageTotalMs) * 100).toFixed(0)}%)`
            );

            this.emitAndDispatch(
                "embed:progress",
                {
                    indexName: this.config.name,
                    completed: embedded,
                    total: totalToEmbed,
                    currentFile: page[page.length - 1].id,
                },
                callbacks
            );

            // Check for cross-process stop signal (every 5 pages to avoid stat overhead)
            if (pageCount % 5 === 0 && existsSync(stopFile)) {
                this.cancellationRequested = true;
                rmSync(stopFile);
            }

            // Cancellation checkpoint: progress is already persisted in DB
            if (this.cancellationRequested) {
                this.emitAndDispatch(
                    "sync:cancelled",
                    {
                        indexName: this.config.name,
                        reason: "user-requested",
                        embedded,
                        totalToEmbed,
                    },
                    callbacks
                );
                break;
            }
        }

        const embedDurationMs = embedSw.elapsedMs;
        const overallRate = embedded > 0 ? (embedded / embedDurationMs) * 1000 : 0;
        logger.debug(
            `[embed] complete: ${embedded} embeddings in ${embedSw.elapsed()} ` +
                `(${overallRate.toFixed(0)} emb/s overall, ${pageCount} pages)`
        );

        this.emitAndDispatch(
            "embed:complete",
            {
                indexName: this.config.name,
                embedded,
                skipped: 0,
                durationMs: embedDurationMs,
            },
            callbacks
        );

        return embedded;
    }

    // ─── Main sync pipeline ──────────────────────────────────────────

    private async runSync(opts: RunSyncOptions): Promise<SyncStats> {
        const { mode, callbacks } = opts;
        const syncStart = performance.now();
        const strategy = this.config.chunking ?? "auto";
        const maxTokens = this.deriveMaxTokens();
        const pathHashStore = this.store.getPathHashStore();

        // Reset cancellation flag at start of each sync
        this.cancellationRequested = false;

        this.emitAndDispatch("sync:start", { indexName: this.config.name, mode }, callbacks);
        this.store.updateMeta({ indexingStatus: "in-progress" });

        try {
            // ── Phase 1: SCAN ────────────────────────────────────────
            const sinceId = mode === "incremental" ? this.computeSinceId() : undefined;
            const storedInBatch = new Set<string>();
            let chunksAddedInBatch = 0;
            let batchCount = 0;

            // Snapshot previous hashes BEFORE scan so onBatch upserts don't pollute them.
            // Skip for sinceId scans — we only process new entries, no deletion detection needed.
            const previousHashes = sinceId ? new Map<string, string>() : pathHashStore.getAllFiles();

            const sw = new Stopwatch();
            logger.debug(
                `[scan] starting: mode=${mode}, sinceId=${sinceId ?? "none"}, strategy=${strategy}, maxTokens=${maxTokens}`
            );

            this.emitAndDispatch(
                "scan:start",
                {
                    indexName: this.config.name,
                    strategy: this.config.watch?.strategy ?? "merkle",
                },
                callbacks
            );

            const sourceEntries = await this.source.scan({
                sinceId,
                batchSize: 500,
                fromDate: opts.scanOptions?.fromDate,
                toDate: opts.scanOptions?.toDate,
                onBatch: async (batch) => {
                    const batchSw = new Stopwatch();
                    const { chunks, pathEntries, perEntry } = await this.chunkEntries(batch, strategy, maxTokens);
                    const chunkLap = batchSw.lap();

                    if (chunks.length > 0) {
                        await this.store.insertChunks(chunks);
                    }

                    // Update path_hashes NOW so progress survives Ctrl+C
                    for (const pe of pathEntries) {
                        pathHashStore.upsert(pe.path, pe.hash, true);
                    }

                    const dbLap = batchSw.lap();

                    for (const entry of batch) {
                        storedInBatch.add(entry.id);
                    }

                    chunksAddedInBatch += chunks.length;
                    batchCount++;

                    logger.debug(
                        `[scan] batch ${batchCount}: ${batch.length} entries → ${chunks.length} chunks, ` +
                            `chunk=${chunkLap}, dbWrite=${dbLap}, total=${storedInBatch.size} stored ${sw}`
                    );

                    // Update metadata every 10 batches for crash-recovery display
                    if (batchCount % 10 === 0) {
                        const liveStats = this.store.getStats();

                        this.store.updateMeta({
                            lastSyncAt: Date.now(),
                            stats: {
                                totalFiles: pathHashStore.getFileCount(),
                                totalChunks: liveStats.totalChunks,
                                totalEmbeddings: liveStats.totalEmbeddings,
                                embeddingDimensions: this.embedder?.dimensions ?? 0,
                                dbSizeBytes: liveStats.dbSizeBytes,
                                lastSyncDurationMs: 0,
                                searchCount: 0,
                                avgSearchDurationMs: 0,
                            },
                            indexEmbedding: this.embedder
                                ? {
                                      model: this.config.embedding?.model ?? "darwinkit",
                                      provider: this.config.embedding?.provider ?? "darwinkit",
                                      dimensions: this.embedder.dimensions,
                                  }
                                : undefined,
                        });
                    }

                    for (const [entryId, info] of perEntry) {
                        this.emitAndDispatch(
                            "chunk:file",
                            {
                                indexName: this.config.name,
                                filePath: entryId,
                                chunks: info.chunkCount,
                                parser: info.parser as ChunkResult["parser"],
                            },
                            callbacks
                        );
                    }
                },
                onProgress: (current, total) => {
                    this.emitAndDispatch(
                        "scan:progress",
                        {
                            indexName: this.config.name,
                            scanned: current,
                            total,
                        },
                        callbacks
                    );
                },
            });

            logger.debug(
                `[scan] complete: ${sourceEntries.length} entries, ${chunksAddedInBatch} chunks in ${batchCount} batches, ${sw.elapsed()}`
            );

            // ── Phase 2: DETECT CHANGES + STORE REMAINING ────────────
            let chunksFromRemaining = 0;
            let chunksRemoved = 0;
            let unchangedCount = 0;

            if (sinceId) {
                // sinceId scan: all entries already stored via onBatch.
                // No deletion detection (mail is append-only by ROWID).
                this.emitAndDispatch(
                    "scan:complete",
                    {
                        indexName: this.config.name,
                        added: storedInBatch.size,
                        modified: 0,
                        deleted: 0,
                        unchanged: 0,
                    },
                    callbacks
                );
            } else {
                const changes = this.source.detectChanges({
                    previousHashes: previousHashes.size > 0 ? previousHashes : null,
                    currentEntries: sourceEntries,
                    full: mode === "full",
                });

                const totalAdded = changes.added.filter((e) => !storedInBatch.has(e.id)).length + storedInBatch.size;

                this.emitAndDispatch(
                    "scan:complete",
                    {
                        indexName: this.config.name,
                        added: totalAdded,
                        modified: changes.modified.length,
                        deleted: changes.deleted.length,
                        unchanged: changes.unchanged.length,
                    },
                    callbacks
                );

                unchangedCount = changes.unchanged.length;

                // Process entries NOT already stored via onBatch
                const remaining = [...changes.added, ...changes.modified].filter(
                    (entry) => !storedInBatch.has(entry.id)
                );

                // Collect hashes from remaining entries to avoid double hashing
                const remainingHashMap = new Map<string, string>();

                if (remaining.length > 0) {
                    const {
                        chunks,
                        pathEntries: remainingPathEntries,
                        perEntry,
                    } = await this.chunkEntries(remaining, strategy, maxTokens);

                    if (chunks.length > 0) {
                        await this.store.insertChunks(chunks);
                        chunksFromRemaining = chunks.length;
                    }

                    for (const pe of remainingPathEntries) {
                        remainingHashMap.set(pe.path, pe.hash);
                    }

                    for (const [entryId, info] of perEntry) {
                        this.emitAndDispatch(
                            "chunk:file",
                            {
                                indexName: this.config.name,
                                filePath: entryId,
                                chunks: info.chunkCount,
                                parser: info.parser as ChunkResult["parser"],
                            },
                            callbacks
                        );
                    }
                }

                // Update path_hashes for all processed entries (added + modified)
                // Reuse hashes computed during chunkEntries to avoid double hashing
                for (const entry of [...changes.added, ...changes.modified]) {
                    const hash = remainingHashMap.get(entry.id) ?? this.source.hashEntry(entry);
                    pathHashStore.upsert(entry.id, hash, true);
                }

                // Handle deletions
                if (changes.deleted.length > 0) {
                    const deletedChunkIds = this.resolveDeletedChunks(changes.deleted);

                    if (deletedChunkIds.length > 0) {
                        await this.store.removeChunks(deletedChunkIds);
                        chunksRemoved = deletedChunkIds.length;
                    }

                    for (const deletedPath of changes.deleted) {
                        pathHashStore.remove(deletedPath);
                    }
                }
            }

            // ── Phase 3: EMBED ───────────────────────────────────────
            let embeddingsGenerated = 0;

            if (!this.cancellationRequested) {
                try {
                    embeddingsGenerated = await this.embedUnembeddedChunks(callbacks);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.emitAndDispatch(
                        "sync:error",
                        {
                            indexName: this.config.name,
                            error: `Embedding failed (FTS still works): ${msg}`,
                        },
                        callbacks
                    );
                }
            }

            // ── FINALIZE ─────────────────────────────────────────────
            const durationMs = performance.now() - syncStart;
            const totalFiles = pathHashStore.getFileCount();
            const totalChunksAdded = chunksAddedInBatch + chunksFromRemaining;

            const wasCancelled = this.cancellationRequested;

            const syncStats: SyncStats = {
                filesScanned: sinceId ? storedInBatch.size : sourceEntries.length,
                chunksAdded: totalChunksAdded,
                chunksUpdated: 0,
                chunksRemoved,
                chunksUnchanged: unchangedCount,
                embeddingsGenerated,
                durationMs,
                cancelled: wasCancelled || undefined,
            };

            const embeddingModelId = this.config.embedding?.model ?? "darwinkit";
            const embeddingModelInfo = this.embedder
                ? {
                      model: this.config.embedding?.model ?? "unknown",
                      provider: this.config.embedding?.provider ?? "unknown",
                      dimensions: this.embedder.dimensions,
                      maxEmbedChars: getMaxEmbedChars(embeddingModelId),
                  }
                : undefined;

            const finalStats = this.store.getStats();
            const embeddedCount = finalStats.totalChunks - this.store.getUnembeddedCount();

            this.store.updateMeta({
                lastSyncAt: Date.now(),
                stats: {
                    totalFiles,
                    totalChunks: finalStats.totalChunks,
                    totalEmbeddings: embeddedCount,
                    embeddingDimensions: this.embedder?.dimensions ?? 0,
                    dbSizeBytes: finalStats.dbSizeBytes,
                    lastSyncDurationMs: durationMs,
                    searchCount: finalStats.searchCount,
                    avgSearchDurationMs: finalStats.avgSearchDurationMs,
                },
                indexEmbedding: embeddingModelInfo,
                indexingStatus: wasCancelled ? "cancelled" : "completed",
            });

            this.emitAndDispatch(
                "sync:complete",
                {
                    indexName: this.config.name,
                    durationMs,
                    stats: syncStats,
                },
                callbacks
            );

            return syncStats;
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);

            this.store.updateMeta({ indexingStatus: "error" });

            this.emitAndDispatch(
                "sync:error",
                {
                    indexName: this.config.name,
                    error: errorMsg,
                },
                callbacks
            );

            throw err;
        }
    }
}
