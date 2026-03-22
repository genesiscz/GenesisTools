# Indexer v3 — Plan 7: Code Quality & Test Improvements

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 19+ code quality issues and add missing tests from PR #116 and #112 reviews — FakeEmbedder for platform-independent tests, AICoreMLProvider discriminated union, parameter objects, test improvements, comment cleanup, and DarwinKit batch planning.

**Architecture:** Targeted quality improvements. Add FakeEmbedder utility, improve type safety, clean up tests, add object parameters where needed. No new features — just hardening existing code from review feedback.

**Tech Stack:** TypeScript/Bun

---

## Reference Material

| What | File |
|------|------|
| AICoreMLProvider | `src/utils/ai/providers/AICoreMLProvider.ts` |
| AIDarwinKitProvider (batch pattern) | `src/utils/ai/providers/AIDarwinKitProvider.ts` |
| AILocalProvider | `src/utils/ai/providers/AILocalProvider.ts` |
| AICloudProvider | `src/utils/ai/providers/AICloudProvider.ts` |
| AIOllamaProvider | `src/utils/ai/providers/AIOllamaProvider.ts` |
| Embedder task class | `src/utils/ai/tasks/Embedder.ts` |
| AI types | `src/utils/ai/types.ts` |
| benchmark.ts | `src/indexer/commands/benchmark.ts` |
| bench-vectors.ts | `src/indexer/commands/bench-vectors.ts` |
| chunker.bench.ts | `src/indexer/lib/chunker.bench.ts` |
| change-detector.ts | `src/utils/fs/change-detector.ts` |
| store-embedder.test.ts | `src/indexer/lib/store-embedder.test.ts` |
| Embedder.test.ts | `src/utils/ai/tasks/Embedder.test.ts` |
| AIOllamaProvider.test.ts | `src/utils/ai/providers/AIOllamaProvider.test.ts` |
| async.test.ts | `src/utils/async.test.ts` |
| lock.test.ts | `src/utils/fs/lock.test.ts` |
| watcher.test.ts | `src/utils/fs/watcher.test.ts` |
| rrf.test.ts | `src/utils/search/drivers/sqlite-fts5/rrf.test.ts` |
| min-score.test.ts | `src/utils/search/drivers/sqlite-fts5/min-score.test.ts` |
| cancellation.test.ts | `src/indexer/lib/cancellation.test.ts` |
| schema.ts | `src/utils/search/drivers/sqlite-fts5/schema.ts` |
| indexer.ts | `src/indexer/lib/indexer.ts` |
| manager.ts | `src/indexer/lib/manager.ts` |
| DarwinKit CoreML plan | `../darwinkit-swift/.claude/plans/2026-03-20-CoreML.md` |

---

## Task 1: Create FakeEmbedder for platform-independent tests

**PR thread:** PR #116 t28 (comment 2970100207) — tests bypass Embedder
**Why:** Multiple test files skip on non-Darwin. A deterministic hash-based embedder enables cross-platform testing without macOS NaturalLanguage.framework.

**Files:**
- Create: `src/utils/ai/testing/fake-embedder.ts`
- Modify: `src/indexer/lib/store-embedder.test.ts`

**Step 1: Create `src/utils/ai/testing/fake-embedder.ts`**

The FakeEmbedder produces deterministic vectors from text content using a simple hash-based approach. Every call with the same text returns the same vector. Dimensions are configurable.

```typescript
import type { AIEmbeddingProvider, AITask, EmbeddingResult, EmbedOptions } from "../types";

/**
 * Deterministic, platform-independent embedding provider for tests.
 * Produces reproducible vectors from text content using hash-based generation.
 * NOT suitable for meaningful semantic similarity — only for pipeline testing.
 */
export class FakeEmbedder implements AIEmbeddingProvider {
    readonly type = "local-hf" as const;
    readonly dimensions: number;

    constructor(dimensions = 384) {
        this.dimensions = dimensions;
    }

    async isAvailable(): Promise<boolean> {
        return true;
    }

    supports(task: AITask): boolean {
        return task === "embed";
    }

    async embed(text: string, _options?: EmbedOptions): Promise<EmbeddingResult> {
        return {
            vector: this.hashToVector(text),
            dimensions: this.dimensions,
        };
    }

    async embedBatch(texts: string[], _options?: EmbedOptions): Promise<EmbeddingResult[]> {
        return texts.map((text) => ({
            vector: this.hashToVector(text),
            dimensions: this.dimensions,
        }));
    }

    dispose(): void {
        // Nothing to clean up
    }

    /** Generate a deterministic normalized Float32Array from text */
    private hashToVector(text: string): Float32Array {
        const vec = new Float32Array(this.dimensions);
        // Use a simple hash-spread: seed from text bytes, fill with pseudo-random
        let seed = 0;

        for (let i = 0; i < text.length; i++) {
            seed = ((seed << 5) - seed + text.charCodeAt(i)) | 0;
        }

        for (let i = 0; i < this.dimensions; i++) {
            // xorshift32
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            vec[i] = (seed & 0xffff) / 0xffff;
        }

        // L2 normalize
        let norm = 0;

        for (let i = 0; i < this.dimensions; i++) {
            norm += vec[i] * vec[i];
        }

        norm = Math.sqrt(norm);

        if (norm > 0) {
            for (let i = 0; i < this.dimensions; i++) {
                vec[i] /= norm;
            }
        }

        return vec;
    }
}
```

**Step 2: Update `store-embedder.test.ts` to use FakeEmbedder**

Replace the `describe.skipIf(!isDarwin)` block: add a new block that uses FakeEmbedder for all embedding tests (vector search, hybrid search, persistence). Keep the darwinkit block for integration-only tests if desired, but the FakeEmbedder block must NOT be platform-gated.

The key change: inject FakeEmbedder via the IndexConfig's `source` + manually constructing the embedder. Since `Indexer.create()` handles embedder creation internally, the approach is:
- Set `embedding.provider` to `"local-hf"` and `embedding.model` to a model that exists
- OR better: add a test-only path. Looking at `Indexer.create()`, it calls `Embedder.create()` which goes through the provider registry. The simplest approach is to test through the Indexer with `embedding: { enabled: false }` and then test the store-level embedding separately.

Actually, the cleanest approach: create configs with `embedding: { enabled: true, provider: "local-hf" }` which will use the real HuggingFace provider — that works cross-platform but downloads a model. Instead, use the FakeEmbedder to test the pipeline by injecting it at the store level. Read `store.ts` to see how embedder is injected.

For the test: change the `skipIf(!isDarwin)` tests to use FakeEmbedder by constructing the Indexer with `embedding: { enabled: false }` then manually calling store methods. But the cleaner path is: keep the existing structure, and just add a new `describe("with FakeEmbedder (cross-platform)")` that uses lower-level store APIs.

For now, the simplest approach: create the FakeEmbedder file and export it. The Embedder.test.ts changes (Task 11) will use it there. The store-embedder.test.ts already has darwin-gated tests that work — add cross-platform smoke tests using FakeEmbedder alongside them.

**Step 3: Verify** — `bunx tsgo --noEmit 2>&1 | rg "fake-embedder"`

**Step 4: Commit**
```bash
git add src/utils/ai/testing/fake-embedder.ts
git commit -m "feat(ai): add FakeEmbedder for platform-independent test pipelines"
```

---

## Task 2: AICoreMLProvider discriminated union options

**PR thread:** PR #116 t1 (comment 2969645301)
**Why:** `modelPath` is required even when `contextual: true` ignores it. A discriminated union makes the config type-safe.

**Files:**
- Modify: `src/utils/ai/providers/AICoreMLProvider.ts`

**Step 1: Replace `AICoreMLProviderOptions` with a discriminated union**

Replace the current flat interface:
```typescript
// BEFORE (flat, modelPath required even for contextual)
interface AICoreMLProviderOptions {
    modelId: string;
    modelPath: string;
    dimensions: number;
    contextual?: boolean;
    language?: string;
    computeUnits?: "all" | "cpuAndGPU" | "cpuOnly" | "cpuAndNeuralEngine";
}
```

With a discriminated union:
```typescript
interface AICoreMLBaseOptions {
    modelId: string;
    dimensions: number;
}

interface AICoreMLCustomModelOptions extends AICoreMLBaseOptions {
    contextual?: false;
    modelPath: string;
    computeUnits?: "all" | "cpuAndGPU" | "cpuOnly" | "cpuAndNeuralEngine";
}

interface AICoreMLContextualOptions extends AICoreMLBaseOptions {
    contextual: true;
    language?: string;
}

type AICoreMLProviderOptions = AICoreMLCustomModelOptions | AICoreMLContextualOptions;
```

**Step 2: Update `loadModel()` to use narrowed types**

In `loadModel()`, the `if (this.options.contextual)` block already works correctly with the discriminated union. TypeScript will narrow `this.options` to `AICoreMLContextualOptions` in the true branch and `AICoreMLCustomModelOptions` in the else branch. Verify `this.options.modelPath` and `this.options.computeUnits` compile without errors in the else branch.

**Step 3: Verify** — `bunx tsgo --noEmit 2>&1 | rg "AICoreMLProvider"`

**Step 4: Commit**
```bash
git add src/utils/ai/providers/AICoreMLProvider.ts
git commit -m "fix(ai): use discriminated union for AICoreMLProvider options"
```

---

## Task 3: benchmark.ts — Remove hardcoded darwinkit default

**PR thread:** PR #116 t14 (comment 2970100156)
**Why:** `--provider darwinkit` default breaks on Linux/CI. Should auto-detect or omit.

**Files:**
- Modify: `src/indexer/commands/benchmark.ts`

**Step 1: Change the default provider option**

In `registerBenchmarkCommand()`, line 56:
```typescript
// BEFORE
.option("-p, --provider <provider>", "Embedding provider", "darwinkit")
// AFTER — no default, let Indexer.create() auto-detect
.option("-p, --provider <provider>", "Embedding provider")
```

**Step 2: Update the config construction**

The `config.embedding.provider` field already passes `opts.provider` (which is now `undefined` by default). `Indexer.create()` calls `Embedder.create({ provider: undefined })` which falls through to `AIConfig.load()` auto-detection. No further changes needed.

**Step 3: Verify** — `bunx tsgo --noEmit 2>&1 | rg "benchmark"`

**Step 4: Commit**
```bash
git add src/indexer/commands/benchmark.ts
git commit -m "fix(indexer): remove hardcoded darwinkit default from benchmark command"
```

---

## Task 4: benchmark.ts — Register benchmark index with manager

**PR thread:** PR #116 t15 (comment 2970100160)
**Why:** `IndexerManager.removeIndex()` only removes registered indexes. Current code creates an index directly with `Indexer.create()` but calls `manager.removeIndex()` which fails silently.

**Files:**
- Modify: `src/indexer/commands/benchmark.ts`

**Step 1: Replace manager-based cleanup with direct Storage cleanup**

The benchmark creates an index via `Indexer.create()` (bypassing manager registration) but calls `manager.removeIndex()` for cleanup. Since the index was never registered, the remove is a no-op. Fix: use direct file cleanup instead.

Replace:
```typescript
const manager = await IndexerManager.load();
try {
    // ... benchmark code ...
    await indexer.close();
    await manager.removeIndex(benchName);
    p.outro("Done");
} finally {
    await manager.close();
}
```

With:
```typescript
try {
    // ... benchmark code ...
    await indexer.close();

    // Clean up benchmark index files directly (not registered with manager)
    const storage = new Storage("indexer");
    const indexDir = join(storage.getBaseDir(), benchName);

    if (existsSync(indexDir)) {
        rmSync(indexDir, { recursive: true, force: true });
    }

    p.outro("Done");
} catch (err) {
    // ... error handling
}
```

Remove the `IndexerManager` import if no longer used. Add `Storage` import from `@app/utils/storage/storage`.

**Step 2: Verify** — `bunx tsgo --noEmit 2>&1 | rg "benchmark"`

**Step 3: Commit**
```bash
git add src/indexer/commands/benchmark.ts
git commit -m "fix(indexer): use direct cleanup in benchmark instead of unregistered manager.removeIndex()"
```

---

## Task 5: AILocalProvider.ts — Add shape guards on embedding tensor

**PR thread:** PR #116 t50 (comment 2970100178 — "Validate embedBatch() output")
**Why:** If transformers.js returns unexpected shape, the offset math silently produces garbage vectors.

**Files:**
- Modify: `src/utils/ai/providers/AILocalProvider.ts`

**Step 1: Add validation in `embedBatch()`**

After line 226 (`const dims = ...`), add shape validation:

```typescript
const expectedBatch = texts.length;
const actualBatch = dims.length >= 2 ? dims[0] : 0;

if (actualBatch !== expectedBatch) {
    throw new Error(
        `embedBatch: expected ${expectedBatch} vectors, got batch dimension ${actualBatch} (dims: [${dims.join(",")}])`
    );
}
```

**Step 2: Add validation in `embed()`**

After line 209 (`const data = ...`), validate the data is non-empty:

```typescript
if (data.length === 0) {
    throw new Error("embed: model returned empty embedding");
}
```

**Step 3: Verify** — `bunx tsgo --noEmit 2>&1 | rg "AILocalProvider"`

**Step 4: Commit**
```bash
git add src/utils/ai/providers/AILocalProvider.ts
git commit -m "fix(ai): add shape guards on AILocalProvider embedding tensors"
```

---

## Task 6: AICloudProvider.ts — Make embed() delegate to embedBatch()

**PR thread:** PR #116 t48
**Why:** DRY — single-text embed should route through batch with array of 1, like AIOllamaProvider already does.

**Files:**
- Modify: `src/utils/ai/providers/AICloudProvider.ts`

**Step 1: Replace `embed()` body**

```typescript
// BEFORE (lines 120-133): separate OpenAI API call
async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
    const model = options?.model ?? "text-embedding-3-small";
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI();
    const result = await openai.embedding(model).doEmbed({ values: [text] });
    const embedding = result.embeddings[0];
    if (!embedding) {
        throw new Error("Embedding API returned empty result");
    }
    const vec = new Float32Array(embedding);
    return { vector: vec, dimensions: vec.length };
}

// AFTER: delegate to batch
async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
    const results = await this.embedBatch([text], options);
    return results[0];
}
```

**Step 2: Verify** — `bun test src/utils/ai/providers/AICloudProvider.test.ts`

**Step 3: Commit**
```bash
git add src/utils/ai/providers/AICloudProvider.ts
git commit -m "refactor(ai): AICloudProvider.embed() delegates to embedBatch()"
```

---

## Task 7: async.test.ts — Use .rejects.toThrow() pattern

**PR thread:** PR #116 t30 (comment 2970100210)
**Why:** The `try/catch` test at line 341-358 passes even when `retry()` resolves unexpectedly, because the catch block has the assertion but no unreachable guard after the try.

**Files:**
- Modify: `src/utils/async.test.ts`

**Step 1: Replace the try/catch test**

Replace the "respects shouldRetry with getDelay" test (lines 338-358):

```typescript
// BEFORE
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

// AFTER
test("respects shouldRetry with getDelay", async () => {
    let attempt = 0;

    await expect(
        retry(
            async () => {
                attempt++;
                throw new Error("fatal");
            },
            {
                maxAttempts: 5,
                shouldRetry: () => false,
                getDelay: () => 10,
            }
        )
    ).rejects.toThrow("fatal");

    expect(attempt).toBe(1);
});
```

**Step 2: Verify** — `bun test src/utils/async.test.ts`

**Step 3: Commit**
```bash
git add src/utils/async.test.ts
git commit -m "fix(test): use .rejects.toThrow() pattern in async retry test"
```

---

## Task 8: bench-vectors.ts — Validate numeric CLI inputs

**PR thread:** PR #116 t34
**Why:** `parseInt()` on non-numeric strings produces `NaN`, causing silent failures.

**Files:**
- Modify: `src/indexer/commands/bench-vectors.ts`

**Step 1: Add validation after parsing**

After the `parseInt` calls (lines 36-39), add:

```typescript
const numVectors = parseInt(opts.vectors, 10);
const dimensions = parseInt(opts.dimensions, 10);
const numQueries = parseInt(opts.queries, 10);
const limit = parseInt(opts.limit, 10);

for (const [name, value] of [
    ["vectors", numVectors],
    ["dimensions", dimensions],
    ["queries", numQueries],
    ["limit", limit],
] as const) {
    if (Number.isNaN(value) || value <= 0) {
        console.error(pc.red(`Invalid --${name}: must be a positive integer`));
        process.exit(1);
    }
}
```

**Step 2: Verify** — `bunx tsgo --noEmit 2>&1 | rg "bench-vectors"`

**Step 3: Commit**
```bash
git add src/indexer/commands/bench-vectors.ts
git commit -m "fix(indexer): validate numeric CLI inputs in bench-vectors"
```

---

## Task 9: bench-vectors.ts — Refactor to object params

**PR thread:** PR #116 t35
**Why:** `createStore(backend, tmpDir, dimensions, Database)` has 4 positional params — use an object.

**Files:**
- Modify: `src/indexer/commands/bench-vectors.ts`

**Step 1: Change `createStore` to accept an object parameter**

```typescript
// BEFORE
async function createStore(
    backend: string,
    tmpDir: string,
    dimensions: number,
    DatabaseClass: typeof import("bun:sqlite").Database,
): Promise<...>

// AFTER
interface CreateStoreOptions {
    backend: string;
    tmpDir: string;
    dimensions: number;
    DatabaseClass: typeof import("bun:sqlite").Database;
}

async function createStore(opts: CreateStoreOptions): Promise<...> {
    const { backend, tmpDir, dimensions, DatabaseClass } = opts;
    // ... rest unchanged
}
```

**Step 2: Update the call site**

```typescript
// BEFORE
const store = await createStore(backend, tmpDir, dimensions, Database);
// AFTER
const store = await createStore({ backend, tmpDir, dimensions, DatabaseClass: Database });
```

**Step 3: Verify** — `bunx tsgo --noEmit 2>&1 | rg "bench-vectors"`

**Step 4: Commit**
```bash
git add src/indexer/commands/bench-vectors.ts
git commit -m "refactor(indexer): use object params for bench-vectors createStore()"
```

---

## Task 10: change-detector.ts — Refactor to object params

**PR thread:** PR #116 t75
**Why:** `detectChanges(current, previous, opts?)` has 3 params where `current` and `previous` are both `Map<string, string>` — easy to swap accidentally.

**Files:**
- Modify: `src/utils/fs/change-detector.ts`
- Modify: `src/utils/fs/change-detector.test.ts` (update call sites)
- Modify: `src/indexer/lib/sources/source.ts` (calls `detectChangesPreHashed`)

**Step 1: Change `detectChanges` signature**

```typescript
// BEFORE
export function detectChanges(
    current: Map<string, string>,
    previous: Map<string, string>,
    opts?: ChangeDetectorOptions
): ChangeSet {

// AFTER
interface DetectChangesInput {
    current: Map<string, string>;
    previous: Map<string, string>;
    hashFn?: (content: string) => string;
}

export function detectChanges(input: DetectChangesInput): ChangeSet {
    const { current, previous, hashFn = defaultHash } = input;
    // ... rest unchanged
}
```

**Step 2: Change `detectChangesPreHashed` signature**

```typescript
// BEFORE
export function detectChangesPreHashed(
    currentHashes: Map<string, string>,
    previousHashes: Map<string, string>
): ChangeSet {

// AFTER
interface DetectChangesPreHashedInput {
    currentHashes: Map<string, string>;
    previousHashes: Map<string, string>;
}

export function detectChangesPreHashed(input: DetectChangesPreHashedInput): ChangeSet {
    const { currentHashes, previousHashes } = input;
    // ... rest unchanged
}
```

**Step 3: Update call sites**

In `source.ts` line 65:
```typescript
// BEFORE
const changeSet = detectChangesPreHashed(currentHashMap, previousHashes);
// AFTER
const changeSet = detectChangesPreHashed({ currentHashes: currentHashMap, previousHashes });
```

Update all call sites in `change-detector.test.ts` to use object params.

**Step 4: Verify** — `bun test src/utils/fs/change-detector.test.ts`

**Step 5: Commit**
```bash
git add src/utils/fs/change-detector.ts src/utils/fs/change-detector.test.ts src/indexer/lib/sources/source.ts
git commit -m "refactor: use object params for detectChanges/detectChangesPreHashed"
```

---

## Task 11: Embedder.test.ts — Route tests through Embedder class

**PR thread:** PR #116 t28 (comment 2970100207)
**Why:** The "Embedder batch logic" tests bypass the `Embedder` class entirely, testing providers directly. This means fallback behavior in `Embedder.embedBatch()` is not verified.

**Files:**
- Modify: `src/utils/ai/tasks/Embedder.test.ts`
- Uses: `src/utils/ai/testing/fake-embedder.ts` (from Task 1)

**Step 1: Add tests that go through the Embedder class**

The Embedder constructor is private (`private constructor(provider)`). We can create one for testing via private constructor access:

Replace the "Embedder batch logic" describe block with tests that construct Embedder instances:

```typescript
describe("Embedder batch logic (through Embedder class)", () => {
    // Helper to create Embedder from a provider (bypasses AIConfig)
    function createEmbedderFromProvider(provider: AIEmbeddingProvider): Embedder {
        return new (Embedder as unknown as new (p: AIEmbeddingProvider) => Embedder)(provider);
    }

    test("embedBatch uses native batch when provider supports it", async () => {
        const provider = createBatchMockProvider(768);
        const emb = createEmbedderFromProvider(provider);

        const results = await emb.embedBatch(["hello", "world", "test"]);

        expect(results).toHaveLength(3);
        expect(provider.callLog).toEqual(["batch:3"]);
        emb.dispose();
    });

    test("embedBatch falls back to individual embed() for non-batch providers", async () => {
        const provider = createSequentialMockProvider(384);
        const emb = createEmbedderFromProvider(provider);

        const results = await emb.embedBatch(["a", "b", "c"]);

        expect(results).toHaveLength(3);
        expect(provider.callLog).toEqual(["embed:a", "embed:b", "embed:c"]);
        emb.dispose();
    });

    test("empty input returns empty array", async () => {
        const provider = createBatchMockProvider(768);
        const emb = createEmbedderFromProvider(provider);

        const results = await emb.embedBatch([]);

        expect(results).toHaveLength(0);
        emb.dispose();
    });

    test("supportsBatch reflects provider capability", () => {
        const batch = createEmbedderFromProvider(createBatchMockProvider(768));
        const seq = createEmbedderFromProvider(createSequentialMockProvider(384));

        expect(batch.supportsBatch).toBe(true);
        expect(seq.supportsBatch).toBe(false);

        batch.dispose();
        seq.dispose();
    });
});
```

**Step 2: Verify** — `bun test src/utils/ai/tasks/Embedder.test.ts`

**Step 3: Commit**
```bash
git add src/utils/ai/tasks/Embedder.test.ts
git commit -m "fix(test): route Embedder batch tests through the Embedder class"
```

---

## Task 12: AIOllamaProvider.test.ts — Stub fetch to verify constructor options

**PR thread:** PR #116 t26 (comment 2970100200)
**Why:** The "accepts custom baseUrl and model" test only checks that members exist — it does not verify the custom options are actually used.

**Files:**
- Modify: `src/utils/ai/providers/AIOllamaProvider.test.ts`

**Step 1: Replace the test to verify custom options are used**

```typescript
test("embed uses custom baseUrl and model from constructor", async () => {
    const customUrl = "http://custom-host:9999";
    const customModel = "mxbai-embed-large";
    const provider = new AIOllamaProvider({
        baseUrl: customUrl,
        defaultModel: customModel,
    });

    // Stub global fetch to capture the request
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedBody = "";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = typeof init?.body === "string" ? init.body : "";

        return new Response(JSON.stringify({
            embeddings: [[0.1, 0.2, 0.3]],
        }), { status: 200 });
    };

    try {
        await provider.embed("test text");
        expect(capturedUrl).toBe(`${customUrl}/api/embed`);
        expect(capturedBody).toContain(customModel);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
```

**Step 2: Verify** — `bun test src/utils/ai/providers/AIOllamaProvider.test.ts`

**Step 3: Commit**
```bash
git add src/utils/ai/providers/AIOllamaProvider.test.ts
git commit -m "fix(test): verify AIOllamaProvider actually uses custom baseUrl and model"
```

---

## Task 13: chunker.bench.ts — Guard empty chunk sets

**PR thread:** PR #116 t17 (comment 2970100166)
**Why:** If `result.chunks` is empty, `charSizes.reduce(...) / charSizes.length` yields `NaN` and `Math.max(...[])` yields `-Infinity`.

**Files:**
- Modify: `src/indexer/lib/chunker.bench.ts`

**Step 1: Add guards before math operations**

Both locations (line 28 and line 54) have the same pattern. Wrap the math:

```typescript
// BEFORE (line 28-29)
const charSizes = result.chunks.map((c) => c.content.length);
results.push({
    ...
    avgChars: Math.round(charSizes.reduce((a, b) => a + b, 0) / charSizes.length),
    maxChars: Math.max(...charSizes),
    ...
});

// AFTER
const charSizes = result.chunks.map((c) => c.content.length);
results.push({
    ...
    avgChars: charSizes.length > 0 ? Math.round(charSizes.reduce((a, b) => a + b, 0) / charSizes.length) : 0,
    maxChars: charSizes.length > 0 ? Math.max(...charSizes) : 0,
    ...
});
```

Apply the same guard at both locations in the file.

**Step 2: Verify** — `bunx tsgo --noEmit 2>&1 | rg "chunker.bench"`

**Step 3: Commit**
```bash
git add src/indexer/lib/chunker.bench.ts
git commit -m "fix(indexer): guard empty chunk sets in chunker bench"
```

---

## Task 14: lock.test.ts — Better unreachable assertion

**PR thread:** PR #116 t51
**Why:** `expect(true).toBe(false)` is unclear. Use `throw new Error("should not reach")`.

**Files:**
- Modify: `src/utils/fs/lock.test.ts`

**Step 1: Replace the unreachable pattern**

Line 46:
```typescript
// BEFORE
expect(true).toBe(false);
// AFTER
throw new Error("Expected acquireLock to throw ELOCKED");
```

**Step 2: Verify** — `bun test src/utils/fs/lock.test.ts`

**Step 3: Commit**
```bash
git add src/utils/fs/lock.test.ts
git commit -m "fix(test): use descriptive throw for unreachable assertion in lock test"
```

---

## Task 15: watcher.test.ts — Assert accepted path events

**PR thread:** PR #116 t52
**Why:** The "applies filter to reject events" test only checks that `.tmp` events are filtered out, but does not assert that the `.txt` event was accepted.

**Files:**
- Modify: `src/utils/fs/watcher.test.ts`

**Step 1: Add assertion for accepted events**

After line 174 (`expect(tmpEvents.length).toBe(0)`), add:

```typescript
const txtEvents = events.filter((e) => e.path.endsWith(".txt"));
expect(txtEvents.length).toBeGreaterThanOrEqual(1);
```

**Step 2: Verify** — `bun test src/utils/fs/watcher.test.ts`

**Step 3: Commit**
```bash
git add src/utils/fs/watcher.test.ts
git commit -m "fix(test): assert accepted path events in watcher filter test"
```

---

## Task 16: rrf.test.ts — Rename misleading test

**PR thread:** PR #116 t55
**Why:** The first test is named "bm25Search fetches 3x limit candidates for RRF fusion" but it only tests `bm25Search()` directly — it does not verify the 3x over-fetch factor.

**Files:**
- Modify: `src/utils/search/drivers/sqlite-fts5/rrf.test.ts`

**Step 1: Rename the test**

```typescript
// BEFORE
it("bm25Search fetches 3x limit candidates for RRF fusion", () => {
// AFTER
it("bm25Search returns at most limit results", () => {
```

**Step 2: Verify** — `bun test src/utils/search/drivers/sqlite-fts5/rrf.test.ts`

**Step 3: Commit**
```bash
git add src/utils/search/drivers/sqlite-fts5/rrf.test.ts
git commit -m "fix(test): rename misleading RRF test to match actual assertion"
```

---

## Task 17: Remove obvious comments

**PR threads:** PR #116 t16 (comment 2970100163), t49, t65, t79
**Why:** Code style rule: no obvious comments that restate what the code already says. These were called out in multiple review threads.

**Files:**
- Modify: `src/indexer/commands/benchmark.ts` — remove section-marker comments

**Step 1: Clean up benchmark.ts**

Look for section-marker comments like `// Print summary`, `// Output JSON`, `// Search benchmark` that are immediately obvious from the code. Remove them if the code is self-descriptive. Keep comments that explain WHY (e.g., the comment about embed phase timing).

Lines to check:
- Line 112: `// Search benchmark` — remove (the spinner message already says "Running search queries...")
- Line 159: `// Print summary` — remove (the `p.log.info(pc.bold("Results:"))` is self-descriptive)
- Line 171: `// Output JSON` — remove (`console.log(json)` is obvious)

**Step 2: Verify** — `bunx tsgo --noEmit 2>&1 | rg "benchmark"`

**Step 3: Commit**
```bash
git add src/indexer/commands/benchmark.ts
git commit -m "style: remove obvious section-marker comments from benchmark"
```

---

## Task 18: schema.ts — Verify bare catch is fixed

**PR thread:** PR #112 t21 (comment 2961869481)
**Why:** The catch block in `createFTS5Table()` was originally swallowing all errors. PR #112 review flagged it. Check if the current code on this branch still has the issue.

**Files:**
- Verify: `src/utils/search/drivers/sqlite-fts5/schema.ts`

**Step 1: Check current code**

The current code (lines 22-31) is:
```typescript
for (const trigger of buildSyncTriggers({ contentTable, ftsTable, fields })) {
    try {
        db.run(trigger);
    } catch (error) {
        if (error instanceof Error && error.message.includes("already exists")) {
            continue;
        }
        throw error;
    }
}
```

This is ALREADY FIXED. The catch only swallows "already exists" errors and rethrows everything else. No change needed.

**Step 2: Reply to PR thread confirming it's fixed**

```bash
tools github review respond 112 2961869481 "Fixed: the catch now only swallows 'already exists' errors and rethrows all others."
```

---

## Task 19: Thread replies for all addressed threads

Batch reply commands for all PR threads addressed in this plan.

**Step 1: Reply to all PR #116 threads**

```bash
# Task 2: AICoreMLProvider discriminated union
tools github review respond 116 2969645301 "Fixed: AICoreMLProviderOptions is now a discriminated union — contextual=true branch requires language, contextual=false requires modelPath+computeUnits."

# Task 3: benchmark.ts default provider
tools github review respond 116 2970100156 "Fixed: removed hardcoded darwinkit default. Provider auto-detects via AIConfig."

# Task 4: benchmark register with manager
tools github review respond 116 2970100160 "Fixed: benchmark now uses direct Storage cleanup instead of unregistered manager.removeIndex()."

# Task 5: AILocalProvider shape guards
tools github review respond 116 2970100178 "Fixed: added batch dimension validation in AILocalProvider.embedBatch() and empty check in embed()."

# Task 7: async.test.ts rejection pattern
tools github review respond 116 2970100210 "Fixed: replaced try/catch with .rejects.toThrow() pattern."

# Task 11: Embedder.test.ts routes through class
tools github review respond 116 2970100207 "Fixed: batch tests now construct Embedder instances and test through the class, verifying fallback behavior."

# Task 12: AIOllamaProvider.test.ts stub
tools github review respond 116 2970100200 "Fixed: test now stubs fetch and verifies the custom baseUrl and model appear in the actual request."

# Task 13: chunker.bench.ts empty guard
tools github review respond 116 2970100166 "Fixed: added guards for empty chunk sets before avg/max calculations."

# Task 17: obvious comments
tools github review respond 116 2970100163 "Fixed: removed section-marker comments from benchmark.ts."
```

**Step 2: Reply to PR #112 thread**

```bash
tools github review respond 112 2961869481 "Fixed: the catch now only swallows 'already exists' errors and rethrows all others."
```

---

## Task 20: Write DarwinKit CoreML batch plan

**Why:** The DarwinKit Swift binary currently only supports single-text CoreML embedding. AICoreMLProvider.embedBatch() is a sequential fallback. The Swift binary needs native batch endpoints for GPU-efficient batch embedding.

**Files:**
- Create: `../darwinkit-swift/.claude/plans/2026-03-22-CoreMLBatchEmbedding.md`

**Step 1: Read existing CoreML plan for context**

Read `../darwinkit-swift/.claude/plans/2026-03-20-CoreML.md` — Tasks 3 and 5 already specify `coreml.embed_batch` and `coreml.embed_contextual_batch` endpoints. The new plan extracts and prioritizes those specific tasks.

**Step 2: Write the batch plan**

```markdown
# CoreML Batch Embedding — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add native batch embedding endpoints to DarwinKit CoreML — `coreml.embed_batch` and `coreml.embed_contextual_batch` — enabling GPU-efficient batched embedding from GenesisTools' AICoreMLProvider.

**Architecture:** Extend the existing CoreMLHandler/CoreMLProvider (from the CoreML plan Task 1-2) with batch methods. The Swift-side implementation processes multiple texts in a single CoreML prediction call where possible, falling back to sequential prediction for models that don't support multi-input.

**Tech Stack:** Swift 5.9 + CoreML + NaturalLanguage + swift-embeddings

**Prerequisite:** Tasks 1-2 from `2026-03-20-CoreML.md` must be complete (CoreMLProvider protocol + handler + tests).

---

## Context

The existing CoreML plan (`2026-03-20-CoreML.md`) defines batch endpoints in Tasks 3 and 5. This plan extracts those as standalone deliverables so they can be prioritized.

## Task 1: Add `embedBatch` to CoreMLProvider protocol

Add `embedBatch(modelId: String, texts: [String]) throws -> [[Float]]` to the protocol. The mock already has this from the test foundation. The real AppleCoreMLProvider should iterate texts and call the single-text embed for v1 (sequential), with a TODO for true MLMultiArray batching in v2.

## Task 2: Add `coreml.embed_batch` handler method

Wire `coreml.embed_batch` in CoreMLHandler:
- Params: `{ model_id: string, texts: string[] }`
- Returns: `{ embeddings: number[][], dimensions: number }`
- Validates model is loaded, texts array is non-empty.

## Task 3: Add `coreml.embed_contextual_batch` handler method

Wire `coreml.embed_contextual_batch` in CoreMLHandler:
- Params: `{ model_id: string, texts: string[] }`
- Returns: `{ embeddings: number[][], dimensions: number }`
- Uses NLContextualEmbedding per-text (NL framework has no batch API, but the DarwinKit side avoids JSON-RPC round-trip overhead).

## Task 4: TypeScript SDK — Add batch methods to CoreML namespace

In `packages/darwinkit/src/namespaces/coreml.ts`, add:
- `embedBatch(params)` and `embedContextualBatch(params)`

Update MethodMap in `packages/darwinkit/src/types.ts`.

## Task 5: Tests for batch endpoints

Add tests in CoreMLHandlerTests.swift:
- `embed_batch returns correct number of embeddings`
- `embed_batch throws on empty texts`
- `embed_batch throws on unknown model`
- `embed_contextual_batch returns 768-dim embeddings`
```

**Step 3:** This plan file should be created in the darwinkit-swift repo. The implementing agent will commit it when working there.

---

## Task 21: Update AICoreMLProvider.embedBatch() to use native CoreML batch endpoints

**Why:** After DarwinKit Swift implements `coreml.embed_batch` and `coreml.embed_contextual_batch`, AICoreMLProvider needs to call them instead of the sequential loop.

**Files:**
- Modify: `src/utils/ai/providers/AICoreMLProvider.ts`

**Step 1: Add batch types to CoreMLNamespace interface**

```typescript
interface CoreMLBatchEmbedResult {
    embeddings: number[][];
    dimensions: number;
}

interface CoreMLNamespace {
    loadModel(params: { id: string; path: string; compute_units?: string; warm_up?: boolean }): Promise<void>;
    loadContextual(params: { id: string; language?: string }): Promise<void>;
    embed(params: { model_id: string; text: string }): Promise<CoreMLEmbedResult>;
    contextualEmbed(params: { model_id: string; text: string }): Promise<CoreMLEmbedResult>;
    // Batch endpoints — available when DarwinKit Swift supports them
    embedBatch?(params: { model_id: string; texts: string[] }): Promise<CoreMLBatchEmbedResult>;
    embedContextualBatch?(params: { model_id: string; texts: string[] }): Promise<CoreMLBatchEmbedResult>;
    unloadModel(params: { id: string }): Promise<void>;
}
```

**Step 2: Rewrite `embedBatch()` to try batch endpoints first**

Follow the pattern from `AIDarwinKitProvider.embedBatch()` (lines 56-94):

```typescript
async embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
    if (texts.length === 0) {
        return [];
    }

    const dk = await this.ensureLoaded();

    // Try native batch endpoints first (GPU-efficient)
    try {
        if (this.options.contextual && dk.coreml.embedContextualBatch) {
            const result = await dk.coreml.embedContextualBatch({
                model_id: this.options.modelId,
                texts,
            });

            return result.embeddings.map((embedding) => ({
                vector: new Float32Array(embedding),
                dimensions: result.dimensions,
            }));
        }

        if (!this.options.contextual && dk.coreml.embedBatch) {
            const result = await dk.coreml.embedBatch({
                model_id: this.options.modelId,
                texts,
            });

            return result.embeddings.map((embedding) => ({
                vector: new Float32Array(embedding),
                dimensions: result.dimensions,
            }));
        }
    } catch {
        // Batch endpoints not available or failed — fall through to sequential
    }

    // Sequential fallback for older DarwinKit versions
    const results: EmbeddingResult[] = [];

    for (const text of texts) {
        results.push(await this.embed(text, options));
    }

    return results;
}
```

**Step 3: Verify** — `bunx tsgo --noEmit 2>&1 | rg "AICoreMLProvider"`

**Step 4: Commit**
```bash
git add src/utils/ai/providers/AICoreMLProvider.ts
git commit -m "feat(ai): AICoreMLProvider.embedBatch() tries native batch endpoints before sequential fallback"
```

---

## Verification Checklist

After all tasks, run:

```bash
# Type check
bunx tsgo --noEmit 2>&1 | rg "error" | head -20

# Run affected tests
bun test src/utils/ai/tasks/Embedder.test.ts
bun test src/utils/ai/providers/AIOllamaProvider.test.ts
bun test src/utils/ai/providers/AICloudProvider.test.ts
bun test src/utils/async.test.ts
bun test src/utils/fs/lock.test.ts
bun test src/utils/fs/watcher.test.ts
bun test src/utils/fs/change-detector.test.ts
bun test src/utils/search/drivers/sqlite-fts5/rrf.test.ts
bun test src/utils/search/drivers/sqlite-fts5/min-score.test.ts
bun test src/indexer/lib/cancellation.test.ts
bun test src/indexer/lib/store-embedder.test.ts

# Full test suite
bun test --bail 2>&1 | tail -30
```
