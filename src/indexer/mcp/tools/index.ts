import { basename, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IndexConfig } from "../../lib/types";
import { formatError, getManager } from "../shared";

export function registerIndexTools(server: McpServer): void {
    server.tool(
        "indexer_index",
        "Create a new index for a codebase directory. Scans files, chunks content using AST-aware parsing, and optionally generates embeddings for semantic search. Returns when indexing completes.",
        {
            path: z.string().describe("Absolute path to the directory to index."),
            name: z.string().describe("Index name. Default: directory basename.").optional(),
            provider: z
                .string()
                .describe("Embedding provider: darwinkit, local-hf, cloud, ollama. Default: darwinkit.")
                .optional(),
            model: z.string().describe("Embedding model ID. Default: auto-selected by provider.").optional(),
            noEmbed: z.boolean().describe("Skip embeddings entirely. Fulltext-only search. Default: false.").optional(),
        },
        async (args) => ({
            content: [{ type: "text", text: await handleIndex(args) }],
        })
    );

    server.tool(
        "indexer_sync",
        "Incrementally sync an existing index. Re-scans for changed/added/deleted files and updates the index. Much faster than a full re-index.",
        {
            name: z.string().describe("Index name to sync."),
        },
        async (args) => ({
            content: [{ type: "text", text: await handleSync(args) }],
        })
    );
}

interface IndexArgs {
    path: string;
    name?: string;
    provider?: string;
    model?: string;
    noEmbed?: boolean;
}

async function handleIndex(args: IndexArgs): Promise<string> {
    try {
        const manager = await getManager();
        const absPath = resolve(args.path);
        const indexName = args.name ?? basename(absPath);

        // Check if index already exists
        const existing = manager.getIndexNames();

        if (existing.includes(indexName)) {
            return `Index "${indexName}" already exists. Use indexer_sync to update it, or indexer_remove + indexer_index to recreate.`;
        }

        const config: IndexConfig = {
            name: indexName,
            baseDir: absPath,
            type: "code",
            respectGitIgnore: true,
            chunking: "auto",
            embedding: {
                enabled: args.noEmbed !== true,
                provider: args.provider,
                model: args.model,
            },
        };

        const indexer = await manager.addIndex(config);
        const stats = indexer.stats;

        const lines = [
            `Index "${indexName}" created and synced.`,
            `  Path: ${absPath}`,
            `  Files: ${stats.totalFiles}`,
            `  Chunks: ${stats.totalChunks}`,
            `  Embeddings: ${stats.totalEmbeddings}`,
            `  DB Size: ${(stats.dbSizeBytes / 1024).toFixed(0)} KB`,
            "",
            "Use indexer_search to query the index.",
        ];

        return lines.join("\n");
    } catch (err) {
        return formatError("indexer_index", err);
    }
}

async function handleSync(args: { name: string }): Promise<string> {
    try {
        const manager = await getManager();
        const indexer = await manager.getIndex(args.name);
        const syncStats = await indexer.sync();

        const totalChanges = syncStats.chunksAdded + syncStats.chunksUpdated + syncStats.chunksRemoved;

        if (totalChanges === 0 && syncStats.embeddingsGenerated === 0) {
            return `Index "${args.name}" is up to date. No changes detected.`;
        }

        const lines = [
            `Synced index "${args.name}":`,
            `  Files scanned: ${syncStats.filesScanned}`,
            `  Chunks added: ${syncStats.chunksAdded}`,
            `  Chunks updated: ${syncStats.chunksUpdated}`,
            `  Chunks removed: ${syncStats.chunksRemoved}`,
            `  Embeddings generated: ${syncStats.embeddingsGenerated}`,
            `  Duration: ${(syncStats.durationMs / 1000).toFixed(1)}s`,
        ];

        if (syncStats.cancelled) {
            lines.push("", "Note: Sync was cancelled. Progress is checkpointed. Run indexer_sync again to resume.");
        }

        return lines.join("\n");
    } catch (err) {
        return formatError("indexer_sync", err);
    }
}
