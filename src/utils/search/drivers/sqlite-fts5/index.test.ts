import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FTS5SearchEngine } from "./index";

interface TestDoc extends Record<string, unknown> {
    id: string;
    title: string;
    body: string;
}

describe("FTS5SearchEngine", () => {
    let tmpDir: string;
    let dbPath: string;
    let engine: FTS5SearchEngine<TestDoc>;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "fts5-test-"));
        dbPath = join(tmpDir, "test.db");
        engine = new FTS5SearchEngine<TestDoc>({
            dbPath,
            tableName: "docs",
            schema: {
                textFields: ["title", "body"],
                idField: "id",
            },
        });
    });

    afterEach(() => {
        try {
            engine.close();
        } catch {
            // already closed
        }

        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("constructor creates FTS5 tables (count starts at 0)", () => {
        expect(engine.count).toBe(0);
    });

    it("insert adds a document, count increases", async () => {
        await engine.insert({ id: "1", title: "Hello World", body: "This is a test document" });
        expect(engine.count).toBe(1);
    });

    it("insertMany adds multiple documents", async () => {
        await engine.insertMany([
            { id: "1", title: "First", body: "Alpha bravo" },
            { id: "2", title: "Second", body: "Charlie delta" },
            { id: "3", title: "Third", body: "Echo foxtrot" },
        ]);

        expect(engine.count).toBe(3);
    });

    it("search returns matching results in fulltext mode", async () => {
        await engine.insertMany([
            { id: "1", title: "TypeScript Tutorial", body: "Learn TypeScript basics" },
            { id: "2", title: "Python Guide", body: "Learn Python fundamentals" },
            { id: "3", title: "Rust Handbook", body: "Systems programming with Rust" },
        ]);

        const results = await engine.search({ query: "TypeScript", mode: "fulltext" });

        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].method).toBe("bm25");

        const titles = results.map((r) => r.doc.title);
        expect(titles).toContain("TypeScript Tutorial");
    });

    it("search returns results sorted by relevance (BM25)", async () => {
        await engine.insertMany([
            { id: "1", title: "Search Engine Basics", body: "Introduction to search" },
            { id: "2", title: "Advanced Search", body: "Search search search optimization and search tuning" },
            { id: "3", title: "Cooking Recipes", body: "Delicious meals for the whole family" },
        ]);

        const results = await engine.search({ query: "search", mode: "fulltext" });

        expect(results.length).toBeGreaterThanOrEqual(2);

        // The doc with more "search" occurrences should have a higher score
        const advancedIdx = results.findIndex((r) => r.doc.id === "2");
        const basicsIdx = results.findIndex((r) => r.doc.id === "1");

        expect(advancedIdx).toBeGreaterThanOrEqual(0);
        expect(basicsIdx).toBeGreaterThanOrEqual(0);
        expect(results[advancedIdx].score).toBeGreaterThanOrEqual(results[basicsIdx].score);
    });

    it("search with boost weights a specific field higher", async () => {
        await engine.insertMany([
            { id: "1", title: "Search Engine", body: "Not related at all to queries" },
            { id: "2", title: "Unrelated Title", body: "Search tips and search tricks" },
        ]);

        const results = await engine.search({
            query: "search",
            mode: "fulltext",
            boost: { title: 10.0, body: 1.0 },
        });

        expect(results.length).toBe(2);
        // With heavy title boost, the doc with "Search" in the title should rank first
        expect(results[0].doc.id).toBe("1");
    });

    it("search returns empty array for no matches", async () => {
        await engine.insert({ id: "1", title: "Hello", body: "World" });

        const results = await engine.search({ query: "zzzznonexistent", mode: "fulltext" });
        expect(results).toEqual([]);
    });

    it("search respects limit parameter", async () => {
        const docs: TestDoc[] = [];

        for (let i = 0; i < 10; i++) {
            docs.push({ id: String(i), title: `Document ${i}`, body: "Common keyword appears here" });
        }

        await engine.insertMany(docs);

        const results = await engine.search({ query: "keyword", mode: "fulltext", limit: 3 });
        expect(results.length).toBe(3);
    });

    it("remove removes a document, count decreases", async () => {
        await engine.insertMany([
            { id: "1", title: "Keep this", body: "Should stay" },
            { id: "2", title: "Remove this", body: "Should go" },
        ]);

        expect(engine.count).toBe(2);

        await engine.remove("2");
        expect(engine.count).toBe(1);
    });

    it("insert with duplicate id replaces the document", async () => {
        await engine.insert({ id: "1", title: "Original", body: "First version" });
        await engine.insert({ id: "1", title: "Updated", body: "Second version" });

        // Count should still be 1 due to INSERT OR REPLACE
        expect(engine.count).toBe(1);

        const results = await engine.search({ query: "Updated", mode: "fulltext" });
        expect(results.length).toBe(1);
        expect(results[0].doc.title).toBe("Updated");
    });

    it("persist() resolves without error (no-op for SQLite)", async () => {
        await expect(engine.persist()).resolves.toBeUndefined();
    });

    it("close() doesn't throw", async () => {
        await expect(engine.close()).resolves.toBeUndefined();
    });
});
