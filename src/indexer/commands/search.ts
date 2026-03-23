import { toToon } from "@app/json/lib/toon";
import { SafeJSON } from "@app/utils/json";
import type { SearchResult } from "@app/utils/search/types";
import { truncateText } from "@app/utils/string";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import type { Indexer } from "../lib/indexer";
import { IndexerManager } from "../lib/manager";
import type { ChunkRecord } from "../lib/types";

type SearchMode = "fulltext" | "vector" | "hybrid";

interface SearchCommandOptions {
    index?: string;
    mode?: SearchMode;
    limit?: number;
    format?: "table" | "json" | "toon";
    file?: string;
}

/** Minimum cosine score below which vector/hybrid results are likely noise */
const VECTOR_MIN_SCORE = 0.55;
/** RRF scores are tiny — equivalent threshold for hybrid mode */
const HYBRID_MIN_SCORE = VECTOR_MIN_SCORE * (1 / 60);

function truncatePreview(text: string, maxLen: number): string {
    const collapsed = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    return truncateText(collapsed, maxLen);
}

/**
 * Detect the best search mode for an index.
 * If the index has embeddings → hybrid (combines BM25 + semantic).
 * Otherwise → fulltext (BM25 only).
 */
function detectMode(indexer: Indexer): SearchMode {
    const info = indexer.getConsistencyInfo();
    return info.embeddingCount > 0 ? "hybrid" : "fulltext";
}

/**
 * Apply a minimum score filter so irrelevant results don't pollute output.
 * Only applied to vector/hybrid modes where low-score noise is common.
 */
function filterByMinScore(
    results: Array<{ indexName: string; result: SearchResult<ChunkRecord> }>,
    mode: SearchMode
): Array<{ indexName: string; result: SearchResult<ChunkRecord> }> {
    if (mode === "fulltext") {
        return results;
    }

    const threshold = mode === "hybrid" ? HYBRID_MIN_SCORE : VECTOR_MIN_SCORE;
    return results.filter((r) => r.result.score >= threshold);
}

async function searchIndexes(
    manager: IndexerManager,
    indexNames: string[],
    query: string,
    mode: SearchMode,
    limit: number
): Promise<{ results: Array<{ indexName: string; result: SearchResult<ChunkRecord> }>; effectiveMode: SearchMode }> {
    let allResults: Array<{ indexName: string; result: SearchResult<ChunkRecord> }> = [];

    for (const name of indexNames) {
        const indexer = await manager.getIndex(name);
        const results = await indexer.search(query, { mode, limit });

        for (const result of results) {
            allResults.push({ indexName: name, result });
        }
    }

    allResults.sort((a, b) => b.result.score - a.result.score);
    allResults = filterByMinScore(allResults, mode);
    allResults = allResults.slice(0, limit);

    return { results: allResults, effectiveMode: mode };
}

export function registerSearchCommand(program: Command): void {
    program
        .command("search")
        .description("Search across indexes")
        .argument("<query>", "Search query")
        .option("-i, --index <name>", "Search specific index (default: all)")
        .option("-m, --mode <mode>", "Search mode: fulltext, vector, hybrid (default: auto-detect)")
        .option("-l, --limit <n>", "Max results", parseInt, 20)
        .option("-f, --file <filter>", "Filter results to files matching this substring (e.g. '.ts', 'src/utils')")
        .option("--format <type>", "Output format: table, json, toon (default: table)")
        .action(async (query: string, opts: SearchCommandOptions) => {
            const manager = await IndexerManager.load();

            try {
                const limit = opts.limit ?? 20;
                const format = opts.format ?? "table";

                const names: string[] = [];

                if (opts.index) {
                    names.push(opts.index);
                } else {
                    const all = manager.getIndexNames();

                    if (all.length === 0) {
                        p.log.info("No indexes configured. Run: tools indexer add <path>");
                        return;
                    }

                    names.push(...all);
                }

                // Auto-detect mode: use hybrid when embeddings exist, fulltext otherwise
                let mode: SearchMode;

                if (opts.mode) {
                    mode = opts.mode;
                } else {
                    const firstIndexer = await manager.getIndex(names[0]);
                    mode = detectMode(firstIndexer);
                }

                // Over-fetch when file filter is set so we don't lose results after filtering
                const fetchLimit = opts.file ? limit * 3 : limit;
                let { results: allResults, effectiveMode } = await searchIndexes(
                    manager,
                    names,
                    query,
                    mode,
                    fetchLimit
                );

                if (opts.file) {
                    const filter = opts.file;
                    allResults = allResults.filter((r) => r.result.doc.filePath.includes(filter));
                    allResults = allResults.slice(0, limit);
                }

                // Auto-fallback: if explicit fulltext returned 0 results, try hybrid
                if (allResults.length === 0 && mode === "fulltext" && !opts.mode) {
                    const firstIndexer = await manager.getIndex(names[0]);
                    const info = firstIndexer.getConsistencyInfo();

                    if (info.embeddingCount > 0) {
                        const fallback = await searchIndexes(manager, names, query, "hybrid", limit);
                        allResults = fallback.results;
                        effectiveMode = "hybrid";

                        if (allResults.length > 0) {
                            p.log.info(pc.dim("No keyword matches — showing semantic results instead"));
                        }
                    }
                }

                if (allResults.length === 0) {
                    p.log.info("No results found.");
                    return;
                }

                function toOutputRow(r: { indexName: string; result: SearchResult<ChunkRecord> }) {
                    return {
                        index: r.indexName,
                        file: r.result.doc.filePath,
                        name: r.result.doc.name ?? "",
                        kind: r.result.doc.kind,
                        score: r.result.score,
                        method: r.result.method,
                        lines: `${r.result.doc.startLine}-${r.result.doc.endLine}`,
                        preview: truncatePreview(r.result.doc.content, 200),
                    };
                }

                if (format === "json") {
                    const output = allResults.map(toOutputRow);
                    console.log(SafeJSON.stringify(output, null, 2));
                    return;
                }

                if (format === "toon") {
                    const output = allResults.map(toOutputRow);
                    console.log(toToon(output));
                    return;
                }

                const headers = ["File", "Name/Kind", "Score", "Method", "Preview"];
                const rows = allResults.map((r) => {
                    const filePath = r.result.doc.filePath;
                    const shortPath = filePath.length > 40 ? `...${filePath.slice(-37)}` : filePath;

                    return [
                        shortPath,
                        r.result.doc.name ?? r.result.doc.kind,
                        r.result.score.toFixed(3),
                        r.result.method,
                        truncatePreview(r.result.doc.content, 80),
                    ];
                });

                console.log("");
                console.log(pc.dim(`${allResults.length} results for "${query}" (${effectiveMode})`));
                console.log("");
                console.log(formatTable(rows, headers, { alignRight: [2] }));
                console.log("");
            } finally {
                await manager.close();
            }
        });
}
