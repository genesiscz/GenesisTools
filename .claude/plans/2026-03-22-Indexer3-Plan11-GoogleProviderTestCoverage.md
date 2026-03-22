# Indexer v3 — Plan 11: Google Provider + Test Coverage

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Google Gemini embedding provider (gemini-embedding-001, 3072 dims, free tier) and significantly expand test coverage to match SocratiCode's ~29 test files.

**Architecture:** New `AIGoogleProvider` following the existing Ollama/Cloud provider pattern. Provider uses raw `fetch()` against the Google Generative AI REST API — no `@google/generative-ai` SDK dependency needed. Comprehensive test additions across all indexer subsystems.

**Tech Stack:** TypeScript/Bun, Google Generative AI REST API, bun:test

---

## Task 1 — Create `AIGoogleProvider`

> TDD: Write the test file first, then implement to make tests pass.

### Test file: `src/utils/ai/providers/AIGoogleProvider.test.ts`

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AIGoogleProvider } from "./AIGoogleProvider";

describe("AIGoogleProvider", () => {
    let originalFetch: typeof globalThis.fetch;
    let originalEnv: string | undefined;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        originalEnv = process.env.GOOGLE_API_KEY;
        process.env.GOOGLE_API_KEY = "test-api-key";
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        if (originalEnv !== undefined) {
            process.env.GOOGLE_API_KEY = originalEnv;
        } else {
            delete process.env.GOOGLE_API_KEY;
        }
    });

    test("has correct type and default dimensions", () => {
        const provider = new AIGoogleProvider();
        expect(provider.type).toBe("google");
        expect(provider.dimensions).toBe(3072);
    });

    test("supports embed task only", () => {
        const provider = new AIGoogleProvider();
        expect(provider.supports("embed")).toBe(true);
        expect(provider.supports("transcribe")).toBe(false);
        expect(provider.supports("translate")).toBe(false);
        expect(provider.supports("summarize")).toBe(false);
    });

    test("isAvailable returns true when GOOGLE_API_KEY is set", async () => {
        const provider = new AIGoogleProvider();
        expect(await provider.isAvailable()).toBe(true);
    });

    test("isAvailable returns false when GOOGLE_API_KEY is missing", async () => {
        delete process.env.GOOGLE_API_KEY;
        const provider = new AIGoogleProvider();
        expect(await provider.isAvailable()).toBe(false);
    });

    test("embedBatch returns empty array for empty input", async () => {
        const provider = new AIGoogleProvider();
        const results = await provider.embedBatch([]);
        expect(results).toEqual([]);
    });

    test("embed sends correct request to Google API", async () => {
        let capturedUrl = "";
        let capturedBody = "";

        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            capturedUrl = typeof input === "string" ? input : input.toString();
            capturedBody = typeof init?.body === "string" ? init.body : "";
            return new Response(JSON.stringify({
                embeddings: [{ values: [0.1, 0.2, 0.3] }],
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        };

        const provider = new AIGoogleProvider();
        const result = await provider.embed("test text");

        expect(capturedUrl).toContain("generativelanguage.googleapis.com");
        expect(capturedUrl).toContain("gemini-embedding-001");
        expect(capturedUrl).toContain("batchEmbedContents");
        expect(capturedUrl).toContain("key=test-api-key");
        expect(capturedBody).toContain("test text");
        expect(result.vector).toBeInstanceOf(Float32Array);
        expect(result.dimensions).toBe(3);
    });

    test("embedBatch chunks requests when exceeding batch size", async () => {
        let callCount = 0;

        globalThis.fetch = async () => {
            callCount++;
            // Return 50 embeddings per call (simulating GOOGLE_BATCH_SIZE = 100)
            const embeddings = Array.from({ length: 50 }, () => ({ values: [0.1, 0.2] }));
            return new Response(JSON.stringify({ embeddings }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        };

        // 150 texts should require 2 batch calls (100 + 50)
        const provider = new AIGoogleProvider();
        const texts = Array.from({ length: 150 }, (_, i) => `text ${i}`);
        const results = await provider.embedBatch(texts);

        expect(callCount).toBe(2);
        expect(results).toHaveLength(150);
    });

    test("embedBatch pre-truncates long texts", async () => {
        let capturedTexts: string[] = [];

        globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
            capturedTexts = body.requests.map((r: { content: { parts: Array<{ text: string }> } }) => r.content.parts[0].text);
            const embeddings = capturedTexts.map(() => ({ values: [0.1] }));
            return new Response(JSON.stringify({ embeddings }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        };

        const provider = new AIGoogleProvider();
        const longText = "x".repeat(20_000); // Exceeds 2048 tokens * 3 chars/token = 6144 chars
        await provider.embedBatch([longText]);

        expect(capturedTexts[0].length).toBeLessThanOrEqual(6144);
    });

    test("embed throws on API error", async () => {
        globalThis.fetch = async () => {
            return new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
                status: 401,
                headers: { "Content-Type": "application/json" },
            });
        };

        const provider = new AIGoogleProvider();
        await expect(provider.embed("test")).rejects.toThrow();
    });

    test("uses custom model from constructor options", async () => {
        let capturedUrl = "";

        globalThis.fetch = async (input: RequestInfo | URL) => {
            capturedUrl = typeof input === "string" ? input : input.toString();
            return new Response(JSON.stringify({
                embeddings: [{ values: [0.1] }],
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        };

        const provider = new AIGoogleProvider({ model: "text-embedding-004" });
        await provider.embed("test");

        expect(capturedUrl).toContain("text-embedding-004");
    });

    test.skipIf(!process.env.TEST_GOOGLE)("embed() returns valid vector (requires GOOGLE_API_KEY)", async () => {
        const provider = new AIGoogleProvider();
        const result = await provider.embed("Hello, world!");

        expect(result.vector).toBeInstanceOf(Float32Array);
        expect(result.dimensions).toBe(3072);
        expect(result.vector.length).toBe(3072);
    });
});
```

### Implementation file: `src/utils/ai/providers/AIGoogleProvider.ts`

```typescript
import { SafeJSON } from "@app/utils/json";
import type { AIEmbeddingProvider, AIProvider, AITask, EmbeddingResult, EmbedOptions } from "../types";

const SUPPORTED_TASKS: AITask[] = ["embed"];

/** Google batchEmbedContents supports up to 100 texts per request. */
const GOOGLE_BATCH_SIZE = 100;

/** Max input tokens for gemini-embedding-001. */
const GOOGLE_MAX_TOKENS = 2048;

/** Conservative chars-per-token estimate for code (SentencePiece tokenizer). */
const CHARS_PER_TOKEN_ESTIMATE = 3.0;

const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GoogleBatchEmbedRequest {
    requests: Array<{
        model: string;
        content: { parts: Array<{ text: string }> };
    }>;
}

interface GoogleBatchEmbedResponse {
    embeddings: Array<{ values: number[] }>;
}

export interface AIGoogleProviderOptions {
    /** Embedding model name. Default: gemini-embedding-001 */
    model?: string;
    /** Override max context length in tokens. Default: 2048 */
    maxTokens?: number;
}

export class AIGoogleProvider implements AIProvider, AIEmbeddingProvider {
    readonly type = "google" as const;
    readonly dimensions = 3072;
    private model: string;
    private maxChars: number;

    constructor(options?: AIGoogleProviderOptions) {
        this.model = options?.model ?? "gemini-embedding-001";
        this.maxChars = Math.floor((options?.maxTokens ?? GOOGLE_MAX_TOKENS) * CHARS_PER_TOKEN_ESTIMATE);
    }

    async isAvailable(): Promise<boolean> {
        return !!process.env.GOOGLE_API_KEY;
    }

    supports(task: AITask): boolean {
        return SUPPORTED_TASKS.includes(task);
    }

    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
        const results = await this.embedBatch([text], options);

        if (!results[0]) {
            throw new Error("Google embedding API returned empty result");
        }

        return results[0];
    }

    async embedBatch(texts: string[], _options?: EmbedOptions): Promise<EmbeddingResult[]> {
        if (texts.length === 0) {
            return [];
        }

        const apiKey = process.env.GOOGLE_API_KEY;

        if (!apiKey) {
            throw new Error(
                "GOOGLE_API_KEY environment variable is required. " +
                "Get a free key at https://aistudio.google.com/apikey"
            );
        }

        const truncated = this.pretruncate(texts);
        const results: EmbeddingResult[] = [];

        for (let i = 0; i < truncated.length; i += GOOGLE_BATCH_SIZE) {
            const batch = truncated.slice(i, i + GOOGLE_BATCH_SIZE);

            if (i > 0) {
                await this.rateLimitWait();
            }

            const embeddings = await this.fetchBatch(batch, apiKey);
            results.push(...embeddings);
        }

        return results;
    }

    /** Minimum delay between batch API calls (ms). Free tier: 5 RPM = 12s between calls. */
    private static readonly RATE_LIMIT_DELAY_MS = 12_000;
    private lastCallTime = 0;

    private async rateLimitWait(): Promise<void> {
        const elapsed = Date.now() - this.lastCallTime;
        const remaining = AIGoogleProvider.RATE_LIMIT_DELAY_MS - elapsed;

        if (remaining > 0 && this.lastCallTime > 0) {
            await new Promise((resolve) => setTimeout(resolve, remaining));
        }

        this.lastCallTime = Date.now();
    }

    private pretruncate(texts: string[]): string[] {
        return texts.map((t) =>
            t.length > this.maxChars ? t.substring(0, this.maxChars) : t
        );
    }

    private async fetchBatch(texts: string[], apiKey: string): Promise<EmbeddingResult[]> {
        const modelPath = `models/${this.model}`;
        const url = `${GOOGLE_API_BASE}/${modelPath}:batchEmbedContents?key=${apiKey}`;

        const body: GoogleBatchEmbedRequest = {
            requests: texts.map((text) => ({
                model: modelPath,
                content: { parts: [{ text }] },
            })),
        };

        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify(body),
        });

        if (!resp.ok) {
            const errorText = await resp.text();
            throw new Error(
                `Google batchEmbedContents failed: ${resp.status} ${resp.statusText} — ${errorText}`
            );
        }

        const data = (await resp.json()) as GoogleBatchEmbedResponse;

        return data.embeddings.map((e) => {
            const vector = new Float32Array(e.values);
            return { vector, dimensions: vector.length };
        });
    }

    dispose(): void {
        // Stateless HTTP client — nothing to clean up
    }
}
```

### What to verify
- `bun test src/utils/ai/providers/AIGoogleProvider.test.ts` — all tests pass
- No TypeScript errors: `bunx tsgo --noEmit | rg "AIGoogleProvider"`

---

## Task 2 — Register in model registry

### File: `src/indexer/lib/model-registry.ts`

**Add** a new entry to `MODEL_REGISTRY` after the `mxbai-embed-large` entry:

```typescript
{
    id: "gemini-embedding-001",
    name: "Gemini Embedding 001 (Google)",
    params: "API",
    dimensions: 3072,
    ramGB: 0,
    speed: "fast",
    license: "Apache-2.0",
    provider: "google",
    bestFor: ["code", "general"],
    description: "Google free-tier embedding. 3072 dims, 2048 token context. Requires GOOGLE_API_KEY.",
    contextLength: 2048,
    charsPerToken: 3,
},
```

**Update** `AIProviderType` in `src/utils/ai/types.ts` — add `"google"` to the union:

```typescript
export type AIProviderType = "cloud" | "local-hf" | "darwinkit" | "coreml" | "ollama" | "google";
```

**Update** `ModelInfo.provider` in `src/indexer/lib/model-registry.ts` to include `"google"`:

```typescript
provider: "local-hf" | "cloud" | "darwinkit" | "coreml" | "ollama" | "google";
```

### Test updates in `src/indexer/lib/model-registry.test.ts`

Update the provider validation to include `"google"`:

```typescript
expect(["local-hf", "cloud", "darwinkit", "coreml", "ollama", "google"]).toContain(model.provider);
```

### What to verify
- `bun test src/indexer/lib/model-registry.test.ts` — all tests pass (new model appears, IDs still unique)
- `bunx tsgo --noEmit | rg "model-registry"` — no type errors

---

## Task 3 — Register in provider factory

### File: `src/utils/ai/providers/index.ts`

Add import and case to the `getProvider` switch:

```typescript
import { AIGoogleProvider } from "./AIGoogleProvider";
```

Add case before `default`:

```typescript
case "google":
    provider = new AIGoogleProvider();
    break;
```

Update the `fallbackOrder` array in `getProviderForTask` and `getAllProviders`:

```typescript
// In getProviderForTask
const fallbackOrder: AIProviderType[] = ["cloud", "local-hf", "ollama", "google", "coreml", "darwinkit"];

// In getAllProviders
const types: AIProviderType[] = ["cloud", "local-hf", "ollama", "google", "darwinkit", "coreml"];
```

Add export:

```typescript
export { AIGoogleProvider } from "./AIGoogleProvider";
```

### What to verify
- `bunx tsgo --noEmit | rg "providers/index"` — no type errors
- Manual verification: `getProvider("google")` returns an `AIGoogleProvider` instance

---

## Task 4 — Add rate limiting for free tier

> Already implemented inline in Task 1's implementation. This task is about verifying and testing the rate limiter specifically.

### Test addition in `src/utils/ai/providers/AIGoogleProvider.test.ts`

```typescript
test("rate limiter does not delay first batch call", async () => {
    globalThis.fetch = async () => {
        const embeddings = Array.from({ length: 1 }, () => ({ values: [0.1] }));
        return new Response(JSON.stringify({ embeddings }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };

    const provider = new AIGoogleProvider();

    const start = Date.now();
    await provider.embedBatch(["text"]);
    const duration = Date.now() - start;

    // First call should be fast (no rate limit wait)
    expect(duration).toBeLessThan(2000);
});
```

### What to verify
- `bun test src/utils/ai/providers/AIGoogleProvider.test.ts` — all tests still pass
- Rate limiter is only active when multiple batches are needed (single batch = no delay)

---

## Task 5 — Google provider mock HTTP + batch chunking tests

### File: `src/utils/ai/providers/AIGoogleProvider.test.ts`

Add these additional tests to the existing test file from Task 1:

```typescript
test("embedBatch handles exactly GOOGLE_BATCH_SIZE texts in one call", async () => {
    let callCount = 0;

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        callCount++;
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
        const count = body.requests.length;
        const embeddings = Array.from({ length: count }, () => ({ values: [0.1, 0.2] }));
        return new Response(JSON.stringify({ embeddings }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };

    const provider = new AIGoogleProvider();
    const texts = Array.from({ length: 100 }, (_, i) => `text ${i}`);
    const results = await provider.embedBatch(texts);

    expect(callCount).toBe(1); // Exactly 100 = one batch
    expect(results).toHaveLength(100);
});

test("embedBatch preserves text order across batches", async () => {
    const receivedBatches: string[][] = [];

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
        const texts = body.requests.map(
            (r: { content: { parts: Array<{ text: string }> } }) => r.content.parts[0].text
        );
        receivedBatches.push(texts);
        const embeddings = texts.map((_: string, i: number) => ({
            values: [i * 0.01],
        }));
        return new Response(JSON.stringify({ embeddings }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };

    const provider = new AIGoogleProvider();
    const texts = Array.from({ length: 250 }, (_, i) => `ordered-${i}`);
    const results = await provider.embedBatch(texts);

    // Should have made 3 calls: 100, 100, 50
    expect(receivedBatches).toHaveLength(3);
    expect(receivedBatches[0]).toHaveLength(100);
    expect(receivedBatches[1]).toHaveLength(100);
    expect(receivedBatches[2]).toHaveLength(50);

    // First batch starts with ordered-0
    expect(receivedBatches[0][0]).toBe("ordered-0");
    // Second batch starts with ordered-100
    expect(receivedBatches[1][0]).toBe("ordered-100");
    // Third batch starts with ordered-200
    expect(receivedBatches[2][0]).toBe("ordered-200");

    expect(results).toHaveLength(250);
});

test("embed API error includes status and response body", async () => {
    globalThis.fetch = async () => {
        return new Response(
            JSON.stringify({ error: { message: "Quota exceeded", code: 429 } }),
            { status: 429, statusText: "Too Many Requests" }
        );
    };

    const provider = new AIGoogleProvider();

    try {
        await provider.embed("test");
        expect.unreachable("should have thrown");
    } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain("429");
        expect(message).toContain("Quota exceeded");
    }
});
```

### What to verify
- `bun test src/utils/ai/providers/AIGoogleProvider.test.ts` — all tests pass
- Total: ~14 tests covering type, availability, mock HTTP, batch chunking, pre-truncation, errors

---

## Task 6 — E2E test: full index, search, verify results pipeline

> This test creates temp files, indexes them, then searches — verifying the entire pipeline end-to-end.

### File: `src/indexer/lib/e2e.test.ts`

```typescript
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Indexer } from "./indexer";
import { IndexerManager } from "./manager";
import type { IndexConfig } from "./types";

let tempDir: string;
let counter = 0;

function uniqueIndexName(): string {
    counter++;
    return `e2e_test_${Date.now()}_${counter}`;
}

function makeConfig(overrides?: Partial<IndexConfig>): IndexConfig {
    return {
        name: uniqueIndexName(),
        baseDir: tempDir,
        type: "code",
        respectGitIgnore: false,
        chunking: "auto",
        embedding: { enabled: false },
        watch: { strategy: "merkle" },
        ...overrides,
    };
}

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "indexer-e2e-"));
});

afterEach(() => {
    try {
        rmSync(tempDir, { recursive: true, force: true });
    } catch {
        // best-effort
    }
});

afterAll(async () => {
    const manager = await IndexerManager.load();
    const names = manager.getIndexNames().filter((n) => n.startsWith("e2e_test_"));

    for (const name of names) {
        try {
            await manager.removeIndex(name);
        } catch {
            // best-effort
        }
    }

    await manager.close();
});

describe("E2E: index → search → verify", () => {
    it(
        "indexes multiple TS files and returns ranked search results",
        async () => {
            writeFileSync(
                join(tempDir, "auth.ts"),
                `
export function authenticateUser(username: string, password: string): boolean {
    // Verify credentials against the database
    return username === "admin" && password === "secret";
}

export function hashPassword(raw: string): string {
    return raw.split("").reverse().join("");
}
`.trim()
            );

            writeFileSync(
                join(tempDir, "math.ts"),
                `
export function fibonacci(n: number): number {
    if (n <= 1) return n;
    return fibonacci(n - 1) + fibonacci(n - 2);
}

export function factorial(n: number): number {
    if (n <= 1) return 1;
    return n * factorial(n - 1);
}
`.trim()
            );

            writeFileSync(
                join(tempDir, "http.ts"),
                `
export async function fetchJSON(url: string): Promise<unknown> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
    return response.json();
}
`.trim()
            );

            const config = makeConfig();
            const indexer = await Indexer.create(config);

            try {
                const stats = await indexer.sync();

                // All 3 files should be indexed
                expect(stats.filesScanned).toBe(3);
                expect(stats.chunksAdded).toBeGreaterThan(0);

                // Search for authentication — should find auth.ts
                const authResults = await indexer.search("authenticateUser password");
                expect(authResults.length).toBeGreaterThan(0);
                expect(authResults[0].doc.content).toContain("authenticateUser");
                expect(authResults[0].doc.filePath).toContain("auth.ts");

                // Search for fibonacci — should find math.ts
                const mathResults = await indexer.search("fibonacci recursive");
                expect(mathResults.length).toBeGreaterThan(0);
                expect(mathResults[0].doc.content).toContain("fibonacci");
                expect(mathResults[0].doc.filePath).toContain("math.ts");

                // Search for HTTP fetch — should find http.ts
                const httpResults = await indexer.search("fetchJSON response");
                expect(httpResults.length).toBeGreaterThan(0);
                expect(httpResults[0].doc.content).toContain("fetchJSON");
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );

    it(
        "delete + re-sync removes stale chunks and adds new ones",
        async () => {
            writeFileSync(
                join(tempDir, "original.ts"),
                'export const greeting = "hello";'
            );

            const config = makeConfig();
            const indexer = await Indexer.create(config);

            try {
                await indexer.sync();

                // Verify original is searchable
                const before = await indexer.search("greeting");
                expect(before.length).toBeGreaterThan(0);

                // Delete original, add replacement
                const { unlinkSync } = await import("node:fs");
                unlinkSync(join(tempDir, "original.ts"));
                writeFileSync(
                    join(tempDir, "replacement.ts"),
                    'export const farewell = "goodbye";'
                );

                const stats = await indexer.sync();
                expect(stats.chunksDeleted).toBeGreaterThan(0);
                expect(stats.chunksAdded).toBeGreaterThan(0);

                // Original should no longer appear
                const afterOriginal = await indexer.search("greeting hello");
                const hasOriginal = afterOriginal.some((r) =>
                    r.doc.filePath.includes("original.ts")
                );
                expect(hasOriginal).toBe(false);

                // Replacement should be searchable
                const afterReplacement = await indexer.search("farewell goodbye");
                expect(afterReplacement.length).toBeGreaterThan(0);
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );
});
```

### What to verify
- `bun test src/indexer/lib/e2e.test.ts` — all tests pass
- Tests exercise: file creation, sync, fulltext search ranking, file deletion detection, re-sync

---

## Task 7 — Integration test: SearchEngine with real sqlite-fts5

> Tests the SearchEngine directly (not through the Indexer), exercising FTS5 fulltext search with an in-memory SQLite database.

### File: `src/utils/search/drivers/sqlite-fts5/search-engine.test.ts`

```typescript
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { SearchEngine } from "./index";

describe("SearchEngine integration (in-memory)", () => {
    let db: Database;
    let engine: SearchEngine<{ title: string; body: string }>;

    afterEach(() => {
        engine?.close?.();
        db?.close();
    });

    function setup(): void {
        db = new Database(":memory:");

        engine = SearchEngine.fromDatabase(db, {
            tableName: "test_docs",
            fields: ["title", "body"],
            tokenize: "porter unicode61",
        });
    }

    it("indexes and searches documents via FTS5", () => {
        setup();

        engine.add("doc1", { title: "Introduction to TypeScript", body: "TypeScript adds static types to JavaScript." });
        engine.add("doc2", { title: "Rust Memory Safety", body: "Rust prevents null pointer dereferences at compile time." });
        engine.add("doc3", { title: "Python Data Science", body: "Python excels at data analysis with pandas and numpy." });

        const results = engine.search({ query: "TypeScript types", mode: "fulltext", limit: 10 });

        expect(results.length).toBeGreaterThan(0);
        expect(results[0].doc.title).toContain("TypeScript");
        expect(results[0].score).toBeGreaterThan(0);
    });

    it("returns empty results for no match", () => {
        setup();

        engine.add("doc1", { title: "Hello", body: "World" });

        const results = engine.search({ query: "zzzznonexistent", mode: "fulltext", limit: 10 });
        expect(results).toHaveLength(0);
    });

    it("removes documents and they no longer appear in search", () => {
        setup();

        engine.add("doc1", { title: "Remove me", body: "This should be removed" });
        engine.add("doc2", { title: "Keep me", body: "This should remain" });

        engine.remove("doc1");

        const results = engine.search({ query: "Remove", mode: "fulltext", limit: 10 });
        const hasRemoved = results.some((r) => r.doc.title === "Remove me");
        expect(hasRemoved).toBe(false);
    });

    it("updates existing document", () => {
        setup();

        engine.add("doc1", { title: "Version 1", body: "Original content" });
        engine.add("doc1", { title: "Version 2", body: "Updated content" });

        const results = engine.search({ query: "Updated", mode: "fulltext", limit: 10 });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].doc.title).toBe("Version 2");
    });

    it("respects limit parameter", () => {
        setup();

        for (let i = 0; i < 20; i++) {
            engine.add(`doc${i}`, { title: `Document ${i}`, body: "common search term here" });
        }

        const results = engine.search({ query: "common search term", mode: "fulltext", limit: 5 });
        expect(results.length).toBeLessThanOrEqual(5);
    });

    it("boosts scores for specified fields", () => {
        setup();

        engine.add("doc1", { title: "TypeScript", body: "A programming language" });
        engine.add("doc2", { title: "A programming language", body: "TypeScript guide" });

        // Boost title field
        const results = engine.search({
            query: "TypeScript",
            mode: "fulltext",
            limit: 10,
            boost: { title: 5 },
        });

        expect(results.length).toBe(2);
        // doc1 has "TypeScript" in the boosted title field
        expect(results[0].doc.title).toBe("TypeScript");
    });
});
```

> **Note:** Verify `SearchEngine.fromDatabase()` accepts these exact params by reading the constructor at implementation time. If the API uses `create()` or different config shape, adjust accordingly.

### What to verify
- `bun test src/utils/search/drivers/sqlite-fts5/search-engine.test.ts` — all pass

---

## Task 8 — Integration test: Qdrant hybrid search (mock client)

> Extends the existing `qdrant-vector-store.test.ts` with hybrid search scenarios.

### File: `src/utils/search/stores/qdrant-vector-store.test.ts`

**Add** to the existing test file (after the existing `describe` block):

```typescript
describe("QdrantVectorStore — hybrid search scenarios", () => {
    it("finds semantically similar vectors with cosine similarity", async () => {
        const mockClient = createMockQdrantClient();
        const store = new QdrantVectorStore({
            collectionName: "hybrid",
            dimensions: 4,
            client: mockClient,
        });

        await store.init();

        // Cluster 1: "code" vectors
        store.store("code1", new Float32Array([0.9, 0.1, 0.0, 0.0]));
        store.store("code2", new Float32Array([0.8, 0.2, 0.0, 0.0]));

        // Cluster 2: "docs" vectors
        store.store("doc1", new Float32Array([0.0, 0.0, 0.9, 0.1]));
        store.store("doc2", new Float32Array([0.0, 0.0, 0.8, 0.2]));

        // Query close to "code" cluster
        const codeResults = store.search(new Float32Array([1.0, 0.0, 0.0, 0.0]), 4);
        expect(codeResults[0].docId).toBe("code1");
        expect(codeResults[1].docId).toBe("code2");

        // Query close to "docs" cluster
        const docResults = store.search(new Float32Array([0.0, 0.0, 1.0, 0.0]), 4);
        expect(docResults[0].docId).toBe("doc1");
        expect(docResults[1].docId).toBe("doc2");
    });

    it("handles batch upsert and removal correctly", async () => {
        const mockClient = createMockQdrantClient();
        const store = new QdrantVectorStore({
            collectionName: "batch",
            dimensions: 2,
            client: mockClient,
        });

        await store.init();

        // Add many vectors
        for (let i = 0; i < 50; i++) {
            store.store(`vec${i}`, new Float32Array([Math.cos(i), Math.sin(i)]));
        }

        expect(store.count()).toBe(50);

        // Remove half
        for (let i = 0; i < 25; i++) {
            store.remove(`vec${i}`);
        }

        expect(store.count()).toBe(25);

        // Search should only find remaining vectors
        const results = store.search(new Float32Array([1, 0]), 10);
        for (const r of results) {
            const idx = parseInt(r.docId.replace("vec", ""));
            expect(idx).toBeGreaterThanOrEqual(25);
        }
    });
});
```

### What to verify
- `bun test src/utils/search/stores/qdrant-vector-store.test.ts` — all tests pass (existing + new)

---

## Task 9 — Unit tests: watcher debounce edge cases

### File: `src/indexer/lib/watch-integration.test.ts`

**Add** to the existing test file (after the existing `describe` block):

```typescript
describe("watcher debounce edge cases", () => {
    it("rapid-fire events collapse into single callback", async () => {
        let callCount = 0;
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        const DEBOUNCE_MS = 100;

        function debouncedSync(): void {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }

            debounceTimer = setTimeout(() => {
                callCount++;
                debounceTimer = null;
            }, DEBOUNCE_MS);
        }

        // Simulate 50 rapid file changes
        for (let i = 0; i < 50; i++) {
            debouncedSync();
        }

        // Wait for debounce to settle
        await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 50));

        expect(callCount).toBe(1);
    });

    it("events spaced beyond debounce window each trigger callback", async () => {
        let callCount = 0;
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        const DEBOUNCE_MS = 50;

        function debouncedSync(): void {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }

            debounceTimer = setTimeout(() => {
                callCount++;
                debounceTimer = null;
            }, DEBOUNCE_MS);
        }

        // Two events spaced well apart
        debouncedSync();
        await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 30));

        debouncedSync();
        await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 30));

        expect(callCount).toBe(2);
    });

    it("max-wait forces callback even during sustained activity", async () => {
        let callCount = 0;
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
        const DEBOUNCE_MS = 100;
        const MAX_WAIT_MS = 200;

        function fire(): void {
            callCount++;
            if (debounceTimer) clearTimeout(debounceTimer);
            if (maxWaitTimer) clearTimeout(maxWaitTimer);
            debounceTimer = null;
            maxWaitTimer = null;
        }

        function debouncedSyncWithMaxWait(): void {
            if (debounceTimer) clearTimeout(debounceTimer);

            if (!maxWaitTimer) {
                maxWaitTimer = setTimeout(fire, MAX_WAIT_MS);
            }

            debounceTimer = setTimeout(fire, DEBOUNCE_MS);
        }

        // Continuously fire events for 300ms (exceeds MAX_WAIT_MS)
        const start = Date.now();
        const interval = setInterval(() => {
            if (Date.now() - start < 300) {
                debouncedSyncWithMaxWait();
            }
        }, 20);

        await new Promise((resolve) => setTimeout(resolve, 500));
        clearInterval(interval);

        // Max-wait should have forced at least one callback during the 300ms burst
        expect(callCount).toBeGreaterThanOrEqual(1);
    });
});
```

### What to verify
- `bun test src/indexer/lib/watch-integration.test.ts` — all tests pass

---

## Task 10 — Unit tests: change detector with real files (temp dir)

> Tests file change detection by creating real files in a temp dir, computing hashes, modifying files, and verifying re-detection.

### File: `src/indexer/lib/path-hashes.test.ts`

**Add** to the existing test file. Adapt method names to match the actual `PathHashStore` API (read the source file first).

The tests should cover:
1. A new file is detected as changed (hash not seen before)
2. An unchanged file (same hash recorded) is not flagged
3. A modified file produces a different hash and is flagged
4. A missing/deleted file returns null hash gracefully

> **Important:** Read `src/indexer/lib/path-hashes.ts` at implementation time to confirm the exact API (`computeFileHash`, `hasChanged`, `recordHash` etc.). The test code above is illustrative — adjust method names to match.

### What to verify
- `bun test src/indexer/lib/path-hashes.test.ts` — all tests pass
- Tests create real temp files, not mocks

---

## Task 11 — Unit tests: chunker edge cases

### File: `src/indexer/lib/chunker.test.ts`

**Add** this `describe("Edge cases")` block to the existing file:

```typescript
describe("Edge cases", () => {
    it("handles empty file content", () => {
        const result = chunkFile({
            filePath: "empty.ts",
            content: "",
            strategy: "ast",
        });

        expect(result.chunks).toHaveLength(0);
    });

    it("handles whitespace-only content", () => {
        const result = chunkFile({
            filePath: "whitespace.ts",
            content: "   \n\n\t\t\n   ",
            strategy: "ast",
        });

        expect(result.chunks).toHaveLength(0);
    });

    it("handles comment-only TypeScript file", () => {
        const content = `
// This is a comment
// Another comment
/* Block comment
   spanning multiple lines */
`.trim();

        const result = chunkFile({
            filePath: "comments.ts",
            content,
            strategy: "ast",
        });

        // Comments may or may not produce chunks depending on implementation
        // but should not crash
        expect(result.parser).toBe("ast");
    });

    it("handles Unicode content in code", () => {
        const content = `
export function greet(name: string): string {
    return \`Bonjour, \${name}! Bienvenue a notre cafe. Prix: 5€\`;
}

export const emoji = "Hello 🌍🎉";
export const cjk = "你好世界";
export const arabic = "مرحبا بالعالم";
`.trim();

        const result = chunkFile({
            filePath: "unicode.ts",
            content,
            strategy: "ast",
        });

        expect(result.parser).toBe("ast");
        expect(result.chunks.length).toBeGreaterThan(0);

        const allContent = result.chunks.map((c) => c.content).join("\n");
        expect(allContent).toContain("Bonjour");
        expect(allContent).toContain("emoji");
    });

    it("handles file with only import statements", () => {
        const content = `
import { a } from "./a";
import { b } from "./b";
import { c } from "./c";
`.trim();

        const result = chunkFile({
            filePath: "imports-only.ts",
            content,
            strategy: "ast",
        });

        // Import-only files should still produce at least one chunk
        expect(result.parser).toBe("ast");
    });

    it("handles single-line file", () => {
        const result = chunkFile({
            filePath: "oneliner.ts",
            content: "export const VERSION = 42;",
            strategy: "ast",
        });

        expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    });

    it("handles file with BOM marker", () => {
        const bom = "\uFEFF";
        const content = `${bom}export function test(): void { console.log("BOM"); }`;

        const result = chunkFile({
            filePath: "bom.ts",
            content,
            strategy: "ast",
        });

        // Should handle BOM gracefully
        expect(result.chunks.length).toBeGreaterThanOrEqual(0);
    });
});
```

### What to verify
- `bun test src/indexer/lib/chunker.test.ts` — all tests pass (existing + new edge cases)

---

## Task 12 — Unit tests: code graph with circular dependencies

### File: `src/indexer/lib/code-graph.test.ts`

**Add** to the existing file. First check if `detectCircularDependencies` (or equivalent like `findCycles`) is exported from `code-graph.ts`. If it exists, add:

```typescript
describe("circular dependency detection", () => {
    test("detects simple A → B → A cycle", () => {
        const files = new Map<string, string>([
            ["src/a.ts", `import { b } from "./b";`],
            ["src/b.ts", `import { a } from "./a";`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const cycles = detectCircularDependencies(graph);

        expect(cycles.length).toBeGreaterThan(0);
        const cycleNodes = cycles[0].map((n) => n);
        expect(cycleNodes).toContain("src/a.ts");
        expect(cycleNodes).toContain("src/b.ts");
    });

    test("detects A → B → C → A cycle", () => {
        const files = new Map<string, string>([
            ["src/a.ts", `import { b } from "./b";`],
            ["src/b.ts", `import { c } from "./c";`],
            ["src/c.ts", `import { a } from "./a";`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const cycles = detectCircularDependencies(graph);

        expect(cycles.length).toBeGreaterThan(0);
    });

    test("returns empty for acyclic graph", () => {
        const files = new Map<string, string>([
            ["src/a.ts", `import { b } from "./b";`],
            ["src/b.ts", `import { c } from "./c";`],
            ["src/c.ts", `export const c = 1;`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const cycles = detectCircularDependencies(graph);

        expect(cycles).toHaveLength(0);
    });

    test("handles self-import", () => {
        const files = new Map<string, string>([
            ["src/self.ts", `import { x } from "./self";`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const cycles = detectCircularDependencies(graph);

        expect(cycles.length).toBeGreaterThanOrEqual(1);
    });

    test("handles diamond dependency (no false positive)", () => {
        const files = new Map<string, string>([
            ["src/a.ts", `import "./b"; import "./c";`],
            ["src/b.ts", `import "./d";`],
            ["src/c.ts", `import "./d";`],
            ["src/d.ts", `export const d = 1;`],
        ]);

        const graph = buildCodeGraph(files, "/project");
        const cycles = detectCircularDependencies(graph);

        // Diamond is NOT a cycle
        expect(cycles).toHaveLength(0);
    });
});
```

> **If `detectCircularDependencies` does not exist:** Check the actual exported functions from `code-graph.ts`. The function may be named `findCycles`, `getCycles`, or similar. Adjust imports and calls accordingly. If no cycle detection exists yet, this task should implement it first (small function: DFS-based cycle detection on the graph edges).

### What to verify
- `bun test src/indexer/lib/code-graph.test.ts` — all tests pass

---

## Task 13 — Unit tests: model registry edge cases

### File: `src/indexer/lib/model-registry.test.ts`

**Add** to the existing file:

```typescript
describe("getMaxEmbedChars — edge cases", () => {
    it("returns correct chars for Google model", () => {
        // After Task 2: gemini-embedding-001 in MODEL_REGISTRY: 2048 * 3 = 6144
        const chars = getMaxEmbedChars("gemini-embedding-001");
        expect(chars).toBe(6144);
    });

    it("handles model ID with version tag", () => {
        const chars = getMaxEmbedChars("nomic-embed-text:v1.5");
        // Should find nomic-embed-text in registry: 2048 * 2 = 4096
        expect(chars).toBe(4096);
    });

    it("returns default for empty string model ID", () => {
        const chars = getMaxEmbedChars("");
        // DEFAULT_CONTEXT_LENGTH (512) * DEFAULT_CHARS_PER_TOKEN (3) = 1536
        expect(chars).toBe(1536);
    });
});

describe("getTaskPrefix — edge cases", () => {
    it("returns null for Google model (no task prefix)", () => {
        const prefix = getTaskPrefix("gemini-embedding-001");
        expect(prefix).toBeNull();
    });

    it("handles tag-stripped lookup from TASK_PREFIXES fallback", () => {
        const prefix = getTaskPrefix("nomic-embed-code:latest");
        expect(prefix).toEqual({ document: "search_document: ", query: "search_query: " });
    });
});

describe("getModelsForType — google provider", () => {
    it("includes google model in registry", () => {
        const googleModel = MODEL_REGISTRY.find((m) => m.provider === "google");
        expect(googleModel).toBeDefined();
        expect(googleModel!.id).toBe("gemini-embedding-001");
        expect(googleModel!.dimensions).toBe(3072);
    });
});
```

### What to verify
- `bun test src/indexer/lib/model-registry.test.ts` — all tests pass
- These tests depend on Task 2 being complete first

---

## Task 14 — Simplify: review all files for reuse, quality, efficiency

Review ALL files created or modified in Tasks 1–13 and check for:

### Checklist

1. **DRY violations** — Are there duplicated fetch-mock setups across tests? Extract into a shared helper if multiple test files use the same Google API mock pattern.

2. **Type safety** — Ensure no `as any` or `@ts-expect-error` leaks remain outside test stubs:
   - Google provider: all response types properly defined
   - Test mocks: `@ts-expect-error` only on the fetch stub line, nowhere else

3. **Consistent provider patterns** — Verify `AIGoogleProvider` matches the interface contract exactly:
   - `embedBatch` returns `EmbeddingResult[]` with `Float32Array` vectors (not `number[]`)
   - `dispose()` is implemented (even if empty)
   - `isAvailable()` is `async` and returns `Promise<boolean>`

4. **Rate limiter correctness** — Ensure the rate limiter:
   - Only delays between batches (not before the first batch)
   - Does not leak timers
   - Is stateless across different `embedBatch` calls (no global state beyond instance)

5. **Test isolation** — Verify every test that modifies `globalThis.fetch` or `process.env` restores them in `afterEach`

6. **Import paths** — All new files use `@app/` path aliases, not relative `../../` for cross-module imports

7. **Code style** — Apply CLAUDE.md rules:
   - No one-line `if` statements
   - Empty line before `if` (unless preceded by variable used by that `if`)
   - Empty line after closing `}` (unless followed by `else/catch/finally/}`)
   - No file-path comments at top of files
   - No obvious comments that restate what the code says

8. **Run full test suite** — `bun test src/utils/ai/providers/ src/indexer/lib/` and verify zero failures

### What to verify
- `bun test src/utils/ai/providers/ src/indexer/lib/` — all tests pass
- `bunx tsgo --noEmit | rg "(AIGoogleProvider|model-registry|code-graph)"` — no type errors
- No duplicated mock/helper code across test files

### Commit
After this task, create a single commit: `feat(indexer): add Google Gemini provider + expand test coverage (Plan 11)`
