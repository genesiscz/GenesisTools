import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isDarwin = process.platform === "darwin";

interface Article {
    id: string;
    title: string;
    body: string;
    category: string;
    [key: string]: unknown;
}

const DATASET: Article[] = [
    {
        id: "1",
        title: "Introduction to Machine Learning",
        body: "Machine learning is a subset of artificial intelligence that enables systems to learn from data. Neural networks, decision trees, and support vector machines are common algorithms used in supervised learning.",
        category: "ml",
    },
    {
        id: "2",
        title: "PostgreSQL Full-Text Search",
        body: "PostgreSQL provides powerful full-text search capabilities using tsvector and tsquery. GIN indexes accelerate text search queries. BM25 ranking can be implemented with custom functions.",
        category: "database",
    },
    {
        id: "3",
        title: "Building REST APIs with TypeScript",
        body: "TypeScript adds static type checking to JavaScript, making it ideal for building robust REST APIs. Express and Fastify are popular frameworks for Node.js server development.",
        category: "programming",
    },
    {
        id: "4",
        title: "Vector Embeddings for Semantic Search",
        body: "Vector embeddings transform text into dense numerical representations that capture semantic meaning. Cosine similarity measures the angle between embedding vectors to find semantically similar documents.",
        category: "ml",
    },
    {
        id: "5",
        title: "SQLite FTS5 Full-Text Search Engine",
        body: "SQLite FTS5 is a virtual table module that provides full-text search with BM25 ranking. It supports prefix queries, phrase matching, and boolean operators. FTS5 tokenizes text using unicode61.",
        category: "database",
    },
    {
        id: "6",
        title: "React Component Architecture",
        body: "React components should follow the single responsibility principle. Compound components, render props, and hooks enable flexible and reusable UI patterns. State management with Redux or Zustand.",
        category: "programming",
    },
    {
        id: "7",
        title: "Natural Language Processing Pipeline",
        body: "NLP pipelines include tokenization, part-of-speech tagging, named entity recognition, and sentiment analysis. Transformer models like BERT revolutionized language understanding tasks.",
        category: "ml",
    },
    {
        id: "8",
        title: "Database Indexing Strategies",
        body: "B-tree indexes provide efficient lookups for equality and range queries. Hash indexes excel at exact matches. Covering indexes include all columns needed by a query, avoiding table lookups.",
        category: "database",
    },
];

describe("Search Full Flow E2E", () => {
    let tmpDir: string;

    afterEach(() => {
        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    describe("FTS5 fulltext-only flow", () => {
        it("indexes dataset and searches with BM25 ranking", async () => {
            const { SearchEngine } = await import("@app/utils/search");

            tmpDir = mkdtempSync(join(tmpdir(), "search-flow-"));
            const dbPath = join(tmpDir, "articles.db");

            const engine = new SearchEngine<Article>({
                dbPath,
                tableName: "articles",
                schema: {
                    textFields: ["title", "body"],
                    idField: "id",
                },
            });

            try {
                await engine.insertMany(DATASET);
                expect(engine.count).toBe(8);

                // Search for "machine learning" — should find articles 1, 4, 7
                const mlResults = await engine.search({ query: "machine learning", mode: "fulltext" });
                expect(mlResults.length).toBeGreaterThanOrEqual(1);
                expect(mlResults[0].method).toBe("bm25");
                expect(mlResults[0].score).toBeGreaterThan(0);

                const mlIds = mlResults.map((r) => r.doc.id);
                expect(mlIds).toContain("1");

                // Search for "database indexing" — should find articles 2, 5, 8
                const dbResults = await engine.search({ query: "database indexing", mode: "fulltext" });
                expect(dbResults.length).toBeGreaterThanOrEqual(1);

                const dbIds = dbResults.map((r) => r.doc.id);
                expect(dbIds).toContain("8");

                // Search for "TypeScript REST" — should find article 3
                const tsResults = await engine.search({ query: "TypeScript REST", mode: "fulltext" });
                expect(tsResults.length).toBeGreaterThanOrEqual(1);
                expect(tsResults[0].doc.id).toBe("3");

                // Search with boost: title should rank higher
                const boostedResults = engine.bm25Search("search", 10, { title: 3.0, body: 1.0 });
                expect(boostedResults.length).toBeGreaterThanOrEqual(2);

                // Verify BM25 scores are positive and sorted descending
                for (let i = 1; i < boostedResults.length; i++) {
                    expect(boostedResults[i - 1].score).toBeGreaterThanOrEqual(boostedResults[i].score);
                }

                // No results for nonsense
                const noResults = await engine.search({ query: "xyznonexistent", mode: "fulltext" });
                expect(noResults.length).toBe(0);

                // Limit works
                const limited = await engine.search({ query: "search", mode: "fulltext", limit: 2 });
                expect(limited.length).toBeLessThanOrEqual(2);
            } finally {
                await engine.close();
            }
        });

        it("persists data across engine instances", async () => {
            const { SearchEngine } = await import("@app/utils/search");

            tmpDir = mkdtempSync(join(tmpdir(), "search-persist-"));
            const dbPath = join(tmpDir, "persist.db");

            const engine1 = new SearchEngine<Article>({
                dbPath,
                tableName: "docs",
                schema: { textFields: ["title", "body"], idField: "id" },
            });

            await engine1.insertMany(DATASET.slice(0, 4));
            expect(engine1.count).toBe(4);
            await engine1.close();

            // Reopen same DB — data should persist
            const engine2 = new SearchEngine<Article>({
                dbPath,
                tableName: "docs",
                schema: { textFields: ["title", "body"], idField: "id" },
            });

            expect(engine2.count).toBe(4);

            const results = await engine2.search({ query: "machine learning", mode: "fulltext" });
            expect(results.length).toBeGreaterThanOrEqual(1);
            await engine2.close();
        });
    });

    describe.skipIf(!isDarwin)("FTS5 with DarwinKit embeddings (vector + hybrid)", () => {
        it("full flow: dataset → embeddings → vector search → hybrid search", async () => {
            const { SearchEngine } = await import("@app/utils/search");
            const { Embedder } = await import("@app/utils/ai");

            tmpDir = mkdtempSync(join(tmpdir(), "search-vector-"));
            const dbPath = join(tmpDir, "vector.db");

            const embedder = await Embedder.create();
            expect(embedder.dimensions).toBeGreaterThan(0);

            const engine = new SearchEngine<Article>({
                dbPath,
                tableName: "articles",
                schema: {
                    textFields: ["title", "body"],
                    idField: "id",
                    vectorField: "body",
                },
                embedder,
            });

            try {
                // Insert documents — embeddings are generated async
                for (const doc of DATASET) {
                    await engine.insert(doc);
                }

                // Give async embedding storage a moment to complete
                await new Promise((resolve) => setTimeout(resolve, 2000));

                expect(engine.count).toBe(8);

                // Vector search: "understand language meaning" — should find NLP/ML articles
                const vecResults = await engine.search({
                    query: "understand language meaning",
                    mode: "vector",
                    limit: 5,
                });

                expect(vecResults.length).toBeGreaterThan(0);
                expect(vecResults[0].method).toBe("cosine");
                expect(vecResults[0].score).toBeGreaterThan(0);

                // The top results should be semantically related to NLP/ML (ids 1, 4, 7)
                const topIds = vecResults.slice(0, 4).map((r) => r.doc.id);
                const mlIds = ["1", "4", "7"];
                const hasMLDoc = topIds.some((id) => mlIds.includes(id));
                expect(hasMLDoc).toBe(true);

                // Hybrid search: "full text search database" — combines BM25 + vector
                const hybridResults = await engine.search({
                    query: "full text search database",
                    mode: "hybrid",
                    limit: 5,
                });

                expect(hybridResults.length).toBeGreaterThan(0);
                expect(hybridResults[0].method).toBe("rrf");

                // Hybrid should find FTS5 article (id=5) since it matches both keyword AND semantics
                const hybridIds = hybridResults.map((r) => r.doc.id);
                expect(hybridIds).toContain("5");

                // Vector search with pre-computed embedding
                const queryEmbed = await embedder.embed("artificial intelligence neural networks");
                const preComputedResults = await engine.cosineSearch(queryEmbed.vector, 3);

                expect(preComputedResults.length).toBeGreaterThan(0);
                expect(preComputedResults[0].method).toBe("cosine");

                // Hybrid with explicit weights
                const weightedResults = await engine.search({
                    query: "database performance",
                    mode: "hybrid",
                    limit: 5,
                    hybridWeights: { text: 0.7, vector: 0.3 },
                });

                expect(weightedResults.length).toBeGreaterThan(0);
            } finally {
                await engine.close();
                embedder.dispose();
            }
        }, 30_000);

        it("embedder generates consistent dimensions", async () => {
            const { Embedder } = await import("@app/utils/ai");
            const embedder = await Embedder.create();

            try {
                const result1 = await embedder.embed("Hello world");
                const result2 = await embedder.embed("Goodbye world");

                expect(result1.dimensions).toBe(result2.dimensions);
                expect(result1.vector.length).toBe(result1.dimensions);
                expect(result2.vector.length).toBe(result2.dimensions);

                // Vectors should be different for different inputs
                let identical = true;
                for (let i = 0; i < result1.vector.length; i++) {
                    if (Math.abs(result1.vector[i] - result2.vector[i]) > 1e-6) {
                        identical = false;
                        break;
                    }
                }

                expect(identical).toBe(false);

                // embedMany returns same dimensions
                const batch = await embedder.embedMany(["alpha", "beta", "gamma"]);
                expect(batch.length).toBe(3);

                for (const r of batch) {
                    expect(r.dimensions).toBe(result1.dimensions);
                }
            } finally {
                embedder.dispose();
            }
        }, 15_000);
    });

    describe("Orama full flow", () => {
        it("indexes dataset and searches with fulltext", async () => {
            const { OramaSearchEngine } = await import("@app/utils/search");

            const engine = new OramaSearchEngine<Article>({
                schema: {
                    id: "string",
                    title: "string",
                    body: "string",
                    category: "string",
                },
            });

            try {
                await engine.insertMany(DATASET);
                expect(engine.count).toBe(8);

                // Fulltext search
                const results = await engine.search({ query: "machine learning", mode: "fulltext", limit: 5 });
                expect(results.length).toBeGreaterThan(0);
                expect(results[0].method).toBe("bm25");

                // Different query
                const dbResults = await engine.search({ query: "database indexing", mode: "fulltext", limit: 5 });
                expect(dbResults.length).toBeGreaterThan(0);

                // Remove and verify
                await engine.remove("1");
                expect(engine.count).toBe(7);

                const afterRemove = await engine.search({ query: "Introduction to Machine", mode: "fulltext" });
                const removedIds = afterRemove.map((r) => r.doc.id);
                expect(removedIds).not.toContain("1");
            } finally {
                await engine.close();
            }
        });

        it("persists to file and restores", async () => {
            const { OramaSearchEngine } = await import("@app/utils/search");

            tmpDir = mkdtempSync(join(tmpdir(), "orama-persist-"));
            const persistPath = join(tmpDir, "index.json");

            const engine1 = new OramaSearchEngine<Article>({
                schema: {
                    id: "string",
                    title: "string",
                    body: "string",
                    category: "string",
                },
                persistPath,
            });

            await engine1.insertMany(DATASET.slice(0, 3));
            expect(engine1.count).toBe(3);
            await engine1.close(); // triggers persist

            // Restore from file
            const engine2 = new OramaSearchEngine<Article>({
                schema: {
                    id: "string",
                    title: "string",
                    body: "string",
                    category: "string",
                },
                persistPath,
            });

            // Need to search to trigger lazy init from persist
            const results = await engine2.search({ query: "machine", mode: "fulltext" });
            expect(results.length).toBeGreaterThanOrEqual(1);
            expect(engine2.count).toBe(3);
            await engine2.close();
        });
    });
});
