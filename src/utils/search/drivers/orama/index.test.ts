import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OramaSearchEngine } from "./index";

interface TestDoc extends Record<string, unknown> {
    id: string;
    title: string;
    body: string;
}

describe("OramaSearchEngine", () => {
    let tmpDir: string;
    let engine: OramaSearchEngine<TestDoc>;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "orama-test-"));
        engine = new OramaSearchEngine<TestDoc>({
            schema: {
                title: "string",
                body: "string",
            },
            persistPath: join(tmpDir, "orama.json"),
            idProperty: "id",
        });
    });

    afterEach(async () => {
        try {
            await engine.close();
        } catch {
            // already closed
        }

        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("constructor creates engine (count starts at 0)", () => {
        expect(engine.count).toBe(0);
    });

    it("insert adds a document and search finds it in fulltext mode", async () => {
        await engine.insert({ id: "1", title: "TypeScript Primer", body: "Learn TypeScript fast" });

        expect(engine.count).toBe(1);

        const results = await engine.search({ query: "TypeScript", mode: "fulltext" });
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].method).toBe("bm25");
        expect(results[0].doc.title).toBe("TypeScript Primer");
    });

    it("insertMany adds multiple documents", async () => {
        await engine.insertMany([
            { id: "1", title: "Alpha", body: "First entry" },
            { id: "2", title: "Bravo", body: "Second entry" },
            { id: "3", title: "Charlie", body: "Third entry" },
        ]);

        expect(engine.count).toBe(3);
    });

    it("search returns empty for non-matching query", async () => {
        await engine.insert({ id: "1", title: "Hello", body: "World" });

        const results = await engine.search({ query: "zzzznonexistent", mode: "fulltext" });
        expect(results).toEqual([]);
    });

    it("search respects limit parameter", async () => {
        const docs: TestDoc[] = [];

        for (let i = 0; i < 10; i++) {
            docs.push({ id: String(i), title: `Document ${i}`, body: "Common keyword content here" });
        }

        await engine.insertMany(docs);

        const results = await engine.search({ query: "keyword", mode: "fulltext", limit: 3 });
        expect(results.length).toBeLessThanOrEqual(3);
    });

    it("remove removes a document", async () => {
        await engine.insertMany([
            { id: "1", title: "Keep", body: "Should stay" },
            { id: "2", title: "Remove", body: "Should go" },
        ]);

        expect(engine.count).toBe(2);

        // Orama's remove expects the internal orama id, which is the string id
        await engine.remove("1");
        expect(engine.count).toBe(1);
    });

    it("count reflects insertions accurately", async () => {
        expect(engine.count).toBe(0);

        await engine.insert({ id: "a", title: "One", body: "Content" });
        expect(engine.count).toBe(1);

        await engine.insertMany([
            { id: "b", title: "Two", body: "Content" },
            { id: "c", title: "Three", body: "Content" },
        ]);

        expect(engine.count).toBe(3);
    });

    it("persist() resolves without error", async () => {
        await engine.insert({ id: "1", title: "Test", body: "Data" });
        await expect(engine.persist()).resolves.toBeUndefined();
    });

    it("close() resolves without error", async () => {
        await engine.insert({ id: "1", title: "Test", body: "Data" });
        await expect(engine.close()).resolves.toBeUndefined();
    });
});
