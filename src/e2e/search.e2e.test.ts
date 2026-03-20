import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Search module (E2E)", () => {
    let tmpDir: string;

    afterEach(() => {
        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("SearchEngine and OramaSearchEngine can be imported from the search index", async () => {
        const searchModule = await import("@app/utils/search");
        expect(searchModule.SearchEngine).toBeDefined();
        expect(searchModule.FTS5SearchEngine).toBeDefined(); // backward compat alias
        expect(searchModule.OramaSearchEngine).toBeDefined();
    });

    it("SearchEngine works end-to-end with a temp database", async () => {
        const { SearchEngine } = await import("@app/utils/search");

        tmpDir = mkdtempSync(join(tmpdir(), "search-e2e-"));
        const dbPath = join(tmpDir, "e2e.db");

        const engine = new SearchEngine<{ id: string; title: string; body: string }>({
            dbPath,
            tableName: "articles",
            schema: {
                textFields: ["title", "body"],
                idField: "id",
            },
        });

        try {
            expect(engine.count).toBe(0);

            await engine.insertMany([
                { id: "1", title: "Getting Started with Bun", body: "Bun is a fast JavaScript runtime" },
                { id: "2", title: "Node.js Performance", body: "Optimizing Node.js applications" },
                { id: "3", title: "Bun vs Node", body: "Comparing Bun runtime with Node.js" },
            ]);

            expect(engine.count).toBe(3);

            const results = await engine.search({ query: "Bun", mode: "fulltext" });
            expect(results.length).toBeGreaterThanOrEqual(2);

            for (const result of results) {
                expect(result.score).toBeGreaterThan(0);
                expect(result.method).toBe("bm25");
                expect(result.doc).toHaveProperty("id");
                expect(result.doc).toHaveProperty("title");
                expect(result.doc).toHaveProperty("body");
            }

            await engine.remove("1");
            expect(engine.count).toBe(2);

            const afterRemove = await engine.search({ query: "Getting Started", mode: "fulltext" });
            expect(afterRemove.length).toBe(0);
        } finally {
            await engine.close();
        }
    });
});
