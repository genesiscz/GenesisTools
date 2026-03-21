import { describe, expect, it } from "bun:test";
import type { IndexMeta } from "./types";

describe("indexingStatus on IndexMeta", () => {
    it("defaults to undefined when not set", () => {
        const meta: IndexMeta = {
            name: "test",
            config: { name: "test", baseDir: "/tmp" },
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
        };

        expect(meta.indexingStatus).toBeUndefined();
    });

    it("accepts all valid status values", () => {
        const statuses: NonNullable<IndexMeta["indexingStatus"]>[] = ["idle", "in-progress", "completed", "cancelled"];

        for (const status of statuses) {
            const meta: IndexMeta = {
                name: "test",
                config: { name: "test", baseDir: "/tmp" },
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

            expect(meta.indexingStatus).toBe(status);
        }
    });
});

describe("getInterruptedIndexes logic", () => {
    /**
     * IndexerManager.getInterruptedIndexes() filters by indexingStatus.
     * We test the pure filter logic here without needing a full manager.
     */
    function filterInterrupted(metas: IndexMeta[]): IndexMeta[] {
        return metas.filter((meta) => meta.indexingStatus === "in-progress" || meta.indexingStatus === "cancelled");
    }

    it("returns empty when no indexes are interrupted", () => {
        const metas: IndexMeta[] = [makeMeta("a", "completed"), makeMeta("b", "idle"), makeMeta("c", undefined)];

        expect(filterInterrupted(metas)).toHaveLength(0);
    });

    it("returns only interrupted indexes", () => {
        const metas: IndexMeta[] = [
            makeMeta("ok", "completed"),
            makeMeta("stuck", "in-progress"),
            makeMeta("stopped", "cancelled"),
            makeMeta("fresh", undefined),
        ];

        const interrupted = filterInterrupted(metas);
        expect(interrupted).toHaveLength(2);
        expect(interrupted.map((m) => m.name)).toEqual(["stuck", "stopped"]);
    });
});

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
