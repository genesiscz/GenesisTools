import { describe, expect, it } from "bun:test";
import type { SearchEngine, SearchEngineConfig, SearchFilterPredicate, SearchOptions, SearchResult } from "./types";

interface TestDoc extends Record<string, unknown> {
    id: string;
    title: string;
    body: string;
}

describe("Search types", () => {
    it("SearchOptions can be constructed with all fields", () => {
        const opts: SearchOptions = {
            query: "hello",
            mode: "fulltext",
            limit: 10,
            fields: ["title", "body"],
            boost: { title: 2.0 },
            hybridWeights: { text: 0.7, vector: 0.3 },
            filters: { sql: "c.category = ?", params: ["test"] },
        };

        expect(opts.query).toBe("hello");
        expect(opts.mode).toBe("fulltext");
        const predicate: SearchFilterPredicate = opts.filters ?? { sql: "", params: [] };
        expect(predicate.sql).toBe("c.category = ?");
        expect(predicate.params).toEqual(["test"]);
    });

    it("SearchResult can be constructed with all method types", () => {
        const bm25Result: SearchResult<TestDoc> = {
            doc: { id: "1", title: "Test", body: "content" },
            score: 1.5,
            method: "bm25",
        };

        const cosineResult: SearchResult<TestDoc> = {
            doc: { id: "2", title: "Test 2", body: "content 2" },
            score: 0.95,
            method: "cosine",
        };

        const rrfResult: SearchResult<TestDoc> = {
            doc: { id: "3", title: "Test 3", body: "content 3" },
            score: 0.03,
            method: "rrf",
        };

        expect(bm25Result.method).toBe("bm25");
        expect(cosineResult.method).toBe("cosine");
        expect(rrfResult.method).toBe("rrf");
    });

    it("SearchEngineConfig can be constructed without embedder", () => {
        const config: SearchEngineConfig = {};
        expect(config.embedder).toBeUndefined();
    });

    it("a mock SearchEngine implementation satisfies the interface", async () => {
        let docCount = 0;
        const store = new Map<string, TestDoc>();

        const engine: SearchEngine<TestDoc> = {
            get count() {
                return docCount;
            },

            async insert(doc: TestDoc) {
                store.set(doc.id, doc);
                docCount++;
            },

            async insertMany(docs: TestDoc[]) {
                for (const doc of docs) {
                    store.set(doc.id, doc);
                    docCount++;
                }
            },

            async remove(id: string | number) {
                if (store.delete(String(id))) {
                    docCount--;
                }
            },

            async search(opts: SearchOptions): Promise<SearchResult<TestDoc>[]> {
                const results: SearchResult<TestDoc>[] = [];

                for (const doc of store.values()) {
                    if (doc.title.includes(opts.query) || doc.body.includes(opts.query)) {
                        results.push({ doc, score: 1.0, method: "bm25" });
                    }
                }

                return results.slice(0, opts.limit ?? 20);
            },
        };

        await engine.insert({ id: "1", title: "Hello World", body: "First document" });
        expect(engine.count).toBe(1);

        await engine.insertMany([
            { id: "2", title: "Foo Bar", body: "Second document" },
            { id: "3", title: "Hello Again", body: "Third document" },
        ]);
        expect(engine.count).toBe(3);

        const results = await engine.search({ query: "Hello" });
        expect(results.length).toBe(2);
        expect(results[0].method).toBe("bm25");

        await engine.remove("1");
        expect(engine.count).toBe(2);
    });
});
