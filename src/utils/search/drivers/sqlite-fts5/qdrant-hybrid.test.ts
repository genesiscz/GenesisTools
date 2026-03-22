import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "@app/utils/ai/tasks/Embedder";
import { SearchEngine } from "./index";

describe("SearchEngine with QdrantVectorStore hybrid path", () => {
    let tmpDir: string;

    afterEach(() => {
        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("uses Qdrant hybrid search when vectorStore has searchHybridAsync", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "qdrant-hybrid-"));
        const dbPath = join(tmpDir, "test.db");

        const mockVectorStore = {
            store: mock(() => {}),
            remove: mock(() => {}),
            search: mock(() => []),
            count: mock(() => 0),
            searchHybridAsync: mock(async () => [
                { docId: "1", score: 0.95 },
                { docId: "2", score: 0.8 },
            ]),
        };

        // Minimal mock embedder (cast needed: Embedder has private fields)
        const mockEmbedder = {
            dimensions: 3,
            embed: mock(async () => ({
                vector: new Float32Array([1, 0, 0]),
                tokens: 5,
            })),
            embedBatch: mock(async () => []),
        } as unknown as Embedder;

        const engine = new SearchEngine({
            dbPath,
            tableName: "docs",
            schema: {
                textFields: ["content"],
                idField: "id",
                vectorField: "content",
            },
            vectorStore: mockVectorStore,
            embedder: mockEmbedder,
        });

        // Insert test docs directly into content table
        // biome-ignore lint/complexity/useLiteralKeys: accessing private method in test
        engine["insertSync"]({ id: "1", content: "TypeScript programming" });
        // biome-ignore lint/complexity/useLiteralKeys: accessing private method in test
        engine["insertSync"]({ id: "2", content: "JavaScript frameworks" });

        const results = await engine.search({
            query: "typescript",
            mode: "hybrid",
            limit: 5,
        });

        // Should have used the Qdrant hybrid path
        expect(mockVectorStore.searchHybridAsync).toHaveBeenCalled();
        expect(results.length).toBe(2);
        expect(results[0].method).toBe("rrf");
    });

    it("falls back to client-side RRF when vectorStore lacks searchHybridAsync", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "qdrant-hybrid-"));
        const dbPath = join(tmpDir, "test.db");

        // Plain vector store without hybrid support
        const plainVectorStore = {
            store: mock(() => {}),
            remove: mock(() => {}),
            search: mock(() => [
                { docId: "1", score: 0.9 },
                { docId: "2", score: 0.7 },
            ]),
            count: mock(() => 2),
        };

        const mockEmbedder = {
            dimensions: 3,
            embed: mock(async () => ({
                vector: new Float32Array([1, 0, 0]),
                tokens: 5,
            })),
            embedBatch: mock(async () => []),
        } as unknown as Embedder;

        const engine = new SearchEngine({
            dbPath,
            tableName: "docs",
            schema: {
                textFields: ["content"],
                idField: "id",
                vectorField: "content",
            },
            vectorStore: plainVectorStore,
            embedder: mockEmbedder,
        });

        // biome-ignore lint/complexity/useLiteralKeys: accessing private method in test
        engine["insertSync"]({ id: "1", content: "TypeScript programming" });
        // biome-ignore lint/complexity/useLiteralKeys: accessing private method in test
        engine["insertSync"]({ id: "2", content: "JavaScript frameworks" });

        const results = await engine.search({
            query: "typescript",
            mode: "hybrid",
            limit: 5,
        });

        // Should have used client-side RRF (not Qdrant hybrid)
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].method).toBe("rrf");
    });
});
