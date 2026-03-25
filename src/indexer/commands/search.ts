import { toToon } from "@app/json/lib/toon";
import { SafeJSON } from "@app/utils/json";
import type { SearchResult } from "@app/utils/search/types";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { normalizeConfidence } from "../lib/confidence";
import { formatChunkDisplayName } from "../lib/display-name";
import { parseQueryWords } from "../lib/highlight";
import { IndexerManager } from "../lib/manager";
import { detectMode, resolveSearchMode, type SearchMode } from "../lib/search-mode";
import { formatSearchResults, type FormattedSearchResult, type OutputFormat } from "../lib/search-output";
import type { ChunkRecord } from "../lib/types";

interface SearchCommandOptions {
    index?: string;
    mode?: string;
    limit?: number;
    format?: "pretty" | "simple" | "table" | "json" | "toon";
    file?: string;
    confidence?: number;
    contextChunks?: number;
}

export function registerSearchCommand(program: Command): void {
    program
        .command("search")
        .description("Search across indexes")
        .argument("<query>", "Search query")
        .option("-i, --index <name>", "Search specific index (default: all)")
        .option("-m, --mode <mode>", "Search mode: fulltext, vector, hybrid (default: auto-detect)")
        .option("-l, --limit <n>", "Max results", parseInt, 20)
        .option("-f, --file <filter>", "Filter results to files matching this substring")
        .option("--format <type>", "Output format: pretty, simple, table, json, toon (default: pretty)")
        .option("-c, --confidence <min>", "Minimum confidence % (0-100)", parseInt)
        .option("--context-chunks <n>", "Show N surrounding chunks for context", parseInt)
        .action(async (query: string, opts: SearchCommandOptions) => {
            const manager = await IndexerManager.load();

            try {
                const limit = opts.limit ?? 20;
                const format = opts.format ?? (process.stdout.isTTY ? "pretty" : "simple");

                const names = opts.index ? [opts.index] : manager.getIndexNames();

                if (names.length === 0) {
                    p.log.info("No indexes configured. Run: tools indexer add <path>");
                    return;
                }

                const firstIndexer = await manager.getIndex(names[0]);

                let mode: SearchMode;

                if (opts.mode) {
                    const resolved = resolveSearchMode(opts.mode);

                    if (!resolved) {
                        p.log.error(`Unknown search mode: "${opts.mode}". Valid: fulltext, vector, hybrid, semantic`);
                        return;
                    }

                    mode = resolved;
                } else {
                    mode = detectMode(firstIndexer);
                }

                let effectiveMode = mode;
                const fetchLimit = opts.file ? limit * 3 : limit;

                let allResults: Array<{ indexName: string; result: SearchResult<ChunkRecord> }> = [];

                for (const name of names) {
                    const indexer = name === names[0] ? firstIndexer : await manager.getIndex(name);
                    const results = await indexer.search(query, { mode, limit: fetchLimit });

                    for (const result of results) {
                        allResults.push({ indexName: name, result });
                    }
                }

                allResults.sort((a, b) => b.result.score - a.result.score);

                if (opts.file) {
                    allResults = allResults.filter((r) => r.result.doc.filePath.includes(opts.file!));
                }

                allResults = allResults.slice(0, limit);

                if (allResults.length === 0 && mode === "fulltext") {
                    const hasEmbeddings = firstIndexer.getConsistencyInfo().embeddingCount > 0;

                    if (hasEmbeddings) {
                        effectiveMode = "hybrid";
                        allResults = [];

                        for (const name of names) {
                            const indexer = await manager.getIndex(name);
                            const results = await indexer.search(query, { mode: "hybrid", limit: fetchLimit });

                            for (const result of results) {
                                allResults.push({ indexName: name, result });
                            }
                        }

                        allResults.sort((a, b) => b.result.score - a.result.score);

                        if (opts.file) {
                            allResults = allResults.filter((r) => r.result.doc.filePath.includes(opts.file!));
                        }

                        allResults = allResults.slice(0, limit);
                    }
                }

                if (allResults.length === 0) {
                    p.log.info("No results found.");
                    return;
                }

                const maxBm25Score = allResults.reduce(
                    (max, r) => (r.result.method === "bm25" ? Math.max(max, r.result.score) : max),
                    0
                );

                const formatted: FormattedSearchResult[] = allResults.map((r) => ({
                    filePath: r.result.doc.filePath,
                    displayName: formatChunkDisplayName(
                        r.result.doc.name,
                        r.result.doc.startLine,
                        r.result.doc.endLine,
                        r.result.doc.kind
                    ),
                    language: r.result.doc.language ?? null,
                    content: r.result.doc.content,
                    confidence: normalizeConfidence(r.result.score, r.result.method, maxBm25Score),
                    method: r.result.method,
                    indexName: r.indexName,
                    startLine: r.result.doc.startLine,
                    endLine: r.result.doc.endLine,
                }));

                const filtered = opts.confidence !== undefined
                    ? formatted.filter((r) => r.confidence >= opts.confidence!)
                    : formatted;

                if (format === "json" || format === "toon") {
                    const output = filtered.map((r) => ({
                        index: r.indexName,
                        file: r.filePath,
                        name: r.displayName,
                        language: r.language,
                        confidence: r.confidence,
                        method: r.method,
                        lines: `${r.startLine}-${r.endLine}`,
                        preview: r.content.replace(/\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 200),
                    }));

                    if (format === "json") {
                        console.log(SafeJSON.stringify(output, null, 2));
                    } else {
                        console.log(toToon(output));
                    }

                    return;
                }

                const words = parseQueryWords(query);
                const output = formatSearchResults({
                    results: filtered,
                    format: format as OutputFormat,
                    query,
                    mode: effectiveMode,
                    highlightWords: words,
                });
                console.log(output);
            } finally {
                await manager.close();
            }
        });
}
