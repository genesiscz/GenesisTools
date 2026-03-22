import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { formatBytes, formatDuration } from "@app/utils/format";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage/storage";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { Indexer } from "../lib/indexer";
import { createProgressCallbacks } from "../lib/progress";
import type { IndexConfig } from "../lib/types";

interface BenchmarkResult {
    timestamp: string;
    target: string;
    indexName: string;
    phases: {
        scanAndChunkMs: number;
        embedMs: number;
        totalMs: number;
    };
    counts: {
        filesScanned: number;
        chunksCreated: number;
        embeddingsGenerated: number;
    };
    throughput: {
        chunksPerSec: number;
        embeddingsPerSec: number;
    };
    search: {
        queries: string[];
        latencies: number[];
        avgLatencyMs: number;
    };
    dbSizeBytes: number;
    provider: string;
    model: string;
}

const BENCHMARK_QUERIES = [
    "function that handles authentication",
    "error handling and retry logic",
    "database connection setup",
    "import statements and dependencies",
    "configuration and environment variables",
];

export function registerBenchmarkCommand(program: Command): void {
    program
        .command("benchmark")
        .description("Benchmark indexing and search performance")
        .argument("<dir>", "Directory to index for benchmarking")
        .option("-o, --output <path>", "Save results JSON to file")
        .option("-p, --provider <provider>", "Embedding provider")
        .option("-m, --model <model>", "Embedding model")
        .option("--no-embed", "Skip embedding (fulltext-only benchmark)")
        .action(
            async (
                dir: string,
                opts: {
                    output?: string;
                    provider?: string;
                    model?: string;
                    embed?: boolean;
                }
            ) => {
                const absDir = resolve(dir);

                if (!existsSync(absDir)) {
                    p.log.error(`Directory not found: ${absDir}`);
                    process.exit(1);
                }

                p.intro(pc.bgCyan(pc.white(` benchmark ${basename(absDir)} `)));

                const benchName = `bench_${Date.now()}`;
                const config: IndexConfig = {
                    name: benchName,
                    baseDir: absDir,
                    type: "code",
                    respectGitIgnore: true,
                    chunking: "auto",
                    embedding: {
                        enabled: opts.embed !== false,
                        provider: opts.provider,
                        model: opts.model,
                    },
                };

                try {
                    const spinner = p.spinner();
                    spinner.start("Indexing...");

                    const indexer = await Indexer.create(config);

                    let embedMs = 0;

                    indexer.on("embed:complete", (payload) => {
                        embedMs = payload.durationMs;
                    });

                    const totalStart = performance.now();
                    const stats = await indexer.sync(createProgressCallbacks(spinner));
                    const totalMs = performance.now() - totalStart;
                    const chunkMs = totalMs - (embedMs > 0 ? embedMs : 0);

                    spinner.stop("Index complete");

                    spinner.start("Running search queries...");
                    const latencies: number[] = [];

                    for (const query of BENCHMARK_QUERIES) {
                        const start = performance.now();
                        await indexer.search(query, {
                            mode: config.embedding?.enabled !== false ? "hybrid" : "fulltext",
                            limit: 10,
                        });
                        latencies.push(performance.now() - start);
                    }

                    spinner.stop("Search complete");

                    const consistency = indexer.getConsistencyInfo();

                    const result: BenchmarkResult = {
                        timestamp: new Date().toISOString(),
                        target: absDir,
                        indexName: benchName,
                        phases: {
                            scanAndChunkMs: Math.round(chunkMs),
                            embedMs: Math.round(embedMs > 0 ? embedMs : 0),
                            totalMs: Math.round(totalMs),
                        },
                        counts: {
                            filesScanned: stats.filesScanned,
                            chunksCreated: stats.chunksAdded,
                            embeddingsGenerated: stats.embeddingsGenerated,
                        },
                        throughput: {
                            chunksPerSec: chunkMs > 0 ? Math.round((stats.chunksAdded / chunkMs) * 1000) : 0,
                            embeddingsPerSec:
                                embedMs > 0 ? Math.round((stats.embeddingsGenerated / embedMs) * 1000) : 0,
                        },
                        search: {
                            queries: BENCHMARK_QUERIES,
                            latencies: latencies.map((l) => Math.round(l * 100) / 100),
                            avgLatencyMs:
                                Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100,
                        },
                        dbSizeBytes: consistency.dbSizeBytes,
                        provider: config.embedding?.provider ?? "default",
                        model: config.embedding?.model ?? "default",
                    };

                    p.log.info(pc.bold("Results:"));
                    p.log.info(`  Files scanned:    ${result.counts.filesScanned.toLocaleString()}`);
                    p.log.info(`  Chunks created:   ${result.counts.chunksCreated.toLocaleString()}`);
                    p.log.info(`  Embeddings:       ${result.counts.embeddingsGenerated.toLocaleString()}`);
                    p.log.info(`  Total time:       ${formatDuration(result.phases.totalMs)}`);
                    p.log.info(`  Scan+chunk:       ${formatDuration(result.phases.scanAndChunkMs)}`);
                    p.log.info(`  Embed phase:      ${formatDuration(result.phases.embedMs)}`);
                    p.log.info(`  Embed throughput: ${result.throughput.embeddingsPerSec} chunks/sec`);
                    p.log.info(`  Avg search:       ${result.search.avgLatencyMs}ms`);
                    p.log.info(`  DB size:          ${formatBytes(result.dbSizeBytes)}`);

                    const json = SafeJSON.stringify(result, null, 2);
                    console.log(json);

                    if (opts.output) {
                        const outPath = resolve(opts.output);
                        const outDir = dirname(outPath);

                        if (!existsSync(outDir)) {
                            mkdirSync(outDir, { recursive: true });
                        }

                        await Bun.write(outPath, json);
                        p.log.success(`Saved to ${outPath}`);
                    }

                    await indexer.close();

                    // Clean up benchmark index files directly (not registered with manager)
                    const storage = new Storage("indexer");
                    const indexDir = join(storage.getBaseDir(), benchName);

                    if (existsSync(indexDir)) {
                        rmSync(indexDir, { recursive: true, force: true });
                    }

                    p.outro("Done");
                } catch (err) {
                    p.log.error(err instanceof Error ? err.message : String(err));
                    process.exitCode = 1;
                }
            }
        );
}
