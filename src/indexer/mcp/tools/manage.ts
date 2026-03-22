import { formatBytes, formatDuration, formatRelativeTime } from "@app/utils/format";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError, getManager } from "../shared";

export function registerManageTools(server: McpServer): void {
    server.tool(
        "indexer_status",
        "Check index status. Without a name, shows a summary of all indexes. With a name, shows detailed stats for that index.",
        {
            name: z.string().describe("Index name. Omit for overview of all indexes.").optional(),
        },
        async (args) => ({
            content: [{ type: "text", text: await handleStatus(args) }],
        })
    );

    server.tool(
        "indexer_remove",
        "Remove an index entirely. Stops watchers, closes the database, and deletes all stored data.",
        {
            name: z.string().describe("Index name to remove."),
        },
        async (args) => ({
            content: [{ type: "text", text: await handleRemove(args) }],
        })
    );

    server.tool(
        "indexer_stop",
        "Request cancellation of an in-progress sync/index operation. The current batch finishes and checkpoints. Progress is preserved.",
        {
            name: z.string().describe("Index name to stop."),
        },
        async (args) => ({
            content: [{ type: "text", text: await handleStop(args) }],
        })
    );
}

async function handleStatus(args: { name?: string }): Promise<string> {
    try {
        const manager = await getManager();

        if (args.name) {
            const indexes = manager.listIndexes();
            const meta = indexes.find((m) => m.name === args.name);

            if (!meta) {
                return `Index "${args.name}" not found. Available: ${manager.getIndexNames().join(", ") || "(none)"}`;
            }

            const lastSync = meta.lastSyncAt
                ? `${formatRelativeTime(new Date(meta.lastSyncAt), { compact: true })} (${formatDuration(meta.stats.lastSyncDurationMs)})`
                : "never";

            return [
                `Index: ${meta.name}`,
                `  Path: ${meta.config.baseDir}`,
                `  Type: ${meta.config.type ?? "auto"}`,
                `  Status: ${meta.indexingStatus ?? "idle"}`,
                `  Files: ${meta.stats.totalFiles}`,
                `  Chunks: ${meta.stats.totalChunks}`,
                `  Embeddings: ${meta.stats.totalEmbeddings}`,
                `  Embedding dims: ${meta.stats.embeddingDimensions}`,
                `  DB size: ${formatBytes(meta.stats.dbSizeBytes)}`,
                `  Last sync: ${lastSync}`,
                `  Searches: ${meta.stats.searchCount}`,
                `  Avg search: ${meta.stats.avgSearchDurationMs > 0 ? formatDuration(meta.stats.avgSearchDurationMs) : "n/a"}`,
                ...(meta.indexEmbedding
                    ? [`  Embedding model: ${meta.indexEmbedding.model} (${meta.indexEmbedding.provider})`]
                    : []),
            ].join("\n");
        }

        const indexes = manager.listIndexes();

        if (indexes.length === 0) {
            return "No indexes configured. Use indexer_index to create one.";
        }

        const lines = [`${indexes.length} index(es):\n`];

        for (const meta of indexes) {
            const lastSync = meta.lastSyncAt
                ? formatRelativeTime(new Date(meta.lastSyncAt), { compact: true })
                : "never";

            lines.push(
                `  ${meta.name} — ${meta.stats.totalFiles} files, ${meta.stats.totalChunks} chunks, ${meta.indexingStatus ?? "idle"}, synced ${lastSync}`
            );
        }

        return lines.join("\n");
    } catch (err) {
        return formatError("indexer_status", err);
    }
}

async function handleRemove(args: { name: string }): Promise<string> {
    try {
        const manager = await getManager();
        await manager.removeIndex(args.name);
        return `Index "${args.name}" removed.`;
    } catch (err) {
        return formatError("indexer_remove", err);
    }
}

async function handleStop(args: { name: string }): Promise<string> {
    try {
        const manager = await getManager();
        const stopped = await manager.stopIndex(args.name);

        if (!stopped) {
            return `No in-progress operation found for "${args.name}". It may not be loaded or not syncing.`;
        }

        return `Cancellation requested for "${args.name}". The current batch will finish and checkpoint. Run indexer_sync to resume later.`;
    } catch (err) {
        return formatError("indexer_stop", err);
    }
}
