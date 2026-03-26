import { toToon } from "@app/json/lib/toon";
import { SafeJSON } from "@app/utils/json";
import type { SearchResult } from "@app/utils/search/types";
import { truncateText } from "@app/utils/string";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { normalizeConfidence } from "../lib/confidence";
import { formatChunkDisplayName } from "../lib/display-name";
import { parseQueryWords } from "../lib/highlight";
import { IndexerManager } from "../lib/manager";
import { detectMode, resolveSearchMode, type SearchMode } from "../lib/search-mode";
import { type FormattedSearchResult, formatSearchResults, type OutputFormat } from "../lib/search-output";
import type { ChunkRecord } from "../lib/types";

interface SearchCommandOptions {
    index?: string;
    mode?: string;
    limit?: number;
    format?: "pretty" | "simple" | "table" | "json" | "toon";
    file?: string;
    confidence?: number;
}

type IndexResult = { indexName: string; result: SearchResult<ChunkRecord> };

async function searchAndCollect(
    manager: IndexerManager,
    names: string[],
    query: string,
    mode: SearchMode,
    limit: number,
    fileFilter?: string
): Promise<IndexResult[]> {
    let allResults: IndexResult[] = [];

    for (const name of names) {
        const indexer = await manager.getIndex(name);
        const results = await indexer.search(query, { mode, limit });

        for (const result of results) {
            allResults.push({ indexName: name, result });
        }
    }

    allResults.sort((a, b) => b.result.score - a.result.score);

    if (fileFilter) {
        allResults = allResults.filter((r) => r.result.doc.filePath.includes(fileFilter));
    }

    return allResults.slice(0, limit);
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
        .action(async (query: string, opts: SearchCommandOptions) => {
            const manager = await IndexerManager.load();

            try {
                const validFormats = ["pretty", "simple", "table", "json", "toon"] as const;
                const limit = opts.limit ?? 20;
                const format = opts.format ?? (process.stdout.isTTY ? "pretty" : "simple");

                if (!validFormats.includes(format as (typeof validFormats)[number])) {
                    p.log.error(`Unknown format: "${format}". Valid: ${validFormats.join(", ")}`);
                    return;
                }

                const confidence = opts.confidence;

                if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 100)) {
                    p.log.error(`Invalid confidence: "${opts.confidence}". Expected 0-100.`);
                    return;
                }

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

                let allResults = await searchAndCollect(manager, names, query, mode, fetchLimit, opts.file);

                // Auto-fallback: only when mode was auto-detected (not explicitly requested)
                if (allResults.length === 0 && mode === "fulltext" && !opts.mode) {
                    const hasEmbeddings = firstIndexer.getConsistencyInfo().embeddingCount > 0;

                    if (hasEmbeddings) {
                        effectiveMode = "hybrid";
                        allResults = await searchAndCollect(manager, names, query, "hybrid", fetchLimit, opts.file);
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

                const filtered =
                    confidence !== undefined
                        ? formatted.filter((r) => r.confidence >= confidence)
                        : formatted;

                if (format === "json" || format === "toon") {
                    const output = filtered.map((r) => ({
                        index: r.indexName,
                        file: r.filePath,
                        name: r.displayName,
                        language: r.language,
                        confidence: r.confidence,
                        method: r.method,
                        lines:
                            r.startLine != null && r.endLine != null
                                ? `${r.startLine}-${r.endLine}`
                                : null,
                        preview: truncateText(r.content.replace(/\n/g, " ").replace(/\s+/g, " ").trim(), 200),
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
