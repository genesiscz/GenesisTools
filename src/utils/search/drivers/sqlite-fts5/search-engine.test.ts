import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { SearchEngine } from "./index";

type TestDoc = Record<string, unknown> & {
    id: string;
    title: string;
    body: string;
};

describe("SearchEngine integration (in-memory)", () => {
    let db: Database;
    let engine: SearchEngine<TestDoc>;

    afterEach(() => {
        db?.close();
    });

    function setup(): void {
        db = new Database(":memory:");

        engine = SearchEngine.fromDatabase<TestDoc>(db, {
            tableName: "test_docs",
            schema: {
                textFields: ["title", "body"],
                idField: "id",
            },
            tokenizer: "porter unicode61",
        });
    }

    it("indexes and searches documents via FTS5", async () => {
        setup();

        await engine.insert({
            id: "doc1",
            title: "Introduction to TypeScript",
            body: "TypeScript adds static types to JavaScript.",
        });
        await engine.insert({
            id: "doc2",
            title: "Rust Memory Safety",
            body: "Rust prevents null pointer dereferences at compile time.",
        });
        await engine.insert({
            id: "doc3",
            title: "Python Data Science",
            body: "Python excels at data analysis with pandas and numpy.",
        });

        const results = await engine.search({ query: "TypeScript types", mode: "fulltext", limit: 10 });

        expect(results.length).toBeGreaterThan(0);
        expect(results[0].doc.title).toContain("TypeScript");
        expect(results[0].score).toBeGreaterThan(0);
    });

    it("returns empty results for no match", async () => {
        setup();

        await engine.insert({ id: "doc1", title: "Hello", body: "World" });

        const results = await engine.search({ query: "zzzznonexistent", mode: "fulltext", limit: 10 });
        expect(results).toHaveLength(0);
    });

    it("removes documents and they no longer appear in search", async () => {
        setup();

        await engine.insert({ id: "doc1", title: "Remove me", body: "This should be removed" });
        await engine.insert({ id: "doc2", title: "Keep me", body: "This should remain" });

        await engine.remove("doc1");

        const results = await engine.search({ query: "Remove", mode: "fulltext", limit: 10 });
        const hasRemoved = results.some((r) => r.doc.title === "Remove me");
        expect(hasRemoved).toBe(false);
    });

    it("updates existing document on re-insert", async () => {
        setup();

        await engine.insert({ id: "doc1", title: "Version 1", body: "Original content" });
        await engine.insert({ id: "doc1", title: "Version 2", body: "Updated content" });

        const results = await engine.search({ query: "Updated", mode: "fulltext", limit: 10 });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].doc.title).toBe("Version 2");
    });

    it("respects limit parameter", async () => {
        setup();

        for (let i = 0; i < 20; i++) {
            await engine.insert({ id: `doc${i}`, title: `Document ${i}`, body: "common search term here" });
        }

        const results = await engine.search({ query: "common search term", mode: "fulltext", limit: 5 });
        expect(results.length).toBeLessThanOrEqual(5);
    });

    it("boosts scores for specified fields", async () => {
        setup();

        await engine.insert({ id: "doc1", title: "TypeScript", body: "A programming language" });
        await engine.insert({ id: "doc2", title: "A programming language", body: "TypeScript guide" });

        const results = await engine.search({
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
