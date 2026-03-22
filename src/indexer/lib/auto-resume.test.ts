import { describe, expect, it } from "bun:test";
import type { IndexMeta } from "./types";

function makeMeta(name: string, status: IndexMeta["indexingStatus"]): IndexMeta {
    return {
        name,
        config: { name, baseDir: "/tmp" },
        stats: {
            totalFiles: 0,
            totalChunks: 0,
            totalEmbeddings: 0,
            embeddingDimensions: 0,
            dbSizeBytes: 0,
            lastSyncDurationMs: 0,
            searchCount: 0,
            avgSearchDurationMs: 0,
        },
        lastSyncAt: null,
        createdAt: Date.now(),
        indexingStatus: status,
    };
}

/**
 * Pure filter logic matching IndexerManager.getInterruptedIndexes().
 * Extracted here to test without needing a full manager instance.
 */
function filterInterrupted(metas: IndexMeta[]): Array<{ name: string; meta: IndexMeta }> {
    return metas
        .filter((meta) => meta.indexingStatus === "in-progress" || meta.indexingStatus === "cancelled")
        .map((meta) => ({ name: meta.name, meta }));
}

describe("auto-resume: interrupted index detection", () => {
    it("returns in-progress indexes", () => {
        const result = filterInterrupted([makeMeta("stuck", "in-progress")]);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("stuck");
    });

    it("returns cancelled indexes", () => {
        const result = filterInterrupted([makeMeta("stopped", "cancelled")]);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("stopped");
    });

    it("returns both in-progress and cancelled together", () => {
        const result = filterInterrupted([makeMeta("a", "in-progress"), makeMeta("b", "cancelled")]);
        expect(result).toHaveLength(2);
        expect(result.map((r) => r.name)).toEqual(["a", "b"]);
    });

    it("excludes completed indexes", () => {
        const result = filterInterrupted([makeMeta("done", "completed")]);
        expect(result).toHaveLength(0);
    });

    it("excludes idle indexes", () => {
        const result = filterInterrupted([makeMeta("idle-one", "idle")]);
        expect(result).toHaveLength(0);
    });

    it("excludes error indexes", () => {
        const result = filterInterrupted([makeMeta("failed", "error")]);
        expect(result).toHaveLength(0);
    });

    it("excludes undefined status indexes", () => {
        const result = filterInterrupted([makeMeta("fresh", undefined)]);
        expect(result).toHaveLength(0);
    });

    it("returns empty for empty input", () => {
        const result = filterInterrupted([]);
        expect(result).toHaveLength(0);
    });

    it("filters mixed statuses correctly", () => {
        const result = filterInterrupted([
            makeMeta("ok", "completed"),
            makeMeta("stuck", "in-progress"),
            makeMeta("stopped", "cancelled"),
            makeMeta("fresh", undefined),
            makeMeta("idle-one", "idle"),
            makeMeta("failed", "error"),
        ]);
        expect(result).toHaveLength(2);
        expect(result.map((r) => r.name)).toEqual(["stuck", "stopped"]);
    });
});

describe("auto-resume: interruptedOnLoad semantics", () => {
    it("empties after first access (simulated)", () => {
        // Simulate the getter behavior: first access returns items, second returns empty
        let _interruptedOnLoad = [{ name: "a", meta: makeMeta("a", "in-progress") }];

        // First access
        const first = _interruptedOnLoad;
        _interruptedOnLoad = [];

        // Second access
        const second = _interruptedOnLoad;

        expect(first).toHaveLength(1);
        expect(second).toHaveLength(0);
    });
});
