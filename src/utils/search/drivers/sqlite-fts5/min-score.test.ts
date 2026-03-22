import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchEngine } from "./index";

describe("Min score threshold", () => {
    let tmpDir: string;

    afterEach(() => {
        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("filters results below minScore threshold", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "minscore-"));
        const dbPath = join(tmpDir, "test.db");

        const engine = new SearchEngine({
            dbPath,
            tableName: "docs",
            schema: {
                textFields: ["content"],
                idField: "id",
            },
        });

        // biome-ignore lint/complexity/useLiteralKeys: accessing private method in test
        engine["insertSync"]({ id: "1", content: "TypeScript programming language" });
        // biome-ignore lint/complexity/useLiteralKeys: accessing private method in test
        engine["insertSync"]({ id: "2", content: "completely unrelated gardening tips for spring" });

        const resultsNoThreshold = await engine.search({
            query: "typescript",
            mode: "fulltext",
            limit: 10,
        });

        // Use an absurdly high threshold that no result can meet
        const resultsWithThreshold = await engine.search({
            query: "typescript",
            mode: "fulltext",
            limit: 10,
            minScore: 999999, // impossible to reach
        });

        expect(resultsNoThreshold.length).toBeGreaterThanOrEqual(1);
        // With impossible threshold, nothing should pass
        expect(resultsWithThreshold.length).toBe(0);
    });

    it("defaults to no filtering when minScore is not set", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "minscore-"));
        const dbPath = join(tmpDir, "test.db");

        const engine = new SearchEngine({
            dbPath,
            tableName: "docs",
            schema: {
                textFields: ["content"],
                idField: "id",
            },
        });

        // biome-ignore lint/complexity/useLiteralKeys: accessing private method in test
        engine["insertSync"]({ id: "1", content: "hello world" });

        const results = await engine.search({
            query: "hello",
            mode: "fulltext",
            limit: 10,
        });

        // Without minScore, all results returned
        expect(results.length).toBe(1);
    });

    it("respects minScore of 0 (no filtering)", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "minscore-"));
        const dbPath = join(tmpDir, "test.db");

        const engine = new SearchEngine({
            dbPath,
            tableName: "docs",
            schema: {
                textFields: ["content"],
                idField: "id",
            },
        });

        // biome-ignore lint/complexity/useLiteralKeys: accessing private method in test
        engine["insertSync"]({ id: "1", content: "test content" });

        const results = await engine.search({
            query: "test",
            mode: "fulltext",
            limit: 10,
            minScore: 0,
        });

        expect(results.length).toBe(1);
    });
});
