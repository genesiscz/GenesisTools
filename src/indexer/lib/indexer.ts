import { relative, resolve } from "node:path";
import type { Embedder } from "@app/utils/ai/tasks/Embedder";
import type { SearchOptions, SearchResult } from "@app/utils/search/types";
import { detectChanges } from "./change-detector";
import type { ChunkResult } from "./chunker";
import { chunkFile } from "./chunker";
import type { IndexerCallbacks, SyncStats } from "./events";
import { IndexerEventEmitter } from "./events";
import { buildMerkleTree } from "./merkle";
import type { ModelInfo } from "./model-registry";
import { formatModelTable, getModelsForType } from "./model-registry";
import { FileSource } from "./sources/file-source";
import type { IndexerSource } from "./sources/source";
import type { IndexStore } from "./store";
import { createIndexStore } from "./store";
import type { ChunkRecord, IndexConfig, IndexStats, MerkleNode } from "./types";

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

    async reindex(callbacks?: IndexerCallbacks): Promise<SyncStats> {
        return this.runSync({ mode: "full", callbacks });
    }

    async sync(callbacks?: IndexerCallbacks): Promise<SyncStats> {
        return this.runSync({ mode: "incremental", callbacks });
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

        this.watchTimer = setInterval(() => {
            this.sync(callbacks).catch(() => {
                // Watch sync errors are non-fatal
            });
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

        await this.store.close();
    }

    private async runSync(opts: { mode: "incremental" | "full"; callbacks?: IndexerCallbacks }): Promise<SyncStats> {
        const { mode, callbacks } = opts;
        const syncStart = performance.now();

        this.emit("sync:start", { indexName: this.config.name, mode });

        if (callbacks) {
            this.dispatchCallbacks(
                "sync:start",
                {
                    ts: Date.now(),
                    indexName: this.config.name,
                    mode,
                },
                callbacks
            );
        }

        try {
            const sourceEntries = await this.source.scan({
                onProgress: (current, total) => {
                    this.emit("scan:progress", {
                        indexName: this.config.name,
                        scanned: current,
                        total,
                    });

                    if (callbacks) {
                        this.dispatchCallbacks(
                            "scan:progress",
                            { ts: Date.now(), indexName: this.config.name, scanned: current, total },
                            callbacks
                        );
                    }
                },
            });
            const entryMetadata = new Map<string, Record<string, unknown>>();

            for (const entry of sourceEntries) {
                if (entry.metadata) {
                    entryMetadata.set(entry.id, entry.metadata);
                }
            }

            const strategy = this.config.chunking ?? "auto";
            const maxTokens = this.config.chunkMaxTokens ?? 500;
            const fileChunkResults = new Map<string, ChunkResult>();
            const chunkHashesPerFile = new Map<string, string[]>();

            for (const entry of sourceEntries) {
                const result = chunkFile({
                    filePath: entry.path,
                    content: entry.content,
                    strategy,
                    maxTokens,
                    indexType: this.config.type,
                });

                // Attach source metadata to each chunk
                const meta = entryMetadata.get(entry.id);

                if (meta) {
                    for (const chunk of result.chunks) {
                        chunk.metadata = meta;
                    }
                }

                fileChunkResults.set(entry.path, result);
                chunkHashesPerFile.set(
                    entry.path,
                    result.chunks.map((c) => c.id)
                );
            }

            const watchStrategy = this.config.watch?.strategy ?? "merkle";
            let previousMerkle: MerkleNode | null = null;

            if (mode !== "full") {
                // Build previous Merkle tree from stored per-file chunk hashes
                const prevHashes = this.store.getPathHashStore().getAllFiles();

                if (prevHashes.size > 0) {
                    // path_hashes stores: relPath -> sorted chunk IDs joined with \0
                    // Reconstruct the Merkle tree using the same format as the current build
                    previousMerkle = buildMerkleTree({
                        baseDir: this.config.baseDir,
                        files: Array.from(prevHashes.entries()).map(([relPath, chunkHashStr]) => ({
                            path: resolve(this.config.baseDir, relPath),
                            chunkHashes: chunkHashStr.split("\0"),
                        })),
                    });
                } else {
                    // Fall back to legacy merkle_tree blob for migration
                    previousMerkle = await this.store.loadMerkle();
                }
            }

            this.emit("scan:start", {
                indexName: this.config.name,
                strategy: watchStrategy,
            });

            if (callbacks) {
                this.dispatchCallbacks(
                    "scan:start",
                    {
                        ts: Date.now(),
                        indexName: this.config.name,
                        strategy: watchStrategy,
                    },
                    callbacks
                );
            }

            const changes = await detectChanges({
                baseDir: this.config.baseDir,
                strategy: watchStrategy,
                previousMerkle,
                currentChunks: chunkHashesPerFile,
                respectGitIgnore: this.config.respectGitIgnore,
            });

            this.emit("scan:complete", {
                indexName: this.config.name,
                added: changes.added.length,
                modified: changes.modified.length,
                deleted: changes.deleted.length,
                unchanged: changes.unchanged.length,
            });

            if (callbacks) {
                this.dispatchCallbacks(
                    "scan:complete",
                    {
                        ts: Date.now(),
                        indexName: this.config.name,
                        added: changes.added.length,
                        modified: changes.modified.length,
                        deleted: changes.deleted.length,
                        unchanged: changes.unchanged.length,
                    },
                    callbacks
                );
            }

            const changedFiles = new Set([...changes.added, ...changes.modified]);
            const newChunks: ChunkRecord[] = [];

            for (const [filePath, result] of fileChunkResults) {
                const rel = relative(resolve(this.config.baseDir), filePath);
                const isChanged = changedFiles.has(rel) || changedFiles.has(filePath);

                if (isChanged) {
                    this.emit("chunk:file", {
                        indexName: this.config.name,
                        filePath,
                        chunks: result.chunks.length,
                        parser: result.parser,
                    });

                    if (callbacks) {
                        this.dispatchCallbacks(
                            "chunk:file",
                            {
                                ts: Date.now(),
                                indexName: this.config.name,
                                filePath,
                                chunks: result.chunks.length,
                                parser: result.parser,
                            },
                            callbacks
                        );
                    }

                    newChunks.push(...result.chunks);
                } else {
                    this.emit("chunk:skip", {
                        indexName: this.config.name,
                        filePath,
                        reason: "unchanged",
                    });

                    if (callbacks) {
                        this.dispatchCallbacks(
                            "chunk:skip",
                            {
                                ts: Date.now(),
                                indexName: this.config.name,
                                filePath,
                                reason: "unchanged",
                            },
                            callbacks
                        );
                    }
                }
            }

            let embeddingsGenerated = 0;

            if (this.embedder && newChunks.length > 0) {
                const textsToEmbed = newChunks.map((c) => c.content);

                this.emit("embed:start", {
                    indexName: this.config.name,
                    totalChunks: textsToEmbed.length,
                    provider: this.config.embedding?.provider ?? "default",
                    dimensions: this.embedder.dimensions,
                });

                if (callbacks) {
                    this.dispatchCallbacks(
                        "embed:start",
                        {
                            ts: Date.now(),
                            indexName: this.config.name,
                            totalChunks: textsToEmbed.length,
                            provider: this.config.embedding?.provider ?? "default",
                            dimensions: this.embedder.dimensions,
                        },
                        callbacks
                    );
                }

                const embedStart = performance.now();
                const batchSize = 32;

                for (let i = 0; i < textsToEmbed.length; i += batchSize) {
                    const batch = textsToEmbed.slice(i, i + batchSize);
                    const batchChunks = newChunks.slice(i, i + batchSize);
                    const results = await this.embedder.embedMany(batch);

                    // Store each batch immediately so progress survives cancellation
                    const batchEmbeddings = new Map<string, Float32Array>();

                    for (let j = 0; j < results.length; j++) {
                        batchEmbeddings.set(batchChunks[j].id, results[j].vector);
                    }

                    await this.store.insertChunks(batchChunks, batchEmbeddings);
                    embeddingsGenerated += results.length;

                    this.emit("embed:progress", {
                        indexName: this.config.name,
                        completed: Math.min(i + batchSize, textsToEmbed.length),
                        total: textsToEmbed.length,
                        currentFile: batchChunks[batchChunks.length - 1].filePath,
                    });

                    if (callbacks) {
                        this.dispatchCallbacks(
                            "embed:progress",
                            {
                                ts: Date.now(),
                                indexName: this.config.name,
                                completed: Math.min(i + batchSize, textsToEmbed.length),
                                total: textsToEmbed.length,
                                currentFile: batchChunks[batchChunks.length - 1].filePath,
                            },
                            callbacks
                        );
                    }
                }

                const embedDuration = performance.now() - embedStart;

                this.emit("embed:complete", {
                    indexName: this.config.name,
                    embedded: embeddingsGenerated,
                    skipped: 0,
                    durationMs: embedDuration,
                });

                if (callbacks) {
                    this.dispatchCallbacks(
                        "embed:complete",
                        {
                            ts: Date.now(),
                            indexName: this.config.name,
                            embedded: embeddingsGenerated,
                            skipped: 0,
                            durationMs: embedDuration,
                        },
                        callbacks
                    );
                }
            }

            const deletedChunkIds: string[] = [];

            for (const deletedPath of changes.deleted) {
                const absPath = resolve(this.config.baseDir, deletedPath);
                const result = fileChunkResults.get(absPath);

                if (result) {
                    deletedChunkIds.push(...result.chunks.map((c) => c.id));
                }
            }

            if (deletedChunkIds.length > 0) {
                await this.store.removeChunks(deletedChunkIds);
            }

            if (newChunks.length > 0 && !this.embedder) {
                // Only insert here if no embedder — with embedder, chunks are inserted per batch above
                await this.store.insertChunks(newChunks);
            }

            // Build Merkle tree for diffing (computed, not serialized as blob)
            const merkleFiles = Array.from(chunkHashesPerFile.entries()).map(([path, hashes]) => ({
                path,
                chunkHashes: hashes,
            }));
            buildMerkleTree({
                baseDir: this.config.baseDir,
                files: merkleFiles,
            });

            // Persist per-file chunk hashes to path_hashes table for incremental sync
            const pathEntries = Array.from(chunkHashesPerFile.entries()).map(([filePath, hashes]) => ({
                path: relative(resolve(this.config.baseDir), filePath),
                hash: hashes.sort().join("\0"),
                isFile: true,
            }));
            this.store.getPathHashStore().bulkSync(pathEntries);

            const durationMs = performance.now() - syncStart;

            const syncStats: SyncStats = {
                filesScanned: sourceEntries.length,
                chunksAdded: mode === "full" ? newChunks.length : changes.added.length > 0 ? newChunks.length : 0,
                chunksUpdated: changes.modified.length > 0 ? newChunks.length : 0,
                chunksRemoved: deletedChunkIds.length,
                chunksUnchanged: changes.unchanged.length,
                embeddingsGenerated,
                durationMs,
            };

            const uniqueFiles = new Set<string>();

            for (const chunk of newChunks) {
                uniqueFiles.add(chunk.filePath);
            }

            const embeddingModelInfo = this.embedder
                ? {
                      model: this.config.embedding?.model ?? "unknown",
                      provider: this.config.embedding?.provider ?? "unknown",
                      dimensions: this.embedder.dimensions,
                  }
                : undefined;

            this.store.updateMeta({
                lastSyncAt: Date.now(),
                stats: {
                    totalFiles: sourceEntries.length,
                    totalChunks: this.store.getStats().totalChunks,
                    totalEmbeddings: embeddingsGenerated,
                    embeddingDimensions: this.embedder?.dimensions ?? 0,
                    dbSizeBytes: this.store.getStats().dbSizeBytes,
                    lastSyncDurationMs: durationMs,
                    searchCount: this.store.getStats().searchCount,
                    avgSearchDurationMs: this.store.getStats().avgSearchDurationMs,
                },
                indexEmbedding: embeddingModelInfo,
            });

            this.emit("sync:complete", {
                indexName: this.config.name,
                durationMs,
                stats: syncStats,
            });

            if (callbacks) {
                this.dispatchCallbacks(
                    "sync:complete",
                    {
                        ts: Date.now(),
                        indexName: this.config.name,
                        durationMs,
                        stats: syncStats,
                    },
                    callbacks
                );
            }

            return syncStats;
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);

            this.emit("sync:error", {
                indexName: this.config.name,
                error: errorMsg,
            });

            if (callbacks) {
                this.dispatchCallbacks(
                    "sync:error",
                    {
                        ts: Date.now(),
                        indexName: this.config.name,
                        error: errorMsg,
                    },
                    callbacks
                );
            }

            throw err;
        }
    }
}
