import { describe, expect, it } from "bun:test";
import { mergeExtentClusters } from "./bun-scan";

interface Ext {
    dev: number;
    len: number;
    group: number;
}

function merge(exts: Ext[], ngroups: number) {
    const n = exts.length;
    const devs = new BigUint64Array(n);
    const lens = new BigUint64Array(n);
    const grps = new Int32Array(n);
    exts.forEach((e, i) => {
        devs[i] = BigInt(e.dev);
        lens[i] = BigInt(e.len);
        grps[i] = e.group;
    });
    // The real scan sorts extent indices by device offset before merging.
    const idxArr = Array.from({ length: n }, (_v, i) => i).sort((a, b) =>
        devs[a]! < devs[b]! ? -1 : devs[a]! > devs[b]! ? 1 : 0
    );
    return mergeExtentClusters(idxArr, devs, lens, grps, n, ngroups);
}

describe("mergeExtentClusters", () => {
    it("credits overlapping extents from two groups as cross-group shared once", () => {
        // [0,100) group 0 overlaps [50,150) group 1 → one cluster [0,150).
        const r = merge(
            [
                { dev: 0, len: 100, group: 0 },
                { dev: 50, len: 100, group: 1 },
            ],
            2
        );

        expect(r.uniqueShared).toBe(150n);
        expect(r.crossShared).toBe(150n);
        expect(r.groupShared[0]).toBe(150n);
        expect(r.groupShared[1]).toBe(150n);
        // Overlapping groups are unioned into one clone cluster.
        expect(r.find(0)).toBe(r.find(1));
    });

    it("does NOT treat adjacent (touching) extents from two groups as cross-group shared", () => {
        // [0,100) group 0 is merely adjacent to [100,200) group 1 — half-open ranges
        // do not overlap at the boundary, so no cross-group sharing (locks in t1).
        const r = merge(
            [
                { dev: 0, len: 100, group: 0 },
                { dev: 100, len: 100, group: 1 },
            ],
            2
        );

        expect(r.crossShared).toBe(0n);
        expect(r.groupShared[0]).toBe(0n);
        expect(r.groupShared[1]).toBe(0n);
        // Not unioned — they stay separate clusters.
        expect(r.find(0)).not.toBe(r.find(1));
    });

    it("does not credit cross-group sharing for a single-group cluster", () => {
        // Two overlapping extents, same group → merged, but only one group present.
        const r = merge(
            [
                { dev: 0, len: 100, group: 0 },
                { dev: 50, len: 100, group: 0 },
            ],
            1
        );

        expect(r.uniqueShared).toBe(150n);
        expect(r.crossShared).toBe(0n);
        expect(r.groupShared[0]).toBe(0n);
    });

    it("keeps uniqueShared (covered bytes) invariant whether extents are adjacent or split", () => {
        const adjacent = merge(
            [
                { dev: 0, len: 100, group: 0 },
                { dev: 100, len: 100, group: 1 },
            ],
            2
        );
        const split = merge(
            [
                { dev: 0, len: 100, group: 0 },
                { dev: 500, len: 100, group: 1 },
            ],
            2
        );

        // Both cover 200 physical bytes total.
        expect(adjacent.uniqueShared).toBe(200n);
        expect(split.uniqueShared).toBe(200n);
    });
});
