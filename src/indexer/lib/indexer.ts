import type { Dirent } from "node:fs";
import { readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { Embedder } from "@app/utils/ai/tasks/Embedder";
import type { SearchOptions, SearchResult } from "@app/utils/search/types";
import { detectChanges } from "./change-detector";
import type { ChunkResult } from "./chunker";
import { chunkFile } from "./chunker";
import type { IndexerCallbacks, SyncStats } from "./events";
import { IndexerEventEmitter } from "./events";
import { buildMerkleTree } from "./merkle";
import type { IndexStore } from "./store";
import { createIndexStore } from "./store";
import type { ChunkRecord, IndexConfig, IndexStats } from "./types";

export class EmbeddingSetupError extends Error {
    readonly reason: string;
    readonly requestedProvider?: string;

    constructor(reason: string, requestedProvider?: string) {
        const providers = [
            "darwinkit  — macOS on-device NaturalLanguage.framework (512-dim, free)",
            "local-hf   — HuggingFace all-MiniLM-L6-v2 (384-dim, ~25MB download)",
            "cloud      — OpenAI text-embedding-3-small (1536-dim, requires OPENAI_API_KEY)",
        ];

        const msg = [
            `Embedding setup failed: ${reason}`,
            "",
            "Available providers:",
            ...providers.map((p) => `  ${p}`),
            "",
            "Fix with one of:",
            `  tools indexer add <path> --provider darwinkit`,
            `  tools indexer add <path> --provider local-hf`,
            `  tools indexer add <path> --provider cloud`,
            "",
            "Or disable embeddings (fulltext-only search, no semantic):",
            `  tools indexer add <path> --no-embed`,
        ].join("\n");

        super(msg);
        this.name = "EmbeddingSetupError";
        this.reason = reason;
        this.requestedProvider = requestedProvider;
    }
}

interface FileEntry {
    path: string;
    content: string;
}

async function scanFiles(opts: {
    baseDir: string;
    respectGitIgnore?: boolean;
    includedSuffixes?: string[];
    ignoredPaths?: string[];
}): Promise<FileEntry[]> {
    const { baseDir, respectGitIgnore, includedSuffixes, ignoredPaths } = opts;
    const absBaseDir = resolve(baseDir);

    let filePaths: string[];

    if (respectGitIgnore) {
        const isGit = await checkIsGitRepo(absBaseDir);

        if (isGit) {
            filePaths = await getGitTrackedFiles(absBaseDir);
        } else {
            filePaths = walkDirectory(absBaseDir);
        }
    } else {
        filePaths = walkDirectory(absBaseDir);
    }

    if (includedSuffixes && includedSuffixes.length > 0) {
        const suffixSet = new Set(includedSuffixes.map((s) => (s.startsWith(".") ? s : `.${s}`)));
        filePaths = filePaths.filter((f) => suffixSet.has(extname(f).toLowerCase()));
    }

    if (ignoredPaths && ignoredPaths.length > 0) {
        filePaths = filePaths.filter((f) => {
            const rel = relative(absBaseDir, f);
            return !ignoredPaths.some((pattern) => rel.startsWith(pattern) || rel.includes(pattern));
        });
    }

    const entries: FileEntry[] = [];

    for (const filePath of filePaths) {
        try {
            const content = await Bun.file(filePath).text();
            entries.push({ path: filePath, content });
        } catch {
            // Skip unreadable files
        }
    }

    return entries;
}

async function checkIsGitRepo(baseDir: string): Promise<boolean> {
    const proc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
        cwd: baseDir,
        stdout: "pipe",
        stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
}

async function getGitTrackedFiles(baseDir: string): Promise<string[]> {
    const proc = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
        cwd: baseDir,
        stdout: "pipe",
        stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((rel) => join(baseDir, rel));
}

function walkDirectory(baseDir: string): string[] {
    const result: string[] = [];

    function walk(dir: string): void {
        let entries: Dirent[];

        try {
            entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
        } catch {
            return;
        }

        for (const entry of entries) {
            const name = String(entry.name);
            const fullPath = join(dir, name);

            if (entry.isDirectory()) {
                if (name.startsWith(".") || name === "node_modules") {
                    continue;
                }

                walk(fullPath);
            } else if (entry.isFile()) {
                result.push(fullPath);
            }
        }
    }

    walk(baseDir);
    return result;
}

export class Indexer extends IndexerEventEmitter {
    private store: IndexStore;
    private config: IndexConfig;
    private embedder: Embedder | null = null;
    private watchTimer: ReturnType<typeof setInterval> | null = null;

    private constructor(store: IndexStore, config: IndexConfig) {
        super();
        this.store = store;
        this.config = config;
    }

    static async create(config: IndexConfig): Promise<Indexer> {
        const store = await createIndexStore(config);
        const indexer = new Indexer(store, config);

        const embeddingEnabled = config.embedding?.enabled !== false;

        if (embeddingEnabled) {
            try {
                const { Embedder: EmbedderClass } = await import("@app/utils/ai/tasks/Embedder");
                indexer.embedder = await EmbedderClass.create({
                    provider: config.embedding?.provider,
                    model: config.embedding?.model,
                });
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                throw new EmbeddingSetupError(reason, config.embedding?.provider);
            }
        }

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
            const files = await scanFiles({
                baseDir: this.config.baseDir,
                respectGitIgnore: this.config.respectGitIgnore,
                includedSuffixes: this.config.includedSuffixes,
                ignoredPaths: this.config.ignoredPaths,
            });

            const strategy = this.config.chunking ?? "auto";
            const maxTokens = this.config.chunkMaxTokens ?? 500;
            const fileChunkResults = new Map<string, ChunkResult>();
            const chunkHashesPerFile = new Map<string, string[]>();

            for (const file of files) {
                const result = chunkFile({
                    filePath: file.path,
                    content: file.content,
                    strategy,
                    maxTokens,
                    indexType: this.config.type,
                });

                fileChunkResults.set(file.path, result);
                chunkHashesPerFile.set(
                    file.path,
                    result.chunks.map((c) => c.id)
                );
            }

            const watchStrategy = this.config.watch?.strategy ?? "merkle";
            const previousMerkle = mode === "full" ? null : await this.store.loadMerkle();

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

            let embeddingsMap: Map<string, Float32Array> | undefined;
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
                embeddingsMap = new Map<string, Float32Array>();

                for (let i = 0; i < textsToEmbed.length; i += batchSize) {
                    const batch = textsToEmbed.slice(i, i + batchSize);
                    const batchChunks = newChunks.slice(i, i + batchSize);
                    const results = await this.embedder.embedMany(batch);

                    for (let j = 0; j < results.length; j++) {
                        embeddingsMap.set(batchChunks[j].id, results[j].vector);
                    }

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

            if (newChunks.length > 0) {
                await this.store.insertChunks(newChunks, embeddingsMap);
            }

            const merkleTree = buildMerkleTree({
                baseDir: this.config.baseDir,
                files: Array.from(chunkHashesPerFile.entries()).map(([path, hashes]) => ({
                    path,
                    chunkHashes: hashes,
                })),
            });

            await this.store.saveMerkle(merkleTree);

            const durationMs = performance.now() - syncStart;

            const syncStats: SyncStats = {
                filesScanned: files.length,
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

            this.store.updateMeta({
                lastSyncAt: Date.now(),
                stats: {
                    totalFiles: files.length,
                    totalChunks: this.store.getStats().totalChunks,
                    totalEmbeddings: embeddingsGenerated,
                    embeddingDimensions: this.embedder?.dimensions ?? 0,
                    dbSizeBytes: this.store.getStats().dbSizeBytes,
                    lastSyncDurationMs: durationMs,
                    searchCount: this.store.getStats().searchCount,
                    avgSearchDurationMs: this.store.getStats().avgSearchDurationMs,
                },
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
