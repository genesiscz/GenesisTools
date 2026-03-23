import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChunkRecord } from "../../lib/types";
import { formatError, getManager } from "../shared";

export function registerSearchTools(server: McpServer): void {
    server.tool(
        "indexer_search",
        "Search across indexed codebases. Returns matching code chunks with file paths, line numbers, and relevance scores. Supports fulltext (BM25), vector (semantic), or hybrid search modes.",
        {
            query: z.string().describe("Search query (natural language or code terms)."),
            indexName: z.string().describe("Index name to search. Omit to search all indexes.").optional(),
            limit: z.number().min(1).max(100).describe("Max results. Default: 20.").optional(),
            mode: z
                .enum(["fulltext", "vector", "hybrid"])
                .describe("Search mode. Default: auto (hybrid when embeddings exist, fulltext otherwise).")
                .optional(),
            minScore: z
                .number()
                .min(0)
                .max(1)
                .describe("Minimum score threshold. Default: 0 (no filtering).")
                .optional(),
            fileFilter: z.string().describe("Filter results to files matching this substring.").optional(),
        },
        async (args) => ({
            content: [{ type: "text", text: await handleSearch(args) }],
        })
    );
}

interface SearchArgs {
    query: string;
    indexName?: string;
    limit?: number;
    mode?: "fulltext" | "vector" | "hybrid";
    minScore?: number;
    fileFilter?: string;
}

async function handleSearch(args: SearchArgs): Promise<string> {
    try {
        const manager = await getManager();
        const limit = args.limit ?? 20;
        const minScore = args.minScore ?? 0;

        // Auto-detect mode: hybrid when embeddings exist, fulltext otherwise
        let mode = args.mode ?? "fulltext";

        if (!args.mode) {
            const names = args.indexName ? [args.indexName] : manager.getIndexNames();

            if (names.length > 0) {
                const first = await manager.getIndex(names[0]);
                const info = first.getConsistencyInfo();
                mode = info.embeddingCount > 0 ? "hybrid" : "fulltext";
            }
        }

        let allResults: Array<{ indexName: string; doc: ChunkRecord; score: number; method: string }> = [];

        if (args.indexName) {
            const indexer = await manager.getIndex(args.indexName);
            const results = await indexer.search(args.query, { mode, limit });

            for (const r of results) {
                allResults.push({
                    indexName: args.indexName,
                    doc: r.doc,
                    score: r.score,
                    method: r.method,
                });
            }
        } else {
            const names = manager.getIndexNames();

            if (names.length === 0) {
                return "No indexes configured. Use indexer_index to create one.";
            }

            for (const name of names) {
                const indexer = await manager.getIndex(name);
                const results = await indexer.search(args.query, { mode, limit });

                for (const r of results) {
                    allResults.push({
                        indexName: name,
                        doc: r.doc,
                        score: r.score,
                        method: r.method,
                    });
                }
            }

            allResults.sort((a, b) => b.score - a.score);
        }

        // Apply filters before truncation so valid matches aren't dropped
        if (minScore > 0) {
            allResults = allResults.filter((r) => r.score >= minScore);
        }

        if (args.fileFilter) {
            const filter = args.fileFilter;
            allResults = allResults.filter((r) => r.doc.filePath.includes(filter));
        }

        allResults = allResults.slice(0, limit);

        if (allResults.length === 0) {
            return `No results found for "${args.query}". Ensure indexes exist (indexer_status) and have been synced.`;
        }

        const lines = [`Search results for "${args.query}" (${allResults.length} matches, mode: ${mode}):\n`];

        for (const r of allResults) {
            lines.push(
                `--- ${r.doc.filePath} (lines ${r.doc.startLine}-${r.doc.endLine}) [${r.doc.language ?? r.doc.kind}] score: ${r.score.toFixed(4)} ---`
            );
            lines.push(r.doc.content);
            lines.push("");
        }

        return lines.join("\n");
    } catch (err) {
        return formatError("indexer_search", err);
    }
}
