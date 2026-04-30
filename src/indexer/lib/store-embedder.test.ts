import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Indexer } from "./indexer";
import { IndexerManager } from "./manager";
import { getIndexerStorage } from "./storage";
import type { IndexConfig } from "./types";

/**
 * These tests verify that vector and hybrid search modes work end-to-end
 * through the Indexer → IndexStore → SearchEngine pipeline.
 *
 * Bug hypothesis: createIndexStore() creates SearchEngine without
 * passing the embedder. When search() is called with mode "vector" or
 * "hybrid", SearchEngine.cosineSearch() tries to embed the query
 * string but has no embedder, throwing:
 *   "Vector search requires an embedder or a pre-computed embedding"
 *
 * Fulltext mode works because BM25 keyword search doesn't need embeddings.
 */

const isDarwin = process.platform === "darwin";

let tempDir: string;
let counter = 0;

function uniqueName(): string {
    counter++;
    return `store_emb_test_${Date.now()}_${counter}`;
}

function createConfig(overrides?: Partial<IndexConfig>): IndexConfig {
    return {
        name: uniqueName(),
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
    tempDir = mkdtempSync(join(tmpdir(), "store-emb-test-"));

    writeFileSync(
        join(tempDir, "auth.ts"),
        `
export function authenticateUser(username: string, password: string): boolean {
    return username === "admin" && password === "secret";
}

export function generateToken(userId: string): string {
    return \`token_\${userId}_\${Date.now()}\`;
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
});

afterEach(() => {
    try {
        rmSync(tempDir, { recursive: true, force: true });
    } catch {
        // best-effort cleanup
    }
});

afterAll(async () => {
    const manager = await IndexerManager.load();
    const names = manager.getIndexNames().filter((n) => n.startsWith("store_emb_test_"));

    for (const name of names) {
        try {
            await manager.removeIndex(name);
        } catch {
            // best-effort
        }
    }

    await manager.close();

    // Filesystem-only leftovers from interrupted setups.
    getIndexerStorage().cleanStaleDirs("store_emb_test_");
});

describe("IndexStore embedder integration", () => {
    it(
        "fulltext search works without embedder (baseline)",
        async () => {
            const config = createConfig();
            const indexer = await Indexer.create(config);

            try {
                await indexer.sync();

                // Fulltext/BM25 should work without embedder
                const results = await indexer.search("authenticateUser", { mode: "fulltext" });
                expect(results.length).toBeGreaterThan(0);
                expect(results[0].method).toBe("bm25");
                expect(results[0].doc.content).toContain("authenticateUser");
            } finally {
                await indexer.close();
            }
        },
        { timeout: 30_000 }
    );

    describe.skipIf(!isDarwin)("with embedder (darwinkit)", () => {
        it(
            "vector search returns cosine-scored results",
            async () => {
                const config = createConfig({
                    embedding: { enabled: true, provider: "darwinkit" },
                });
                const indexer = await Indexer.create(config);

                try {
                    await indexer.sync();

                    // Vector search should embed the query and return cosine results
                    const results = await indexer.search("authentication login", { mode: "vector" });
                    expect(results.length).toBeGreaterThan(0);
                    expect(results[0].method).toBe("cosine");
                    expect(results[0].score).toBeGreaterThan(0);
                } finally {
                    await indexer.close();
                }
            },
            { timeout: 30_000 }
        );

        it(
            "hybrid search returns RRF-fused results",
            async () => {
                const config = createConfig({
                    embedding: { enabled: true, provider: "darwinkit" },
                });
                const indexer = await Indexer.create(config);

                try {
                    await indexer.sync();

                    // Hybrid should combine BM25 + cosine via RRF
                    const results = await indexer.search("fibonacci recursive", { mode: "hybrid" });
                    expect(results.length).toBeGreaterThan(0);
                    expect(results[0].method).toBe("rrf");
                    expect(results[0].score).toBeGreaterThan(0);
                } finally {
                    await indexer.close();
                }
            },
            { timeout: 30_000 }
        );

        it(
            "vector search finds semantically related content, not just keyword matches",
            async () => {
                const config = createConfig({
                    embedding: { enabled: true, provider: "darwinkit" },
                });
                const indexer = await Indexer.create(config);

                try {
                    await indexer.sync();

                    // "security credentials" doesn't appear literally in the code
                    // but should match the auth functions semantically
                    const results = await indexer.search("security credentials", { mode: "vector" });
                    expect(results.length).toBeGreaterThan(0);

                    // At least one result should be from auth.ts
                    const hasAuth = results.some((r) => r.doc.filePath.includes("auth.ts"));
                    expect(hasAuth).toBe(true);
                } finally {
                    await indexer.close();
                }
            },
            { timeout: 30_000 }
        );

        it(
            "embeddings are stored during sync and persist for search",
            async () => {
                const config = createConfig({
                    embedding: { enabled: true, provider: "darwinkit" },
                });

                // First indexer: sync with embeddings
                const indexer1 = await Indexer.create(config);

                try {
                    const stats = await indexer1.sync();
                    expect(stats.embeddingsGenerated).toBeGreaterThan(0);
                } finally {
                    await indexer1.close();
                }

                // Second indexer: search should work with stored embeddings
                const indexer2 = await Indexer.create(config);

                try {
                    const results = await indexer2.search("mathematical computation", {
                        mode: "vector",
                    });
                    expect(results.length).toBeGreaterThan(0);
                    expect(results[0].method).toBe("cosine");
                } finally {
                    await indexer2.close();
                }
            },
            { timeout: 30_000 }
        );

        it(
            "fulltext still works when embedder is configured",
            async () => {
                const config = createConfig({
                    embedding: { enabled: true, provider: "darwinkit" },
                });
                const indexer = await Indexer.create(config);

                try {
                    await indexer.sync();

                    // BM25 should still work alongside vector
                    const results = await indexer.search("factorial", { mode: "fulltext" });
                    expect(results.length).toBeGreaterThan(0);
                    expect(results[0].method).toBe("bm25");
                    expect(results[0].doc.content).toContain("factorial");
                } finally {
                    await indexer.close();
                }
            },
            { timeout: 30_000 }
        );
    });
});
