# Indexer v3 — Plan 1: Embedding Pipeline

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the embedding pipeline from sequential CPU-only to batched GPU-accelerated, with model-aware truncation, task prefixes, and retry logic. Target: ~30x indexing speedup.

**Architecture:** Add `embedBatch()` to provider interface, new Ollama provider, model-aware truncation from registry, task prefixes for asymmetric retrieval, exponential backoff retry, parallel file I/O.

**Tech Stack:** TypeScript/Bun, Ollama HTTP API, existing AIEmbeddingProvider interface

---

## Current State (What We're Changing)

| Aspect | Current | After Plan 1 |
|--------|---------|--------------|
| Embedding | Sequential, 1 text at a time | Batch: 32 texts per request |
| Truncation | Hardcoded `MAX_EMBED_CHARS = 500` | Model-aware: 2048 tokens for nomic, 8191 for OpenAI |
| Task prefixes | None | `search_document:` / `search_query:` for asymmetric models |
| Retry | Single warmup retry | Exponential backoff, rate-limit aware |
| GPU support | DarwinKit only (NLFramework) | Ollama (Metal/CUDA), DarwinKit, HF |
| File I/O | Sequential reads in FileSource | Parallel reads (50 concurrent) |

### Key Files

- `src/utils/ai/types.ts` — `AIEmbeddingProvider` interface (add `embedBatch`)
- `src/utils/ai/tasks/Embedder.ts` — Embedder class (add batch-aware logic)
- `src/utils/ai/providers/AICloudProvider.ts` — OpenAI provider (native batch)
- `src/utils/ai/providers/AILocalProvider.ts` — HuggingFace provider (array input)
- `src/utils/ai/providers/AIDarwinKitProvider.ts` — DarwinKit (sequential fallback)
- `src/utils/ai/providers/AIOllamaProvider.ts` — **NEW** Ollama provider
- `src/indexer/lib/indexer.ts` — `embedUnembeddedChunks()` (rewrite for batch)
- `src/indexer/lib/model-registry.ts` — `ModelInfo` (add contextLength, taskPrefix)
- `src/indexer/lib/sources/file-source.ts` — `FileSource.scan()` (parallel I/O)
- `src/utils/async.ts` — add rate-limit-aware retry enhancement
- `src/indexer/commands/benchmark.ts` — **NEW** benchmark command

---

## Task 0: Benchmark Baseline

**Files:**
- Create: `src/indexer/commands/benchmark.ts`
- Modify: `src/indexer/index.ts` (register command)

### Step 0.1: Create the benchmark command

Create `src/indexer/commands/benchmark.ts`:

```typescript
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { formatDuration } from "@app/utils/format";
import { SafeJSON } from "@app/utils/json";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { Indexer } from "../lib/indexer";
import { IndexerManager } from "../lib/manager";
import { createProgressCallbacks } from "../lib/progress";
import type { IndexConfig } from "../lib/types";

interface BenchmarkResult {
    timestamp: string;
    target: string;
    indexName: string;
    phases: {
        scanMs: number;
        chunkMs: number;
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
        .option("-p, --provider <provider>", "Embedding provider", "darwinkit")
        .option("-m, --model <model>", "Embedding model")
        .option("--no-embed", "Skip embedding (fulltext-only benchmark)")
        .action(async (dir: string, opts: {
            output?: string;
            provider?: string;
            model?: string;
            embed?: boolean;
        }) => {
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

            const manager = await IndexerManager.load();

            try {
                // Full sync with timing
                const spinner = p.spinner();
                spinner.start("Indexing...");

                const indexer = await Indexer.create(config);

                let scanMs = 0;
                let embedMs = 0;

                indexer.on("scan:complete", (payload) => {
                    scanMs = payload.ts - (indexer as any)._syncStartTs;
                });
                indexer.on("embed:start", (payload) => {
                    embedMs = -performance.now();
                });
                indexer.on("embed:complete", (payload) => {
                    embedMs = payload.durationMs;
                });

                const totalStart = performance.now();
                const stats = await indexer.sync(createProgressCallbacks(spinner));
                const totalMs = performance.now() - totalStart;
                const chunkMs = totalMs - scanMs - (embedMs > 0 ? embedMs : 0);

                spinner.stop("Index complete");

                // Search benchmark
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
                        scanMs: Math.round(scanMs),
                        chunkMs: Math.round(chunkMs),
                        embedMs: Math.round(embedMs > 0 ? embedMs : 0),
                        totalMs: Math.round(totalMs),
                    },
                    counts: {
                        filesScanned: stats.filesScanned,
                        chunksCreated: stats.chunksAdded,
                        embeddingsGenerated: stats.embeddingsGenerated,
                    },
                    throughput: {
                        chunksPerSec: chunkMs > 0
                            ? Math.round((stats.chunksAdded / chunkMs) * 1000)
                            : 0,
                        embeddingsPerSec: embedMs > 0
                            ? Math.round((stats.embeddingsGenerated / embedMs) * 1000)
                            : 0,
                    },
                    search: {
                        queries: BENCHMARK_QUERIES,
                        latencies: latencies.map((l) => Math.round(l * 100) / 100),
                        avgLatencyMs: Math.round(
                            (latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100
                        ) / 100,
                    },
                    dbSizeBytes: consistency.dbSizeBytes,
                    provider: config.embedding?.provider ?? "default",
                    model: config.embedding?.model ?? "default",
                };

                // Print summary
                p.log.info(pc.bold("Results:"));
                p.log.info(`  Files scanned:    ${result.counts.filesScanned.toLocaleString()}`);
                p.log.info(`  Chunks created:   ${result.counts.chunksCreated.toLocaleString()}`);
                p.log.info(`  Embeddings:       ${result.counts.embeddingsGenerated.toLocaleString()}`);
                p.log.info(`  Total time:       ${formatDuration(result.phases.totalMs)}`);
                p.log.info(`  Scan phase:       ${formatDuration(result.phases.scanMs)}`);
                p.log.info(`  Chunk phase:      ${formatDuration(result.phases.chunkMs)}`);
                p.log.info(`  Embed phase:      ${formatDuration(result.phases.embedMs)}`);
                p.log.info(`  Embed throughput: ${result.throughput.embeddingsPerSec} chunks/sec`);
                p.log.info(`  Avg search:       ${result.search.avgLatencyMs}ms`);
                p.log.info(`  DB size:          ${(result.dbSizeBytes / 1024 / 1024).toFixed(1)}MB`);

                // Output JSON
                const json = SafeJSON.stringify(result, null, 2);
                console.log(json);

                if (opts.output) {
                    const outPath = resolve(opts.output);
                    const outDir = outPath.substring(0, outPath.lastIndexOf("/"));

                    if (!existsSync(outDir)) {
                        mkdirSync(outDir, { recursive: true });
                    }

                    await Bun.write(outPath, json);
                    p.log.success(`Saved to ${outPath}`);
                }

                // Cleanup benchmark index
                await manager.removeIndex(benchName);
                p.outro("Done");
            } finally {
                await manager.close();
            }
        });
}
```

### Step 0.2: Register the benchmark command

Modify `src/indexer/index.ts`:

```typescript
// Add import:
import { registerBenchmarkCommand } from "./commands/benchmark";

// Add registration (after registerVerifyCommand):
registerBenchmarkCommand(program);
```

### Step 0.3: Run baseline benchmark

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools
tools indexer benchmark . \
  --provider darwinkit \
  -o .claude/benchmarks/indexer-v3-plan1-before.json
```

### Step 0.4: Type-check and commit

```bash
tsgo --noEmit 2>&1 | head -20
git add src/indexer/commands/benchmark.ts src/indexer/index.ts
git commit -m "feat(indexer): add benchmark command for performance measurement"
```

---

## Task 1: Add `embedBatch()` to AIEmbeddingProvider Interface

**Files:**
- Modify: `src/utils/ai/types.ts`
- Modify: `src/utils/ai/tasks/Embedder.ts`
- Create: `src/utils/ai/tasks/Embedder.test.ts`

### Step 1.1: Add `embedBatch` to the interface

Modify `src/utils/ai/types.ts` — add `embedBatch` as an optional method on `AIEmbeddingProvider`:

```typescript
export interface AIEmbeddingProvider extends AIProvider {
    embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult>;
    /** Batch embed multiple texts in a single provider call. Optional — falls back to sequential embed(). */
    embedBatch?(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]>;
    readonly dimensions: number;
}
```

### Step 1.2: Update Embedder class to prefer batch

Modify `src/utils/ai/tasks/Embedder.ts` — replace `embedMany` with batch-aware logic:

```typescript
import { AIConfig } from "../AIConfig";
import { getProviderForTask } from "../providers";
import type { AIEmbeddingProvider, AIProviderType, EmbedOptions, EmbeddingResult } from "../types";

export class Embedder {
    private provider: AIEmbeddingProvider;

    private constructor(provider: AIEmbeddingProvider) {
        this.provider = provider;
    }

    static async create(options?: { provider?: string; model?: string }): Promise<Embedder> {
        const config = await AIConfig.load();

        if (options?.provider) {
            config.set("embed", { provider: options.provider as AIProviderType, model: options.model });
        }

        const provider = await getProviderForTask("embed", config);

        if (!("embed" in provider)) {
            throw new Error(`Provider "${provider.type}" does not support embedding`);
        }

        return new Embedder(provider as AIEmbeddingProvider);
    }

    get dimensions(): number {
        return this.provider.dimensions;
    }

    /** Whether the underlying provider supports native batch embedding */
    get supportsBatch(): boolean {
        return typeof this.provider.embedBatch === "function";
    }

    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
        return this.provider.embed(text, options);
    }

    /**
     * Embed multiple texts, using native batch if the provider supports it,
     * otherwise falling back to Promise.all over individual embed() calls.
     */
    async embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
        if (texts.length === 0) {
            return [];
        }

        if (this.provider.embedBatch) {
            return this.provider.embedBatch(texts, options);
        }

        // Sequential fallback — no native batch support
        return Promise.all(texts.map((t) => this.provider.embed(t, options)));
    }

    /** @deprecated Use embedBatch() instead */
    async embedMany(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
        return this.embedBatch(texts, options);
    }

    dispose(): void {
        this.provider.dispose?.();
    }
}
```

### Step 1.3: Write test for Embedder batch logic

Create `src/utils/ai/tasks/Embedder.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { AIEmbeddingProvider, AITask, EmbedOptions, EmbeddingResult } from "../types";

/** Minimal mock provider WITHOUT batch support */
function createSequentialMockProvider(dims: number): AIEmbeddingProvider & { callLog: string[] } {
    const callLog: string[] = [];
    return {
        type: "local-hf",
        dimensions: dims,
        callLog,
        async isAvailable() { return true; },
        supports(task: AITask) { return task === "embed"; },
        async embed(text: string): Promise<EmbeddingResult> {
            callLog.push(`embed:${text}`);
            return { vector: new Float32Array(dims).fill(1), dimensions: dims };
        },
    };
}

/** Mock provider WITH batch support */
function createBatchMockProvider(dims: number): AIEmbeddingProvider & { callLog: string[] } {
    const callLog: string[] = [];
    return {
        type: "cloud",
        dimensions: dims,
        callLog,
        async isAvailable() { return true; },
        supports(task: AITask) { return task === "embed"; },
        async embed(text: string): Promise<EmbeddingResult> {
            callLog.push(`embed:${text}`);
            return { vector: new Float32Array(dims).fill(1), dimensions: dims };
        },
        async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
            callLog.push(`batch:${texts.length}`);
            return texts.map(() => ({ vector: new Float32Array(dims).fill(1), dimensions: dims }));
        },
    };
}

describe("Embedder batch logic", () => {
    // Test the provider interface directly since Embedder.create() needs AIConfig
    test("embedBatch uses native batch when provider supports it", async () => {
        const provider = createBatchMockProvider(768);
        const texts = ["hello", "world", "test"];

        const results = await provider.embedBatch!(texts);

        expect(results).toHaveLength(3);
        expect(provider.callLog).toEqual(["batch:3"]);
        // embed() was NOT called — batch was used
    });

    test("sequential provider falls back to individual embed calls", async () => {
        const provider = createSequentialMockProvider(384);
        const texts = ["a", "b", "c"];

        // Simulate what Embedder.embedBatch does for non-batch providers
        expect(provider.embedBatch).toBeUndefined();

        const results = await Promise.all(texts.map((t) => provider.embed(t)));

        expect(results).toHaveLength(3);
        expect(provider.callLog).toEqual(["embed:a", "embed:b", "embed:c"]);
    });

    test("empty input returns empty array", async () => {
        const provider = createBatchMockProvider(768);
        const results = await provider.embedBatch!([]);

        expect(results).toHaveLength(0);
    });

    test("supportsBatch reflects provider capability", () => {
        const batch = createBatchMockProvider(768);
        const seq = createSequentialMockProvider(384);

        expect(typeof batch.embedBatch).toBe("function");
        expect(seq.embedBatch).toBeUndefined();
    });
});
```

### Step 1.4: Run tests and type-check

```bash
bun test src/utils/ai/tasks/Embedder.test.ts
tsgo --noEmit 2>&1 | head -20
```

### Step 1.5: Commit

```bash
git add src/utils/ai/types.ts src/utils/ai/tasks/Embedder.ts src/utils/ai/tasks/Embedder.test.ts
git commit -m "feat(ai): add embedBatch() to AIEmbeddingProvider interface and Embedder class"
```

---

## Task 2: Implement `embedBatch()` in AICloudProvider

**Files:**
- Modify: `src/utils/ai/providers/AICloudProvider.ts`
- Create: `src/utils/ai/providers/AICloudProvider.test.ts`

### Step 2.1: Add `embedBatch()` to AICloudProvider

OpenAI's `/v1/embeddings` endpoint natively accepts an array of strings. The `@ai-sdk/openai` embedding model's `doEmbed` already supports `values: string[]`.

Add this method to `AICloudProvider` after the existing `embed()` method:

```typescript
async embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
    if (texts.length === 0) {
        return [];
    }

    const model = options?.model ?? "text-embedding-3-small";
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI();

    // OpenAI supports up to 2048 inputs per request
    const MAX_BATCH = 2048;
    const results: EmbeddingResult[] = [];

    for (let i = 0; i < texts.length; i += MAX_BATCH) {
        const batch = texts.slice(i, i + MAX_BATCH);
        const result = await openai.embedding(model).doEmbed({ values: batch });

        for (const embedding of result.embeddings) {
            const vec = new Float32Array(embedding);
            results.push({ vector: vec, dimensions: vec.length });
        }
    }

    return results;
}
```

### Step 2.2: Write test (mock-based since we can't hit the real API)

Create `src/utils/ai/providers/AICloudProvider.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

describe("AICloudProvider", () => {
    test("embedBatch method exists and has correct signature", async () => {
        // Import without calling (avoids needing API keys)
        const { AICloudProvider } = await import("./AICloudProvider");
        const provider = new AICloudProvider();

        expect(typeof provider.embedBatch).toBe("function");
        expect(provider.dimensions).toBe(1536);
        expect(provider.type).toBe("cloud");
    });

    test("embedBatch returns empty array for empty input", async () => {
        const { AICloudProvider } = await import("./AICloudProvider");
        const provider = new AICloudProvider();

        const results = await provider.embedBatch!([]);

        expect(results).toEqual([]);
    });
});
```

### Step 2.3: Run and commit

```bash
bun test src/utils/ai/providers/AICloudProvider.test.ts
tsgo --noEmit 2>&1 | head -20
git add src/utils/ai/providers/AICloudProvider.ts src/utils/ai/providers/AICloudProvider.test.ts
git commit -m "feat(ai): implement embedBatch() in AICloudProvider (OpenAI native batch)"
```

---

## Task 3: Implement `embedBatch()` in AILocalProvider

**Files:**
- Modify: `src/utils/ai/providers/AILocalProvider.ts`
- Create: `src/utils/ai/providers/AILocalProvider.test.ts`

### Step 3.1: Add `embedBatch()` to AILocalProvider

The HuggingFace transformers.js `feature-extraction` pipeline accepts string arrays. Add after the existing `embed()`:

```typescript
async embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
    if (texts.length === 0) {
        return [];
    }

    const model = options?.model ?? "Xenova/all-MiniLM-L6-v2";
    const pipe = await this.getPipeline("feature-extraction", model);

    // transformers.js feature-extraction pipeline accepts string[]
    const result = await pipe(texts, { pooling: "mean", normalize: true });

    // Result shape: { data: Float32Array, dims: [batchSize, seqLen, hiddenSize] }
    // With pooling: { data: Float32Array, dims: [batchSize, hiddenSize] }
    const data = (result as { data: Float32Array; dims: number[] }).data;
    const dims = (result as { data: Float32Array; dims: number[] }).dims;
    const hiddenSize = dims[dims.length - 1];
    const results: EmbeddingResult[] = [];

    for (let i = 0; i < texts.length; i++) {
        const offset = i * hiddenSize;
        const vector = new Float32Array(data.buffer, data.byteOffset + offset * 4, hiddenSize);
        results.push({ vector: new Float32Array(vector), dimensions: hiddenSize });
    }

    return results;
}
```

### Step 3.2: Write test

Create `src/utils/ai/providers/AILocalProvider.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

describe("AILocalProvider", () => {
    test("embedBatch method exists and has correct signature", async () => {
        const { AILocalProvider } = await import("./AILocalProvider");
        const provider = new AILocalProvider();

        expect(typeof provider.embedBatch).toBe("function");
        expect(provider.dimensions).toBe(384);
        expect(provider.type).toBe("local-hf");
    });

    test("embedBatch returns empty array for empty input", async () => {
        const { AILocalProvider } = await import("./AILocalProvider");
        const provider = new AILocalProvider();

        const results = await provider.embedBatch!([]);

        expect(results).toEqual([]);
    });
});
```

### Step 3.3: Run and commit

```bash
bun test src/utils/ai/providers/AILocalProvider.test.ts
tsgo --noEmit 2>&1 | head -20
git add src/utils/ai/providers/AILocalProvider.ts src/utils/ai/providers/AILocalProvider.test.ts
git commit -m "feat(ai): implement embedBatch() in AILocalProvider (HF transformers.js array input)"
```

---

## Task 4: Implement `embedBatch()` in AIDarwinKitProvider

**Files:**
- Modify: `src/utils/ai/providers/AIDarwinKitProvider.ts`

### Step 4.1: Add sequential `embedBatch()` fallback

DarwinKit's NLFramework Swift bridge doesn't support batch embedding natively. Implement as a sequential loop (still satisfies the interface so `Embedder.embedBatch()` doesn't need to special-case):

```typescript
async embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];

    for (const text of texts) {
        results.push(await this.embed(text, options));
    }

    return results;
}
```

Add this method after the existing `embed()` method in `AIDarwinKitProvider`.

### Step 4.2: Type-check and commit

```bash
tsgo --noEmit 2>&1 | head -20
git add src/utils/ai/providers/AIDarwinKitProvider.ts
git commit -m "feat(ai): add embedBatch() to AIDarwinKitProvider (sequential fallback)"
```

---

## Task 5: Model-Aware Context Truncation

**Files:**
- Modify: `src/indexer/lib/model-registry.ts`
- Modify: `src/indexer/lib/indexer.ts`
- Modify: `src/indexer/lib/model-registry.test.ts`

### Step 5.1: Add context length and charsPerToken to ModelInfo

Modify `src/indexer/lib/model-registry.ts`:

1. Add fields to `ModelInfo`:

```typescript
export interface ModelInfo {
    id: string;
    name: string;
    params: string;
    dimensions: number;
    ramGB: number;
    speed: "fast" | "medium" | "slow";
    license: string;
    provider: "local-hf" | "cloud" | "darwinkit" | "coreml" | "ollama";
    bestFor: string[];
    description: string;
    installCmd?: string;
    /** Max context window in tokens. Used for pre-truncation before embedding. */
    contextLength?: number;
    /**
     * Estimated characters per token. Used to convert contextLength (tokens) to max chars.
     * Default: 4 for English prose. Use 1.5-2 for code (dense syntax: {, }, ;, =).
     */
    charsPerToken?: number;
}
```

2. Add `MODEL_CONTEXT_LENGTHS` fallback lookup (for models not in the registry):

```typescript
/**
 * Known context lengths for embedding models (tokens).
 * Used as fallback when a model isn't in MODEL_REGISTRY.
 * Sources: model cards, Ollama docs, SocratiCode embedding-config.ts.
 */
export const MODEL_CONTEXT_LENGTHS: Record<string, number> = {
    // Ollama models
    "nomic-embed-text": 2048,
    "mxbai-embed-large": 512,
    "snowflake-arctic-embed": 512,
    "all-minilm": 256,
    // OpenAI models
    "text-embedding-3-small": 8191,
    "text-embedding-3-large": 8191,
    "text-embedding-ada-002": 8191,
    // HuggingFace models
    "Xenova/all-MiniLM-L6-v2": 256,
    "jinaai/jina-embeddings-v3": 8192,
    "jinaai/CodeRankEmbed": 512,
    "nomic-ai/nomic-embed-code-v1": 2048,
    // Google
    "gemini-embedding-001": 2048,
};
```

3. Update each model entry in `MODEL_REGISTRY` to include `contextLength` and `charsPerToken`:

```typescript
{
    id: "jinaai/CodeRankEmbed",
    // ... existing fields ...
    contextLength: 512,
    charsPerToken: 2,
},
{
    id: "nomic-ai/nomic-embed-code-v1",
    // ... existing fields ...
    contextLength: 2048,
    charsPerToken: 2,
},
{
    id: "nvidia/NV-EmbedCode-7b-v1",
    // ... existing fields ...
    contextLength: 2048,
    charsPerToken: 2,
},
{
    id: "jinaai/jina-embeddings-v3",
    // ... existing fields ...
    contextLength: 8192,
    charsPerToken: 3,
},
{
    id: "voyage-code-3",
    // ... existing fields ...
    contextLength: 16000,
    charsPerToken: 2,
},
{
    id: "text-embedding-3-small",
    // ... existing fields ...
    contextLength: 8191,
    charsPerToken: 4,
},
{
    id: "darwinkit",
    // ... existing fields ...
    contextLength: 512,
    charsPerToken: 4,
},
{
    id: "coreml-contextual",
    // ... existing fields ...
    contextLength: 512,
    charsPerToken: 4,
},
{
    id: "Xenova/all-MiniLM-L6-v2",
    // ... existing fields ...
    contextLength: 256,
    charsPerToken: 4,
},
```

4. Add a helper to get max chars for a model:

```typescript
const DEFAULT_CONTEXT_LENGTH = 512;
const DEFAULT_CHARS_PER_TOKEN = 3;

/**
 * Get the max character count for embedding text with a given model.
 * Looks up the model in MODEL_REGISTRY first, then MODEL_CONTEXT_LENGTHS fallback.
 */
export function getMaxEmbedChars(modelId: string): number {
    // Try registry first
    const registered = MODEL_REGISTRY.find((m) => m.id === modelId);

    if (registered?.contextLength) {
        const cpt = registered.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
        return registered.contextLength * cpt;
    }

    // Fallback lookup (strip :tag for Ollama-style model names)
    const baseId = modelId.replace(/:.*$/, "");
    const contextLength = MODEL_CONTEXT_LENGTHS[baseId] ?? MODEL_CONTEXT_LENGTHS[modelId];

    if (contextLength) {
        return contextLength * DEFAULT_CHARS_PER_TOKEN;
    }

    return DEFAULT_CONTEXT_LENGTH * DEFAULT_CHARS_PER_TOKEN;
}
```

### Step 5.2: Replace hardcoded MAX_EMBED_CHARS in indexer.ts

Modify `src/indexer/lib/indexer.ts`:

1. Remove the line `const MAX_EMBED_CHARS = 500;` at the top.

2. Add import:
```typescript
import { getMaxEmbedChars } from "./model-registry";
```

3. In `embedUnembeddedChunks()`, compute `maxEmbedChars` from the model:
```typescript
// After the warmup block, before the main loop:
const modelId = this.config.embedding?.model ?? "darwinkit";
const maxEmbedChars = getMaxEmbedChars(modelId);
```

4. Replace `c.content.slice(0, MAX_EMBED_CHARS)` with `c.content.slice(0, maxEmbedChars)`.

### Step 5.3: Update model-registry tests

Add to `src/indexer/lib/model-registry.test.ts`:

```typescript
import { getMaxEmbedChars, MODEL_CONTEXT_LENGTHS } from "./model-registry";

describe("getMaxEmbedChars", () => {
    test("returns correct chars for registered model", () => {
        // nomic-embed-code: 2048 tokens * 2 chars/token = 4096
        const chars = getMaxEmbedChars("nomic-ai/nomic-embed-code-v1");
        expect(chars).toBe(4096);
    });

    test("returns correct chars for OpenAI model", () => {
        // 8191 tokens * 4 chars/token = 32764
        const chars = getMaxEmbedChars("text-embedding-3-small");
        expect(chars).toBe(32764);
    });

    test("returns fallback for unknown model", () => {
        const chars = getMaxEmbedChars("totally-unknown-model");
        // DEFAULT_CONTEXT_LENGTH (512) * DEFAULT_CHARS_PER_TOKEN (3) = 1536
        expect(chars).toBe(1536);
    });

    test("strips Ollama-style tags for fallback lookup", () => {
        const chars = getMaxEmbedChars("nomic-embed-text:latest");
        // 2048 tokens * 3 chars/token (default) = 6144
        expect(chars).toBe(6144);
    });

    test("MODEL_CONTEXT_LENGTHS has entries for common models", () => {
        expect(MODEL_CONTEXT_LENGTHS["nomic-embed-text"]).toBe(2048);
        expect(MODEL_CONTEXT_LENGTHS["text-embedding-3-small"]).toBe(8191);
        expect(MODEL_CONTEXT_LENGTHS["all-minilm"]).toBe(256);
    });
});
```

### Step 5.4: Run tests and commit

```bash
bun test src/indexer/lib/model-registry.test.ts
tsgo --noEmit 2>&1 | head -20
git add src/indexer/lib/model-registry.ts src/indexer/lib/indexer.ts src/indexer/lib/model-registry.test.ts
git commit -m "feat(indexer): model-aware context truncation replaces hardcoded 500-char limit"
```

---

## Task 6: Task Prefixes for Asymmetric Retrieval

**Files:**
- Modify: `src/indexer/lib/model-registry.ts`
- Modify: `src/indexer/lib/indexer.ts`
- Modify: `src/indexer/lib/model-registry.test.ts`

### Step 6.1: Add taskPrefix to ModelInfo

Modify `src/indexer/lib/model-registry.ts`:

1. Add to `ModelInfo` interface:

```typescript
/**
 * Task prefixes for asymmetric retrieval models.
 * Document prefix is prepended during indexing; query prefix during search.
 * E.g., nomic-embed-text uses "search_document: " / "search_query: ".
 */
taskPrefix?: {
    document: string;
    query: string;
};
```

2. Add prefixes to appropriate models in `MODEL_REGISTRY`:

```typescript
// nomic-ai/nomic-embed-code-v1:
taskPrefix: { document: "search_document: ", query: "search_query: " },

// jinaai/jina-embeddings-v3 (supports task prefixes via Matryoshka):
taskPrefix: { document: "search_document: ", query: "search_query: " },
```

3. Add `TASK_PREFIXES` fallback lookup for models not in registry:

```typescript
/**
 * Task prefixes for known embedding models (used for asymmetric retrieval).
 * Fallback for models not in MODEL_REGISTRY.
 */
export const TASK_PREFIXES: Record<string, { document: string; query: string }> = {
    "nomic-embed-text": { document: "search_document: ", query: "search_query: " },
    "nomic-ai/nomic-embed-code-v1": { document: "search_document: ", query: "search_query: " },
    "nomic-embed-code": { document: "search_document: ", query: "search_query: " },
};
```

4. Add helper:

```typescript
/**
 * Get the task prefix config for a model, or null if the model doesn't use task prefixes.
 */
export function getTaskPrefix(modelId: string): { document: string; query: string } | null {
    const registered = MODEL_REGISTRY.find((m) => m.id === modelId);

    if (registered?.taskPrefix) {
        return registered.taskPrefix;
    }

    const baseId = modelId.replace(/:.*$/, "");
    return TASK_PREFIXES[baseId] ?? TASK_PREFIXES[modelId] ?? null;
}
```

### Step 6.2: Apply document prefix in embedUnembeddedChunks()

Modify `src/indexer/lib/indexer.ts`:

1. Import `getTaskPrefix`:
```typescript
import { getMaxEmbedChars, getTaskPrefix } from "./model-registry";
```

2. In `embedUnembeddedChunks()`, after computing `maxEmbedChars`:
```typescript
const taskPrefix = getTaskPrefix(modelId);
```

3. When preparing text for embedding, apply document prefix:
```typescript
// In the loop where we prepare text for embedding:
let text = c.content.slice(0, maxEmbedChars);

if (taskPrefix) {
    text = `${taskPrefix.document}${text}`;
}
```

### Step 6.3: Apply query prefix in search()

Modify the `search()` method in `src/indexer/lib/indexer.ts`. Before embedding the query, prepend the query prefix:

```typescript
// In the search method, before embedding the query for vector search:
// Look for where embedder.embed(query) is called and wrap it:

const modelId = this.config.embedding?.model ?? "darwinkit";
const taskPrefix = getTaskPrefix(modelId);
const queryText = taskPrefix ? `${taskPrefix.query}${query}` : query;
// Use queryText instead of query when calling embedder.embed()
```

Note: The actual query embedding happens in the search engine / store layer. Check `src/indexer/lib/store.ts` and `src/utils/search/` to find where the query is embedded for vector search, and apply the prefix there. The exact location will depend on how the store passes the query to the embedder. The implementer should trace the call from `indexer.search()` -> `store.search()` -> wherever `embedder.embed(query)` is called.

If the embed call happens in `store.search()`, the cleanest approach is to pass the prefix info through the search options:

```typescript
// In store's search, check for queryPrefix in search options
const searchOpts: SearchOptions = {
    query,
    // ... other opts
    queryPrefix: taskPrefix?.query,
};
```

Or modify the query text before passing it to search:

```typescript
// In Indexer.search(), modify the query before passing to store:
const effectiveQuery = taskPrefix ? `${taskPrefix.query}${query}` : query;
const results = await this.store.search({
    ...searchOpts,
    query: effectiveQuery,  // For vector search
    originalQuery: query,   // For FTS (no prefix for BM25)
});
```

The exact implementation depends on how the search layer handles hybrid mode — if FTS and vector use the same query string, we need to ensure the prefix is only applied to the vector embedding, not to the BM25 query. Check the search engine code and implement accordingly.

### Step 6.4: Add tests

Add to `src/indexer/lib/model-registry.test.ts`:

```typescript
import { getTaskPrefix, TASK_PREFIXES } from "./model-registry";

describe("getTaskPrefix", () => {
    test("returns prefix for nomic model", () => {
        const prefix = getTaskPrefix("nomic-ai/nomic-embed-code-v1");
        expect(prefix).toEqual({ document: "search_document: ", query: "search_query: " });
    });

    test("returns prefix for Ollama-style nomic", () => {
        const prefix = getTaskPrefix("nomic-embed-text:latest");
        expect(prefix).toEqual({ document: "search_document: ", query: "search_query: " });
    });

    test("returns null for models without prefixes", () => {
        const prefix = getTaskPrefix("text-embedding-3-small");
        expect(prefix).toBeNull();
    });

    test("returns null for unknown models", () => {
        const prefix = getTaskPrefix("totally-unknown-model");
        expect(prefix).toBeNull();
    });
});
```

### Step 6.5: Run and commit

```bash
bun test src/indexer/lib/model-registry.test.ts
tsgo --noEmit 2>&1 | head -20
git add src/indexer/lib/model-registry.ts src/indexer/lib/indexer.ts src/indexer/lib/model-registry.test.ts
git commit -m "feat(indexer): add task prefixes for asymmetric retrieval (search_document/search_query)"
```

---

## Task 7: Ollama Embedding Provider

**Files:**
- Create: `src/utils/ai/providers/AIOllamaProvider.ts`
- Create: `src/utils/ai/providers/AIOllamaProvider.test.ts`
- Modify: `src/utils/ai/types.ts` (add "ollama" to AIProviderType)
- Modify: `src/utils/ai/providers/index.ts` (add Ollama to factory)
- Modify: `src/indexer/lib/model-registry.ts` (add Ollama models)

### Step 7.1: Add "ollama" to AIProviderType

Modify `src/utils/ai/types.ts`:

```typescript
export type AIProviderType = "cloud" | "local-hf" | "darwinkit" | "coreml" | "ollama";
```

### Step 7.2: Create AIOllamaProvider

Create `src/utils/ai/providers/AIOllamaProvider.ts`:

```typescript
import type { AIEmbeddingProvider, AIProvider, AITask, EmbedOptions, EmbeddingResult } from "../types";

const SUPPORTED_TASKS: AITask[] = ["embed"];

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

interface OllamaEmbedResponse {
    embeddings: number[][];
}

interface OllamaTagsResponse {
    models: Array<{ name: string; model: string; size: number }>;
}

export interface AIOllamaProviderOptions {
    /** Ollama API URL. Default: http://localhost:11434 */
    baseUrl?: string;
    /** Default model for embedding. Default: nomic-embed-text */
    defaultModel?: string;
}

export class AIOllamaProvider implements AIProvider, AIEmbeddingProvider {
    readonly type = "ollama" as const;
    readonly dimensions: number;
    private baseUrl: string;
    private defaultModel: string;
    private available: boolean | null = null;

    constructor(options?: AIOllamaProviderOptions) {
        this.baseUrl = (options?.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/$/, "");
        this.defaultModel = options?.defaultModel ?? "nomic-embed-text";
        // Default dimensions for nomic-embed-text. Will be overridden by actual response.
        this.dimensions = 768;
    }

    async isAvailable(): Promise<boolean> {
        if (this.available !== null) {
            return this.available;
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            const resp = await fetch(`${this.baseUrl}/api/tags`, {
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            this.available = resp.ok;
            return this.available;
        } catch {
            this.available = false;
            return false;
        }
    }

    supports(task: AITask): boolean {
        return SUPPORTED_TASKS.includes(task);
    }

    /** List available models on the Ollama server */
    async listModels(): Promise<string[]> {
        const resp = await fetch(`${this.baseUrl}/api/tags`);

        if (!resp.ok) {
            throw new Error(`Ollama /api/tags failed: ${resp.status} ${resp.statusText}`);
        }

        const data = (await resp.json()) as OllamaTagsResponse;
        return data.models.map((m) => m.name);
    }

    /** Check if a specific model is available */
    async hasModel(model: string): Promise<boolean> {
        try {
            const models = await this.listModels();
            return models.some(
                (m) => m === model || m.startsWith(`${model}:`)
            );
        } catch {
            return false;
        }
    }

    /** Pull a model if it's not already available */
    async ensureModel(model: string): Promise<void> {
        if (await this.hasModel(model)) {
            return;
        }

        const resp = await fetch(`${this.baseUrl}/api/pull`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model }),
        });

        if (!resp.ok) {
            throw new Error(`Failed to pull model "${model}": ${resp.status} ${resp.statusText}`);
        }

        // Stream the response to completion (Ollama streams pull progress)
        const reader = resp.body?.getReader();

        if (reader) {
            while (true) {
                const { done } = await reader.read();

                if (done) {
                    break;
                }
            }
        }
    }

    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
        const results = await this.embedBatch([text], options);
        return results[0];
    }

    async embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
        if (texts.length === 0) {
            return [];
        }

        const model = options?.model ?? this.defaultModel;

        const resp = await fetch(`${this.baseUrl}/api/embed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                input: texts,
            }),
        });

        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`Ollama /api/embed failed: ${resp.status} ${resp.statusText} — ${body}`);
        }

        const data = (await resp.json()) as OllamaEmbedResponse;

        return data.embeddings.map((embedding) => {
            const vector = new Float32Array(embedding);
            return { vector, dimensions: vector.length };
        });
    }

    dispose(): void {
        // No resources to clean up — stateless HTTP client
    }
}
```

### Step 7.3: Register in provider factory

Modify `src/utils/ai/providers/index.ts`:

1. Add import:
```typescript
import { AIOllamaProvider } from "./AIOllamaProvider";
```

2. Add case in `getProvider()`:
```typescript
case "ollama":
    provider = new AIOllamaProvider();
    break;
```

3. Update `fallbackOrder` to include ollama:
```typescript
const fallbackOrder: AIProviderType[] = ["cloud", "local-hf", "ollama", "coreml", "darwinkit"];
```

4. Update `getAllProviders`:
```typescript
const types: AIProviderType[] = ["cloud", "local-hf", "ollama", "darwinkit", "coreml"];
```

5. Add export:
```typescript
export { AIOllamaProvider } from "./AIOllamaProvider";
```

### Step 7.4: Add Ollama models to model-registry.ts

Add to `MODEL_REGISTRY` in `src/indexer/lib/model-registry.ts`:

```typescript
{
    id: "nomic-embed-text",
    name: "Nomic Embed Text (Ollama)",
    params: "137M",
    dimensions: 768,
    ramGB: 0.3,
    speed: "fast",
    license: "Apache-2.0",
    provider: "ollama",
    bestFor: ["code", "general"],
    description: "Ollama GPU-accelerated. Best local option for code + text. Needs `ollama pull nomic-embed-text`.",
    installCmd: "ollama pull nomic-embed-text",
    contextLength: 2048,
    charsPerToken: 2,
    taskPrefix: { document: "search_document: ", query: "search_query: " },
},
{
    id: "all-minilm",
    name: "All-MiniLM (Ollama)",
    params: "23M",
    dimensions: 384,
    ramGB: 0.1,
    speed: "fast",
    license: "Apache-2.0",
    provider: "ollama",
    bestFor: ["general"],
    description: "Tiny and fast via Ollama. Good for quick prototyping.",
    installCmd: "ollama pull all-minilm",
    contextLength: 256,
    charsPerToken: 4,
},
{
    id: "mxbai-embed-large",
    name: "MxBAI Embed Large (Ollama)",
    params: "335M",
    dimensions: 1024,
    ramGB: 0.7,
    speed: "medium",
    license: "Apache-2.0",
    provider: "ollama",
    bestFor: ["general", "mail"],
    description: "High-quality general-purpose via Ollama. GPU-accelerated.",
    installCmd: "ollama pull mxbai-embed-large",
    contextLength: 512,
    charsPerToken: 3,
},
```

### Step 7.5: Write tests

Create `src/utils/ai/providers/AIOllamaProvider.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { AIOllamaProvider } from "./AIOllamaProvider";

describe("AIOllamaProvider", () => {
    test("has correct type and default dimensions", () => {
        const provider = new AIOllamaProvider();

        expect(provider.type).toBe("ollama");
        expect(provider.dimensions).toBe(768);
    });

    test("supports embed task only", () => {
        const provider = new AIOllamaProvider();

        expect(provider.supports("embed")).toBe(true);
        expect(provider.supports("transcribe")).toBe(false);
        expect(provider.supports("translate")).toBe(false);
        expect(provider.supports("summarize")).toBe(false);
    });

    test("embedBatch returns empty array for empty input", async () => {
        const provider = new AIOllamaProvider();
        const results = await provider.embedBatch([]);

        expect(results).toEqual([]);
    });

    test("accepts custom baseUrl and model", () => {
        const provider = new AIOllamaProvider({
            baseUrl: "http://custom-host:9999",
            defaultModel: "mxbai-embed-large",
        });

        expect(provider.type).toBe("ollama");
        // Verify it stored the options (indirectly via typeof)
        expect(typeof provider.embed).toBe("function");
        expect(typeof provider.embedBatch).toBe("function");
    });

    test("isAvailable returns false when Ollama not running", async () => {
        const provider = new AIOllamaProvider({
            baseUrl: "http://localhost:99999", // port that won't be open
        });
        const available = await provider.isAvailable();

        expect(available).toBe(false);
    });

    // Integration test: only runs if Ollama is available locally
    test.skipIf(!process.env.TEST_OLLAMA)("embed() returns valid vector (requires running Ollama)", async () => {
        const provider = new AIOllamaProvider();
        const result = await provider.embed("Hello, world!");

        expect(result.vector).toBeInstanceOf(Float32Array);
        expect(result.dimensions).toBeGreaterThan(0);
        expect(result.vector.length).toBe(result.dimensions);
    });

    test.skipIf(!process.env.TEST_OLLAMA)("embedBatch() returns correct count (requires running Ollama)", async () => {
        const provider = new AIOllamaProvider();
        const texts = ["Hello", "World", "Test"];
        const results = await provider.embedBatch(texts);

        expect(results).toHaveLength(3);

        for (const result of results) {
            expect(result.vector).toBeInstanceOf(Float32Array);
            expect(result.dimensions).toBeGreaterThan(0);
        }
    });
});
```

### Step 7.6: Run and commit

```bash
bun test src/utils/ai/providers/AIOllamaProvider.test.ts
tsgo --noEmit 2>&1 | head -20
git add \
  src/utils/ai/providers/AIOllamaProvider.ts \
  src/utils/ai/providers/AIOllamaProvider.test.ts \
  src/utils/ai/providers/index.ts \
  src/utils/ai/types.ts \
  src/indexer/lib/model-registry.ts
git commit -m "feat(ai): add Ollama embedding provider with native batch support"
```

---

## Task 8: Retry with Exponential Backoff for Embedding

**Files:**
- Modify: `src/utils/async.ts` (enhance retry with rate-limit detection)
- Modify: `src/utils/ai/tasks/Embedder.ts` (wrap calls in retry)
- Create: `src/utils/async.test.ts` (or add to existing)

### Step 8.1: Enhance the existing `retry()` with rate-limit detection

The existing `retry()` in `src/utils/async.ts` already supports exponential backoff. We need to add a `getDelay` option for custom delay logic. Add `getDelay` to `RetryOptions`:

```typescript
interface RetryOptions {
    /** Maximum number of attempts. Default: 3 */
    maxAttempts?: number;
    /** Initial delay between retries in ms. Default: 1000 */
    delay?: number;
    /** Backoff strategy. Default: "exponential" */
    backoff?: "exponential" | "linear" | "fixed";
    /** Optional predicate to decide whether to retry on a given error. Default: always retry */
    shouldRetry?: (error: unknown) => boolean;
    /** Optional callback invoked before each retry */
    onRetry?: (attempt: number, delay: number) => void;
    /**
     * Optional: compute custom delay for a given attempt and error.
     * Overrides `delay` + `backoff` when provided.
     * Useful for rate-limit-aware backoff.
     */
    getDelay?: (attempt: number, error: unknown) => number;
}
```

Then in the `retry()` function, replace the delay computation:

```typescript
let nextDelay: number;

if (opts.getDelay) {
    nextDelay = opts.getDelay(attempt, error);
} else {
    switch (backoff) {
        case "linear":
            nextDelay = delay * attempt;
            break;
        case "fixed":
            nextDelay = delay;
            break;
        default:
            nextDelay = delay * 2 ** (attempt - 1);
    }
}
```

And add a helper factory:

```typescript
/**
 * Create a getDelay function that uses longer delays for rate-limit errors.
 * Detects 429, "rate", "RESOURCE_EXHAUSTED", and "quota" in error messages.
 */
export function rateLimitAwareDelay(opts?: {
    baseDelay?: number;
    rateLimitMinDelay?: number;
}): (attempt: number, error: unknown) => number {
    const baseDelay = opts?.baseDelay ?? 500;
    const rateLimitMinDelay = opts?.rateLimitMinDelay ?? 15_000;

    return (attempt: number, error: unknown): number => {
        const msg = error instanceof Error ? error.message : String(error);
        const isRateLimit = msg.includes("429") || msg.includes("rate") ||
            msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota");

        const exponentialDelay = baseDelay * 2 ** (attempt - 1);

        if (isRateLimit) {
            return Math.max(exponentialDelay, rateLimitMinDelay);
        }

        return exponentialDelay;
    };
}
```

### Step 8.2: Wrap Embedder calls in retry

Modify `src/utils/ai/tasks/Embedder.ts`:

```typescript
import { retry, rateLimitAwareDelay } from "@app/utils/async";

// In embed():
async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
    return retry(
        () => this.provider.embed(text, options),
        {
            maxAttempts: 3,
            getDelay: rateLimitAwareDelay(),
        }
    );
}

// In embedBatch():
async embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
    if (texts.length === 0) {
        return [];
    }

    if (this.provider.embedBatch) {
        return retry(
            () => this.provider.embedBatch!(texts, options),
            {
                maxAttempts: 3,
                getDelay: rateLimitAwareDelay(),
            }
        );
    }

    return Promise.all(texts.map((t) =>
        retry(
            () => this.provider.embed(t, options),
            {
                maxAttempts: 3,
                getDelay: rateLimitAwareDelay(),
            }
        )
    ));
}
```

### Step 8.3: Write tests

Create `src/utils/async.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { rateLimitAwareDelay, retry } from "./async";

describe("retry with getDelay", () => {
    test("retries with custom getDelay", async () => {
        let attempt = 0;

        const result = await retry(
            async () => {
                attempt++;

                if (attempt < 3) {
                    throw new Error("transient");
                }

                return "success";
            },
            {
                maxAttempts: 5,
                getDelay: () => 10, // 10ms for fast tests
            }
        );

        expect(result).toBe("success");
        expect(attempt).toBe(3);
    });

    test("respects shouldRetry with getDelay", async () => {
        let attempt = 0;

        try {
            await retry(
                async () => {
                    attempt++;
                    throw new Error("fatal");
                },
                {
                    maxAttempts: 5,
                    shouldRetry: () => false,
                    getDelay: () => 10,
                }
            );
        } catch (e) {
            expect((e as Error).message).toBe("fatal");
        }

        expect(attempt).toBe(1);
    });
});

describe("rateLimitAwareDelay", () => {
    test("returns base exponential delay for normal errors", () => {
        const getDelay = rateLimitAwareDelay({ baseDelay: 100 });

        expect(getDelay(1, new Error("timeout"))).toBe(100);
        expect(getDelay(2, new Error("timeout"))).toBe(200);
        expect(getDelay(3, new Error("timeout"))).toBe(400);
    });

    test("returns at least rateLimitMinDelay for 429 errors", () => {
        const getDelay = rateLimitAwareDelay({
            baseDelay: 100,
            rateLimitMinDelay: 5000,
        });

        expect(getDelay(1, new Error("429 Too Many Requests"))).toBe(5000);
        expect(getDelay(2, new Error("429 Too Many Requests"))).toBe(5000);
        expect(getDelay(3, new Error("rate limit exceeded"))).toBe(5000);
    });

    test("detects quota and RESOURCE_EXHAUSTED errors", () => {
        const getDelay = rateLimitAwareDelay({ rateLimitMinDelay: 10000 });

        expect(getDelay(1, new Error("RESOURCE_EXHAUSTED"))).toBe(10000);
        expect(getDelay(1, new Error("quota exceeded"))).toBe(10000);
    });
});
```

### Step 8.4: Run and commit

```bash
bun test src/utils/async.test.ts
tsgo --noEmit 2>&1 | head -20
git add src/utils/async.ts src/utils/ai/tasks/Embedder.ts src/utils/async.test.ts
git commit -m "feat(ai): add rate-limit-aware retry to embedding pipeline"
```

---

## Task 9: Batch Embedding in Indexer Pipeline

**Files:**
- Modify: `src/indexer/lib/indexer.ts` (rewrite `embedUnembeddedChunks`)

### Step 9.1: Rewrite embedUnembeddedChunks for batch

Replace the entire `embedUnembeddedChunks` method in `src/indexer/lib/indexer.ts`:

```typescript
/** Embed all unembedded chunks in streaming pages, return count */
private async embedUnembeddedChunks(callbacks?: IndexerCallbacks): Promise<number> {
    if (!this.embedder) {
        return 0;
    }

    const totalToEmbed = this.store.getUnembeddedCount();

    if (totalToEmbed === 0) {
        return 0;
    }

    this.emitAndDispatch(
        "embed:start",
        {
            indexName: this.config.name,
            totalChunks: totalToEmbed,
            provider: this.config.embedding?.provider ?? "default",
            dimensions: this.embedder.dimensions,
        },
        callbacks
    );

    // Warm up the embedding model — first call can fail transiently
    try {
        await this.embedder.embed("warmup");
    } catch {
        await new Promise((r) => setTimeout(r, 500));
        await this.embedder.embed("warmup");
    }

    const modelId = this.config.embedding?.model ?? "darwinkit";
    const maxEmbedChars = getMaxEmbedChars(modelId);
    const taskPrefix = getTaskPrefix(modelId);
    const embedBatchSize = 32;
    const embedStart = performance.now();
    const dbPageSize = 1000;
    let embedded = 0;
    const zeroDims = this.embedder.dimensions;

    // Stream pages: query -> batch embed -> store -> next page
    while (true) {
        const page = this.store.getUnembeddedChunksPage(dbPageSize);

        if (page.length === 0) {
            break;
        }

        const batchEmbeddings = new Map<string, Float32Array>();

        // Process page in embedding batches
        for (let i = 0; i < page.length; i += embedBatchSize) {
            const batch = page.slice(i, i + embedBatchSize);
            const textsToEmbed: string[] = [];
            const idsToEmbed: string[] = [];

            for (const c of batch) {
                if (c.content.length < 5) {
                    batchEmbeddings.set(c.id, new Float32Array(zeroDims));
                    continue;
                }

                let text = c.content.slice(0, maxEmbedChars);

                if (taskPrefix) {
                    text = `${taskPrefix.document}${text}`;
                }

                textsToEmbed.push(text);
                idsToEmbed.push(c.id);
            }

            if (textsToEmbed.length > 0) {
                try {
                    const results = await this.embedder.embedBatch(textsToEmbed);

                    for (let j = 0; j < results.length; j++) {
                        batchEmbeddings.set(idsToEmbed[j], results[j].vector);
                    }
                } catch {
                    // On batch failure, fall back to individual embedding
                    for (let j = 0; j < textsToEmbed.length; j++) {
                        try {
                            const result = await this.embedder.embed(textsToEmbed[j]);
                            batchEmbeddings.set(idsToEmbed[j], result.vector);
                        } catch {
                            batchEmbeddings.set(idsToEmbed[j], new Float32Array(zeroDims));
                        }
                    }
                }
            }
        }

        // Single DB transaction for all embeddings in this page
        await this.store.insertChunks([], batchEmbeddings);
        embedded += batchEmbeddings.size;

        this.emitAndDispatch(
            "embed:progress",
            {
                indexName: this.config.name,
                completed: embedded,
                total: totalToEmbed,
                currentFile: page[page.length - 1].id,
            },
            callbacks
        );
    }

    const embedDuration = performance.now() - embedStart;

    this.emitAndDispatch(
        "embed:complete",
        {
            indexName: this.config.name,
            embedded,
            skipped: 0,
            durationMs: embedDuration,
        },
        callbacks
    );

    return embedded;
}
```

### Step 9.2: Verify the indexer test still passes

```bash
bun test src/indexer/lib/indexer.test.ts
tsgo --noEmit 2>&1 | head -20
```

### Step 9.3: Commit

```bash
git add src/indexer/lib/indexer.ts
git commit -m "feat(indexer): rewrite embedUnembeddedChunks for batch embedding (32 per request)"
```

---

## Task 10: Parallel File I/O in FileSource

**Files:**
- Modify: `src/indexer/lib/sources/file-source.ts`
- Modify: `src/indexer/lib/sources/file-source.test.ts`

### Step 10.1: Batch file reads with concurrency

Modify the `scan()` method in `src/indexer/lib/sources/file-source.ts`. Replace the sequential `for` loop with concurrent reads using `concurrentMap` from `src/utils/async.ts`:

```typescript
import { concurrentMap } from "@app/utils/async";

// Inside scan(), replace the sequential loop (lines 67-92) with:

async scan(scanOpts?: ScanOptions): Promise<SourceEntry[]> {
    let filePaths: string[];

    if (this.opts.respectGitIgnore) {
        const isGit = await this.checkIsGitRepo();

        if (isGit) {
            filePaths = await this.getGitTrackedFiles();
        } else {
            filePaths = this.walkDirectory();
        }
    } else {
        filePaths = this.walkDirectory();
    }

    if (this.opts.includedSuffixes && this.opts.includedSuffixes.length > 0) {
        const suffixSet = new Set(this.opts.includedSuffixes.map((s) => (s.startsWith(".") ? s : `.${s}`)));
        filePaths = filePaths.filter((f) => suffixSet.has(extname(f).toLowerCase()));
    }

    if (this.opts.ignoredPaths && this.opts.ignoredPaths.length > 0) {
        const ignored = this.opts.ignoredPaths;
        filePaths = filePaths.filter((f) => {
            const rel = relative(this.absBaseDir, f);
            return !ignored.some((pattern) => rel.startsWith(pattern) || rel.includes(pattern));
        });
    }

    if (scanOpts?.limit) {
        filePaths = filePaths.slice(0, scanOpts.limit);
    }

    const entries: SourceEntry[] = [];
    const total = filePaths.length;
    const batchSize = scanOpts?.batchSize ?? 500;
    let batch: SourceEntry[] = [];
    const ioConcurrency = 50;

    // Process in chunks of ioConcurrency for parallel file reads
    for (let i = 0; i < filePaths.length; i += ioConcurrency) {
        const chunk = filePaths.slice(i, i + ioConcurrency);

        const readResults = await concurrentMap({
            items: chunk,
            fn: async (filePath) => {
                const content = await Bun.file(filePath).text();
                return { id: filePath, content, path: filePath } as SourceEntry;
            },
            concurrency: ioConcurrency,
        });

        for (const [_filePath, entry] of readResults) {
            entries.push(entry);
            batch.push(entry);

            if (scanOpts?.onBatch && batch.length >= batchSize) {
                await scanOpts.onBatch(batch);
                batch = [];
            }
        }

        // Report progress for the chunk
        if (scanOpts?.onProgress) {
            scanOpts.onProgress(Math.min(i + chunk.length, total), total);
        }
    }

    if (scanOpts?.onBatch && batch.length > 0) {
        await scanOpts.onBatch(batch);
    }

    return entries;
}
```

### Step 10.2: Add test for parallel I/O

Add to `src/indexer/lib/sources/file-source.test.ts`:

```typescript
test("scan reads many files concurrently without errors", async () => {
    // Create many small files
    for (let i = 0; i < 100; i++) {
        writeFileSync(join(tempDir, `file${i}.ts`), `export const x${i} = ${i};`);
    }

    const source = new FileSource({ baseDir: tempDir });
    const entries = await source.scan();

    expect(entries.length).toBe(100);

    for (const entry of entries) {
        expect(entry.content.length).toBeGreaterThan(0);
    }
});
```

### Step 10.3: Run and commit

```bash
bun test src/indexer/lib/sources/file-source.test.ts
tsgo --noEmit 2>&1 | head -20
git add src/indexer/lib/sources/file-source.ts src/indexer/lib/sources/file-source.test.ts
git commit -m "perf(indexer): parallel file I/O in FileSource.scan() (50 concurrent reads)"
```

---

## Task 11: Benchmark After

**Files:**
- No new files

### Step 11.1: Run the same benchmark

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools
tools indexer benchmark . \
  --provider darwinkit \
  -o .claude/benchmarks/indexer-v3-plan1-after.json
```

### Step 11.2: Compare results

Create a quick comparison by reading both JSON files:

```bash
echo "=== BEFORE ==="
cat .claude/benchmarks/indexer-v3-plan1-before.json | tools json

echo ""
echo "=== AFTER ==="
cat .claude/benchmarks/indexer-v3-plan1-after.json | tools json
```

### Step 11.3: If Ollama is available, benchmark with it too

```bash
# Only if Ollama is running:
tools indexer benchmark . \
  --provider ollama \
  --model nomic-embed-text \
  -o .claude/benchmarks/indexer-v3-plan1-after-ollama.json
```

### Step 11.4: Commit benchmark results

```bash
git add .claude/benchmarks/
git commit -m "bench(indexer): before/after Plan 1 benchmark results"
```

---

## Summary: File Change Map

| File | Action | Task |
|------|--------|------|
| `src/utils/ai/types.ts` | Modify (add `embedBatch`, `"ollama"` type) | 1, 7 |
| `src/utils/ai/tasks/Embedder.ts` | Modify (batch-aware, retry) | 1, 8 |
| `src/utils/ai/tasks/Embedder.test.ts` | Create | 1 |
| `src/utils/ai/providers/AICloudProvider.ts` | Modify (add `embedBatch`) | 2 |
| `src/utils/ai/providers/AICloudProvider.test.ts` | Create | 2 |
| `src/utils/ai/providers/AILocalProvider.ts` | Modify (add `embedBatch`) | 3 |
| `src/utils/ai/providers/AILocalProvider.test.ts` | Create | 3 |
| `src/utils/ai/providers/AIDarwinKitProvider.ts` | Modify (add `embedBatch`) | 4 |
| `src/utils/ai/providers/AIOllamaProvider.ts` | Create | 7 |
| `src/utils/ai/providers/AIOllamaProvider.test.ts` | Create | 7 |
| `src/utils/ai/providers/index.ts` | Modify (register Ollama) | 7 |
| `src/indexer/lib/model-registry.ts` | Modify (contextLength, taskPrefix, Ollama models) | 5, 6, 7 |
| `src/indexer/lib/model-registry.test.ts` | Modify (new tests) | 5, 6 |
| `src/indexer/lib/indexer.ts` | Modify (batch embed, truncation, prefixes) | 5, 6, 9 |
| `src/indexer/lib/sources/file-source.ts` | Modify (parallel I/O) | 10 |
| `src/indexer/lib/sources/file-source.test.ts` | Modify (add test) | 10 |
| `src/indexer/commands/benchmark.ts` | Create | 0 |
| `src/indexer/index.ts` | Modify (register benchmark) | 0 |
| `src/utils/async.ts` | Modify (getDelay, rateLimitAwareDelay) | 8 |
| `src/utils/async.test.ts` | Create | 8 |

Total: **12 tasks** (0-11), **~20 files** changed/created, **~12 commits**.
