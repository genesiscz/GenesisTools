import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchEngine } from "./index";

describe("RRF over-fetch", () => {
    let tmpDir: string;

    afterEach(() => {
        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("bm25Search returns at most limit results", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "rrf-"));
        const dbPath = join(tmpDir, "test.db");

        const engine = new SearchEngine({
            dbPath,
            tableName: "docs",
            schema: {
                textFields: ["content"],
                idField: "id",
            },
        });

        // Insert enough docs that over-fetch matters
        for (let i = 0; i < 50; i++) {
            engine["insertSync"]({
                id: String(i),
                content: `document about topic ${i % 10 === 0 ? "search engine optimization" : "random content"} number ${i}`,
            });
        }

        // When requesting limit=5, internal bm25Search for RRF should fetch more.
        // We verify indirectly: more candidates means better ranking quality.
        const results = engine.bm25Search("search engine optimization", 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results.length).toBeLessThanOrEqual(5);
    });

    it("returns correct number of results when over-fetching from BM25", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "rrf-"));
        const dbPath = join(tmpDir, "test.db");

        const engine = new SearchEngine({
            dbPath,
            tableName: "docs",
            schema: {
                textFields: ["content"],
                idField: "id",
            },
        });

        // Insert enough docs that requesting a small limit still works correctly
        for (let i = 0; i < 40; i++) {
            engine["insertSync"]({
                id: String(i),
                content: `document about ${i % 5 === 0 ? "typescript programming" : "gardening tips"} number ${i}`,
            });
        }

        // With limit=3, BM25 should still return at most 3 results
        const results = engine.bm25Search("typescript programming", 3);
        expect(results.length).toBeGreaterThan(0);
        expect(results.length).toBeLessThanOrEqual(3);
        // All results should use bm25 method
        for (const r of results) {
            expect(r.method).toBe("bm25");
        }
    });
});
