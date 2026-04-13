import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { discoverEmbeddingProviders } from "@app/utils/ai/embedding-selection";
import { Embedder } from "@app/utils/ai/tasks/Embedder";
import { formatBytes, formatDuration } from "@app/utils/format";
import { SafeJSON } from "@app/utils/json";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { Indexer } from "../lib/indexer";
import { createProgressCallbacks } from "../lib/progress";
import { getIndexerStorage } from "../lib/storage";
import type { IndexConfig } from "../lib/types";
import { PROVIDER_BATCH_SIZES } from "../lib/types";

// ── Types ──

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

interface ProviderBenchResult {
    provider: string;
    model: string;
    embPerSec: number;
    dimensions: number;
    totalEmbedded: number;
    durationMs: number;
    gpu: string;
    estimate300k: string;
}

interface CompareResult {
    timestamp: string;
    sampleCount: number;
    sampleType: string;
    durationPerProvider: number;
    providers: ProviderBenchResult[];
    recommendation: string;
}

// ── Constants ──

const BENCHMARK_QUERIES = [
    "function that handles authentication",
    "error handling and retry logic",
    "database connection setup",
    "import statements and dependencies",
    "configuration and environment variables",
];

const TARGET_300K = 300_000;

// ── Sample text generators ──

type SampleType = "mail" | "code" | "general";

function generateSampleTexts(count: number, type: SampleType): string[] {
    const texts: string[] = [];

    for (let i = 0; i < count; i++) {
        switch (type) {
            case "mail":
                texts.push(generateMailSample(i));
                break;
            case "code":
                texts.push(generateCodeSample(i));
                break;
            case "general":
                texts.push(generateGeneralSample(i));
                break;
        }
    }

    return texts;
}

function generateMailSample(index: number): string {
    const rand = index % 100;

    if (rand < 50) {
        return [
            `Subject: Re: Quick update`,
            `From: user${index}@example.com`,
            ``,
            `Sounds good, let me know when you're free. Thanks!`,
        ].join("\n");
    }

    if (rand < 85) {
        return [
            `Subject: Project status update - Sprint ${index % 20}`,
            `From: pm${index % 5}@company.com`,
            ``,
            `Hi team,`,
            ``,
            `Here's the weekly status update for our project. We've completed ${(index % 8) + 2} tasks`,
            `this week and have ${(index % 5) + 1} remaining items in the backlog.`,
            ``,
            `Key highlights:`,
            `- Feature implementation is on track`,
            `- Performance testing shows ${90 + (index % 10)}% improvement`,
            `- Deployment scheduled for next ${index % 2 === 0 ? "Monday" : "Thursday"}`,
            ``,
            `Please review and let me know if you have questions.`,
            `Best regards`,
        ].join("\n");
    }

    return [
        `Subject: Q${(index % 4) + 1} Planning & Budget Review - Action Required`,
        `From: director${index % 3}@company.com`,
        ``,
        `Dear team,`,
        ``,
        `I'm writing to share the comprehensive quarterly review and planning document`,
        `for the upcoming quarter. This covers budget allocation, resource planning,`,
        `and strategic initiatives that will shape our direction.`,
        ``,
        `Budget Overview:`,
        `- Engineering: $${(index % 500) + 200}K allocated for infrastructure`,
        `- Product: $${(index % 300) + 100}K for user research and design`,
        `- Marketing: $${(index % 200) + 50}K for campaign launches`,
        ``,
        `Strategic Priorities:`,
        `1. Complete the platform migration by end of quarter`,
        `2. Launch the new analytics dashboard for enterprise clients`,
        `3. Reduce infrastructure costs by ${10 + (index % 20)}%`,
        `4. Hire ${(index % 5) + 2} additional engineers for the growth team`,
        ``,
        `Please review the attached spreadsheet and provide your feedback`,
        `by end of week. We'll discuss in the all-hands on Friday.`,
        ``,
        `Thanks for your continued dedication to the team.`,
        ``,
        `Best,`,
        `Leadership Team`,
    ].join("\n");
}

function generateCodeSample(index: number): string {
    const funcNames = ["processData", "validateInput", "fetchResults", "handleError", "transformPayload"];
    const name = funcNames[index % funcNames.length];

    return [
        `async function ${name}${index}(input: string): Promise<Result> {`,
        `    if (!input || input.length === 0) {`,
        `        throw new Error("Invalid input provided");`,
        `    }`,
        ``,
        `    const config = await loadConfig();`,
        `    const result = await execute(input, config);`,
        ``,
        `    if (result.status !== "ok") {`,
        `        logger.warn("Unexpected status", { status: result.status });`,
        `        return { success: false, data: null };`,
        `    }`,
        ``,
        `    return { success: true, data: result.payload };`,
        `}`,
    ].join("\n");
}

function generateGeneralSample(index: number): string {
    const topics = [
        "cloud infrastructure and deployment strategies",
        "machine learning model optimization techniques",
        "distributed systems architecture patterns",
        "API design and REST best practices",
        "database indexing and query performance",
    ];
    const topic = topics[index % topics.length];

    return [
        `Document ${index}: ${topic}`,
        ``,
        `This section covers the fundamental concepts of ${topic}.`,
        `Understanding these principles is essential for building`,
        `scalable and maintainable systems. The key considerations`,
        `include reliability, performance, and cost efficiency.`,
        ``,
        `When implementing ${topic}, teams should evaluate`,
        `trade-offs between complexity and maintainability.`,
    ].join("\n");
}

// ── Provider discovery ──

async function discoverProviders(sampleType: SampleType) {
    const type: "mail" | "code" = sampleType === "code" ? "code" : "mail";
    const all = await discoverEmbeddingProviders(type);

    return all
        .filter((p) => p.available)
        .map((p) => ({
            provider: p.provider,
            model: p.model,
            label: p.label,
            gpu: p.gpu,
        }));
}

// ── Provider benchmarking ──

async function benchProvider(params: {
    provider: string;
    model: string;
    sampleTexts: string[];
    durationMs: number;
    gpu: string;
}): Promise<ProviderBenchResult> {
    const { provider, model, sampleTexts, durationMs, gpu } = params;

    const embedder = await Embedder.create({ provider, model });
    const batchSize = PROVIDER_BATCH_SIZES[provider] ?? 32;
    const dimensions = embedder.dimensions;

    let totalEmbedded = 0;
    const start = performance.now();
    let sampleIndex = 0;

    while (performance.now() - start < durationMs) {
        const batch: string[] = [];

        for (let i = 0; i < batchSize; i++) {
            batch.push(sampleTexts[sampleIndex % sampleTexts.length]);
            sampleIndex++;
        }

        await embedder.embedBatch(batch);
        totalEmbedded += batch.length;
    }

    const elapsed = performance.now() - start;
    const embPerSec = Math.round((totalEmbedded / elapsed) * 1000);

    const secondsFor300k = embPerSec > 0 ? TARGET_300K / embPerSec : Infinity;
    const estimate300k = embPerSec > 0 ? formatDuration(secondsFor300k, "s") : "N/A";

    embedder.dispose();

    return {
        provider,
        model,
        embPerSec,
        dimensions,
        totalEmbedded,
        durationMs: Math.round(elapsed),
        gpu,
        estimate300k,
    };
}

// ── Command registration ──

export function registerBenchmarkCommand(program: Command): void {
    program
        .command("benchmark")
        .description("Benchmark indexing and search performance")
        .argument("[dir]", "Directory to index for benchmarking")
        .option("-o, --output <path>", "Save results JSON to file")
        .option("-p, --provider <provider>", "Embedding provider")
        .option("-m, --model <model>", "Embedding model")
        .option("--no-embed", "Skip embedding (fulltext-only benchmark)")
        .option("--compare-providers", "Benchmark all available embedding providers")
        .option("--compare-models", "Benchmark all models for a provider (default: ollama)")
        .option("--duration <seconds>", "Seconds per provider in comparison mode", "30")
        .option("--sample-count <n>", "Number of sample texts to generate", "500")
        .option("--sample-type <type>", "Sample text type: mail, code, general", "mail")
        .action(
            async (
                dir: string | undefined,
                opts: {
                    output?: string;
                    provider?: string;
                    model?: string;
                    embed?: boolean;
                    compareProviders?: boolean;
                    compareModels?: boolean;
                    duration?: string;
                    sampleCount?: string;
                    sampleType?: string;
                }
            ) => {
                if (opts.compareModels) {
                    await runCompareModels(opts);
                    return;
                }

                if (opts.compareProviders) {
                    await runCompareProviders(opts);
                    return;
                }

                if (!dir) {
                    p.log.error("Directory argument is required (unless using --compare-providers)");
                    process.exit(1);
                }

                await runDirBenchmark(dir, opts);
            }
        );
}

// ── Compare providers mode ──

async function runCompareProviders(opts: {
    duration?: string;
    sampleCount?: string;
    sampleType?: string;
    output?: string;
}): Promise<void> {
    const durationSec = Number.parseInt(opts.duration ?? "30", 10);
    const sampleCount = Number.parseInt(opts.sampleCount ?? "500", 10);
    const sampleType = (opts.sampleType ?? "mail") as SampleType;

    p.intro(pc.bgCyan(pc.white(" benchmark --compare-providers ")));

    const spinner = p.spinner();
    spinner.start("Discovering available embedding providers...");

    const providers = await discoverProviders(sampleType);

    if (providers.length === 0) {
        spinner.stop("No providers found");
        p.log.error(
            "No embedding providers available. Try:\n" +
                "  - Start Ollama with an embedding model: ollama pull nomic-embed-text\n" +
                "  - Set OPENAI_API_KEY for cloud embeddings\n" +
                "  - Use macOS for CoreML/DarwinKit providers"
        );
        process.exitCode = 1;
        return;
    }

    spinner.stop(`Found ${providers.length} provider${providers.length === 1 ? "" : "s"}`);

    p.log.info(`Generating ${sampleCount} ${sampleType} sample texts...`);
    const sampleTexts = generateSampleTexts(sampleCount, sampleType);

    p.log.info(`Running ${durationSec}s benchmark per provider\n`);

    const results: ProviderBenchResult[] = [];

    for (const prov of providers) {
        const spinner = p.spinner();
        spinner.start(`Benchmarking ${prov.label} (${prov.model})...`);

        try {
            const result = await benchProvider({
                provider: prov.provider,
                model: prov.model,
                sampleTexts,
                durationMs: durationSec * 1000,
                gpu: prov.gpu,
            });
            results.push(result);
            spinner.stop(`${prov.label}: ${result.embPerSec} emb/s (${result.totalEmbedded.toLocaleString()} total)`);
        } catch (err) {
            spinner.stop(`${prov.label}: FAILED - ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    if (results.length === 0) {
        p.log.error("All providers failed. Check configuration and try again.");
        process.exitCode = 1;
        return;
    }

    // Sort by throughput descending
    results.sort((a, b) => b.embPerSec - a.embPerSec);

    // Build table
    const rows = results.map((r, i) => {
        const bullet = i === 0 ? "\u25CF" : "\u25CB";
        const provLabel =
            providers.find((pp) => pp.provider === r.provider && pp.model === r.model)?.label ?? r.provider;
        return [
            `${bullet} ${provLabel}`,
            r.model,
            r.embPerSec.toLocaleString(),
            String(r.dimensions),
            r.estimate300k,
            r.gpu,
        ];
    });

    const table = formatTable(rows, ["Provider", "Model", "emb/s", "Dims", "300K est.", "GPU"], {
        alignRight: [2, 3],
    });

    console.log();
    console.log(table);
    console.log();

    const best = results[0];
    p.log.success(`Recommendation: ${best.provider}/${best.model} at ${best.embPerSec.toLocaleString()} emb/s`);

    // Save results
    const compareResult: CompareResult = {
        timestamp: new Date().toISOString(),
        sampleCount,
        sampleType,
        durationPerProvider: durationSec,
        providers: results,
        recommendation: `${best.provider}/${best.model}`,
    };

    const benchDir = getIndexerStorage().getBenchmarkDir();

    if (!existsSync(benchDir)) {
        mkdirSync(benchDir, { recursive: true });
    }

    const filename = `compare-${Date.now()}.json`;
    const outPath = join(benchDir, filename);
    await Bun.write(outPath, SafeJSON.stringify(compareResult, null, 2));
    p.log.info(`Results saved to ${outPath}`);

    if (opts.output) {
        const customPath = resolve(opts.output);
        const customDir = dirname(customPath);

        if (!existsSync(customDir)) {
            mkdirSync(customDir, { recursive: true });
        }

        await Bun.write(customPath, SafeJSON.stringify(compareResult, null, 2));
        p.log.success(`Also saved to ${customPath}`);
    }

    p.outro("Done");
}

// ── Compare models mode ──

async function runCompareModels(opts: {
    provider?: string;
    duration?: string;
    sampleCount?: string;
    sampleType?: string;
    output?: string;
}): Promise<void> {
    const provider = opts.provider ?? "ollama";
    const durationSec = Number.parseInt(opts.duration ?? "30", 10);
    const sampleCount = Number.parseInt(opts.sampleCount ?? "500", 10);
    const sampleType = (opts.sampleType ?? "mail") as SampleType;

    p.intro(pc.bgCyan(pc.white(` benchmark --compare-models (${provider}) `)));

    const spinner = p.spinner();
    spinner.start(`Discovering ${provider} embedding models...`);

    // Get models for this provider
    const allProviders = await discoverProviders(sampleType);
    const models = allProviders.filter((d) => d.provider === provider);

    if (models.length === 0) {
        spinner.stop("No models found");
        p.log.error(`No embedding models found for provider "${provider}". Is it running?`);
        process.exitCode = 1;
        return;
    }

    spinner.stop(`Found ${models.length} model${models.length === 1 ? "" : "s"}`);

    p.log.info(`Generating ${sampleCount} ${sampleType} sample texts...`);
    const sampleTexts = generateSampleTexts(sampleCount, sampleType);

    p.log.info(`Running ${durationSec}s benchmark per model\n`);

    const results: ProviderBenchResult[] = [];

    for (const m of models) {
        const sp = p.spinner();
        sp.start(`Benchmarking ${m.model}...`);

        try {
            const result = await benchProvider({
                provider: m.provider,
                model: m.model,
                sampleTexts,
                durationMs: durationSec * 1000,
                gpu: m.gpu,
            });
            results.push(result);
            sp.stop(`${m.model}: ${result.embPerSec} emb/s (${result.totalEmbedded.toLocaleString()} total)`);
        } catch (err) {
            sp.stop(`${m.model}: FAILED - ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    if (results.length === 0) {
        p.log.error("All models failed.");
        process.exitCode = 1;
        return;
    }

    results.sort((a, b) => b.embPerSec - a.embPerSec);

    const rows = results.map((r, i) => {
        const bullet = i === 0 ? "\u25CF" : "\u25CB";
        return [`${bullet} ${r.model}`, r.embPerSec.toLocaleString(), String(r.dimensions), r.estimate300k, r.gpu];
    });

    const table = formatTable(rows, ["Model", "emb/s", "Dims", "300K est.", "GPU"], {
        alignRight: [1, 2],
    });

    console.log();
    console.log(table);
    console.log();

    const best = results[0];
    p.log.success(`Best model: ${best.model} at ${best.embPerSec.toLocaleString()} emb/s`);

    if (opts.output) {
        const outPath = resolve(opts.output);
        const outDir = dirname(outPath);

        if (!existsSync(outDir)) {
            mkdirSync(outDir, { recursive: true });
        }

        await Bun.write(outPath, SafeJSON.stringify({ provider, models: results }, null, 2));
        p.log.success(`Results saved to ${outPath}`);
    }

    p.outro("Done");
}

// ── Directory benchmark mode (original) ──

async function runDirBenchmark(
    dir: string,
    opts: {
        output?: string;
        provider?: string;
        model?: string;
        embed?: boolean;
    }
): Promise<void> {
    const absDir = resolve(dir);

    if (!existsSync(absDir)) {
        p.log.error(`Directory not found: ${absDir}`);
        process.exit(1);
    }

    p.intro(pc.bgCyan(pc.white(` benchmark ${basename(absDir)} `)));

    // Clean up stale bench_ dirs from previous crashed runs
    getIndexerStorage().cleanStaleDirs("bench_");

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
                embeddingsPerSec: embedMs > 0 ? Math.round((stats.embeddingsGenerated / embedMs) * 1000) : 0,
            },
            search: {
                queries: BENCHMARK_QUERIES,
                latencies: latencies.map((l) => Math.round(l * 100) / 100),
                avgLatencyMs: Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100,
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
        const indexDir = getIndexerStorage().getIndexDir(benchName);

        if (existsSync(indexDir)) {
            rmSync(indexDir, { recursive: true, force: true });
        }

        p.outro("Done");
    } catch (err) {
        p.log.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
    }
}
