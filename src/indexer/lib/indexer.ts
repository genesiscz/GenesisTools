import { relative, resolve } from "node:path";
import type { Embedder } from "@app/utils/ai/tasks/Embedder";
import type { SearchOptions, SearchResult } from "@app/utils/search/types";
import { chunkFile } from "./chunker";
import type { EventName, IndexerCallbacks, IndexerEventMap, SyncStats } from "./events";
import { IndexerEventEmitter } from "./events";
import type { ModelInfo } from "./model-registry";
import { formatModelTable, getModelsForType } from "./model-registry";
import { FileSource } from "./sources/file-source";
import type { IndexerSource, SourceEntry } from "./sources/source";
import type { IndexStore } from "./store";
import { createIndexStore } from "./store";
import type { ChunkRecord, IndexConfig, IndexStats } from "./types";

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

const MAX_EMBED_CHARS = 500;

export class Indexer extends IndexerEventEmitter {
    private store: IndexStore;
    private config: IndexConfig;
    private source: IndexerSource;
    private embedder: Embedder | null = null;
    private watchTimer: ReturnType<typeof setInterval> | null = null;
    private isSyncing = false;

    private constructor(store: IndexStore, config: IndexConfig, source: IndexerSource) {
        super();
        this.store = store;
        this.config = config;
        this.source = source;
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
        const searchOpts: SearchOptions = {
            query,
            mode: opts?.mode ?? "fulltext",
            limit: opts?.limit ?? 20,
            fields: opts?.fields,
            boost: opts?.boost,
            hybridWeights: opts?.hybridWeights,
            filters: opts?.filters,
        };

        const results = await this.store.search(searchOpts);
        const durationMs = performance.now() - start;
        const mode = searchOpts.mode ?? "fulltext";

        this.store.logSearch({
            query,
            mode,
            resultsCount: results.length,
            durationMs,
        });

        const payload = {
            indexName: this.config.name,
            query,
            mode,
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

    startWatch(callbacks?: IndexerCallbacks): void {
        if (this.watchTimer) {
            return;
        }

        const interval = this.config.watch?.interval ?? 300_000;
        const strategy = this.config.watch?.strategy ?? "merkle";

        this.emit("watch:start", {
            indexName: this.config.name,
            strategy,
        });

        if (callbacks) {
            this.dispatchCallbacks(
                "watch:start",
                {
                    ts: Date.now(),
                    indexName: this.config.name,
                    strategy,
                },
                callbacks
            );
        }

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

    stopWatch(): void {
        if (!this.watchTimer) {
            return;
        }

        clearInterval(this.watchTimer);
        this.watchTimer = null;

        this.emit("watch:stop", { indexName: this.config.name });
    }

    async close(): Promise<void> {
        this.stopWatch();

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
    private chunkEntries(
        entries: SourceEntry[],
        strategy: "ast" | "line" | "heading" | "message" | "json" | "auto",
        maxTokens: number
    ): {
        chunks: ChunkRecord[];
        pathEntries: Array<{ path: string; hash: string }>;
        perEntry: Map<string, { chunkCount: number; parser: string }>;
    } {
        const chunks: ChunkRecord[] = [];
        const pathEntries: Array<{ path: string; hash: string }> = [];
        const perEntry = new Map<string, { chunkCount: number; parser: string }>();

        for (const entry of entries) {
            const result = chunkFile({
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

            // Use source's content hash for consistency with detectChanges()
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

    /**
     * Compute the path_hash storage key for an entry.
     * FileSource uses relative paths; other sources use entry.id directly.
     */
    private pathHashKey(entry: SourceEntry): string {
        if (this.source instanceof FileSource) {
            return relative(resolve(this.config.baseDir), entry.id);
        }

        return entry.id;
    }

    /** Find chunk IDs to remove for deleted source paths */
    private resolveDeletedChunks(deletedPaths: string[]): string[] {
        if (deletedPaths.length === 0) {
            return [];
        }

        if (this.source instanceof FileSource) {
            const lookupPaths = deletedPaths.map((p) => resolve(this.config.baseDir, p));
            return this.store.getChunkIdsBySourcePaths(lookupPaths);
        }

        // Non-file sources (mail, telegram): look up by source entry ID
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
            // Retry once after brief delay
            await new Promise((r) => setTimeout(r, 500));
            await this.embedder.embed("warmup");
        }

        const embedStart = performance.now();
        const dbPageSize = 1000;
        let embedded = 0;

        // Stream pages: query → embed sequentially → store → next page
        while (true) {
            const page = this.store.getUnembeddedChunksPage(dbPageSize);

            if (page.length === 0) {
                break;
            }

            const batchEmbeddings = new Map<string, Float32Array>();
            const zeroDims = this.embedder.dimensions;

            for (const c of page) {
                if (c.content.length < 5) {
                    batchEmbeddings.set(c.id, new Float32Array(zeroDims));
                    continue;
                }

                try {
                    const result = await this.embedder.embed(c.content.slice(0, MAX_EMBED_CHARS));
                    batchEmbeddings.set(c.id, result.vector);
                } catch {
                    batchEmbeddings.set(c.id, new Float32Array(zeroDims));
                }
            }

            // Single DB transaction for all embeddings in this page
            await this.store.insertChunks([], batchEmbeddings);
            embedded += batchEmbeddings.size;

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
        }

        const embedDuration = performance.now() - embedStart;

        this.emitAndDispatch(
            "embed:complete",
            {
                indexName: this.config.name,
                embedded,
                skipped: 0,
                durationMs: embedDuration,
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
        const maxTokens = this.config.chunkMaxTokens ?? 500;
        const pathHashStore = this.store.getPathHashStore();

        this.emitAndDispatch("sync:start", { indexName: this.config.name, mode }, callbacks);

        try {
            // ── Phase 1: SCAN ────────────────────────────────────────
            const sinceId = mode === "incremental" ? this.computeSinceId() : undefined;
            const storedInBatch = new Set<string>();
            let chunksAddedInBatch = 0;
            let batchCount = 0;

            // Snapshot previous hashes BEFORE scan so onBatch upserts don't pollute them.
            // Skip for sinceId scans — we only process new entries, no deletion detection needed.
            const previousHashes = sinceId ? new Map<string, string>() : pathHashStore.getAllFiles();

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
                    const { chunks, pathEntries, perEntry } = this.chunkEntries(batch, strategy, maxTokens);

                    if (chunks.length > 0) {
                        await this.store.insertChunks(chunks);
                    }

                    // Update path_hashes NOW so progress survives Ctrl+C
                    for (const pe of pathEntries) {
                        pathHashStore.upsert(pe.path, pe.hash, true);
                    }

                    for (const entry of batch) {
                        storedInBatch.add(entry.id);
                    }

                    chunksAddedInBatch += chunks.length;
                    batchCount++;

                    // Update metadata every 10 batches for crash-recovery display
                    if (batchCount % 10 === 0) {
                        this.store.updateMeta({
                            lastSyncAt: Date.now(),
                            stats: {
                                totalFiles: pathHashStore.getFileCount(),
                                totalChunks: this.store.getStats().totalChunks,
                                totalEmbeddings: 0,
                                embeddingDimensions: this.embedder?.dimensions ?? 0,
                                dbSizeBytes: 0,
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
                                parser: info.parser as "ast" | "line" | "heading" | "message" | "json",
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

                if (remaining.length > 0) {
                    const { chunks, perEntry } = this.chunkEntries(remaining, strategy, maxTokens);

                    if (chunks.length > 0) {
                        await this.store.insertChunks(chunks);
                        chunksFromRemaining = chunks.length;
                    }

                    for (const [entryId, info] of perEntry) {
                        this.emitAndDispatch(
                            "chunk:file",
                            {
                                indexName: this.config.name,
                                filePath: entryId,
                                chunks: info.chunkCount,
                                parser: info.parser as "ast" | "line" | "heading" | "message" | "json",
                            },
                            callbacks
                        );
                    }
                }

                // Update path_hashes for all processed entries (added + modified)
                for (const entry of [...changes.added, ...changes.modified]) {
                    const hash = this.source.hashEntry(entry);
                    pathHashStore.upsert(this.pathHashKey(entry), hash, true);
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

            try {
                embeddingsGenerated = await this.embedUnembeddedChunks(callbacks);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.emitAndDispatch("sync:error", {
                    indexName: this.config.name,
                    error: `Embedding failed (FTS still works): ${msg}`,
                }, callbacks);
            }

            // ── FINALIZE ─────────────────────────────────────────────
            const durationMs = performance.now() - syncStart;
            const totalFiles = pathHashStore.getFileCount();
            const totalChunksAdded = chunksAddedInBatch + chunksFromRemaining;

            const syncStats: SyncStats = {
                filesScanned: sinceId ? storedInBatch.size : sourceEntries.length,
                chunksAdded: totalChunksAdded,
                chunksUpdated: 0,
                chunksRemoved,
                chunksUnchanged: unchangedCount,
                embeddingsGenerated,
                durationMs,
            };

            const embeddingModelInfo = this.embedder
                ? {
                      model: this.config.embedding?.model ?? "unknown",
                      provider: this.config.embedding?.provider ?? "unknown",
                      dimensions: this.embedder.dimensions,
                      maxEmbedChars: MAX_EMBED_CHARS,
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
