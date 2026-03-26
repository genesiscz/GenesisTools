import { describe, expect, it } from "bun:test";
import type { Indexer } from "./indexer";
import { anyHaveEmbeddings, detectMode, detectModeMulti, resolveSearchMode } from "./search-mode";

function fakeIndexer(embeddingCount: number): Indexer {
    return {
        getStore: () => ({ getEmbeddingCount: () => embeddingCount }),
    } as unknown as Indexer;
}

describe("resolveSearchMode", () => {
    it("passes through valid modes unchanged", () => {
        expect(resolveSearchMode("fulltext")).toBe("fulltext");
        expect(resolveSearchMode("vector")).toBe("vector");
        expect(resolveSearchMode("hybrid")).toBe("hybrid");
    });

    it("maps 'semantic' to 'vector'", () => {
        expect(resolveSearchMode("semantic")).toBe("vector");
    });

    it("returns undefined for unknown modes", () => {
        expect(resolveSearchMode("banana")).toBeUndefined();
    });
});

describe("detectMode", () => {
    it("returns 'hybrid' when embeddings exist", () => {
        expect(detectMode(fakeIndexer(100))).toBe("hybrid");
    });

    it("returns 'fulltext' when no embeddings", () => {
        expect(detectMode(fakeIndexer(0))).toBe("fulltext");
    });
});

describe("detectModeMulti", () => {
    it("returns 'hybrid' when any index has embeddings", () => {
        expect(detectModeMulti([fakeIndexer(0), fakeIndexer(50)])).toBe("hybrid");
    });

    it("returns 'fulltext' when no indexes have embeddings", () => {
        expect(detectModeMulti([fakeIndexer(0), fakeIndexer(0)])).toBe("fulltext");
    });
});

describe("anyHaveEmbeddings", () => {
    it("returns true when at least one index has embeddings", () => {
        expect(anyHaveEmbeddings([fakeIndexer(0), fakeIndexer(10)])).toBe(true);
    });

    it("returns false when none have embeddings", () => {
        expect(anyHaveEmbeddings([fakeIndexer(0)])).toBe(false);
    });
});
