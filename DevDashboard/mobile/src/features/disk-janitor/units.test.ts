import type { DiskUsageEntry } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { DASH, formatBytes, withPercentOfMax } from "@/features/disk-janitor/units";

describe("formatBytes", () => {
    it("formats GB/MB/KB with one decimal", () => {
        expect(formatBytes(2 * 1024 ** 3)).toBe("2.0 GB");
        expect(formatBytes(512 * 1024 ** 2)).toBe("512.0 MB");
        expect(formatBytes(4 * 1024)).toBe("4.0 KB");
    });

    it("0 bytes -> 0.0 KB; negative/NaN -> em dash", () => {
        expect(formatBytes(0)).toBe("0.0 KB");
        expect(formatBytes(Number.NaN)).toBe(DASH);
    });
});

describe("withPercentOfMax", () => {
    const entries: DiskUsageEntry[] = [
        { path: "/a/node_modules", label: "a/node_modules", bytes: 2000 },
        { path: "/b/Caches", label: "b/Caches", bytes: 1000 },
        { path: "/c/dist", label: "c/dist", bytes: 500 },
    ];

    it("adds pct relative to the largest, preserving desc order", () => {
        const ranked = withPercentOfMax(entries);
        expect(ranked.map((e) => e.pct)).toEqual([100, 50, 25]);
        // order unchanged (input is already desc; transform must not reorder)
        expect(ranked.map((e) => e.label)).toEqual(["a/node_modules", "b/Caches", "c/dist"]);
    });

    it("max=0 -> all pct 0 (no divide-by-zero)", () => {
        const ranked = withPercentOfMax([{ path: "/x", label: "x", bytes: 0 }]);
        expect(ranked[0].pct).toBe(0);
    });

    it("empty -> empty", () => {
        expect(withPercentOfMax([])).toEqual([]);
    });
});
