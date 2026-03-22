import { toToon } from "@app/json/lib/toon";
import { SafeJSON } from "@app/utils/json";
import type { SearchResult } from "@app/utils/search/types";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { IndexerManager } from "../lib/manager";
import type { ChunkRecord } from "../lib/types";

interface SearchCommandOptions {
    index?: string;
    mode?: "fulltext" | "vector" | "hybrid";
    limit?: number;
    format?: "table" | "json" | "toon";
}

function truncatePreview(text: string, maxLen: number): string {
    const oneLine = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();

    if (oneLine.length <= maxLen) {
        return oneLine;
    }

    return `${oneLine.slice(0, maxLen - 3)}...`;
}

export function registerSearchCommand(program: Command): void {
    program
        .command("search")
        .description("Search across indexes")
        .argument("<query>", "Search query")
        .option("-i, --index <name>", "Search specific index (default: all)")
        .option("-m, --mode <mode>", "Search mode: fulltext, vector, hybrid (default: fulltext)")
        .option("-l, --limit <n>", "Max results", parseInt, 20)
        .option("--format <type>", "Output format: table, json, toon (default: table)")
        .action(async (query: string, opts: SearchCommandOptions) => {
            const manager = await IndexerManager.load();

            try {
                const mode = opts.mode ?? "fulltext";
                const limit = opts.limit ?? 20;
                const format = opts.format ?? "table";

                let allResults: Array<{ indexName: string; result: SearchResult<ChunkRecord> }> = [];

                if (opts.index) {
                    const indexer = await manager.getIndex(opts.index);
                    const results = await indexer.search(query, { mode, limit });
                    allResults = results.map((r) => ({ indexName: opts.index!, result: r }));
                } else {
                    const names = manager.getIndexNames();

                    if (names.length === 0) {
                        p.log.info("No indexes configured. Run: tools indexer add <path>");
                        return;
                    }

                    for (const name of names) {
                        const indexer = await manager.getIndex(name);
                        const results = await indexer.search(query, { mode, limit });

                        for (const result of results) {
                            allResults.push({ indexName: name, result });
                        }
                    }

                    allResults.sort((a, b) => b.result.score - a.result.score);
                    allResults = allResults.slice(0, limit);
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
                console.log(pc.dim(`${allResults.length} results for "${query}" (${mode})`));
                console.log("");
                console.log(formatTable(rows, headers, { alignRight: [2] }));
                console.log("");
            } finally {
                await manager.close();
            }
        });
}
