import { describe, expect, it } from "bun:test";
import type { IndexedLogEntry } from "@app/debugging-master/types";
import { mergeIndexedLogEntries } from "./merge-indexed-entries";

function entry(index: number): IndexedLogEntry {
    return { index, level: "info", msg: `line-${index}`, ts: index };
}

describe("mergeIndexedLogEntries", () => {
    it("merges by index and keeps sort order", () => {
        const merged = mergeIndexedLogEntries([entry(1), entry(2)], [entry(2), entry(3)]);
        expect(merged.map((line) => line.index)).toEqual([1, 2, 3]);
        expect(merged[1]?.msg).toBe("line-2");
    });

    it("accepts low indices after a clear reset", () => {
        const stale = Array.from({ length: 3 }, (_, i) => entry(i + 100));
        const merged = mergeIndexedLogEntries(stale, [entry(1), entry(2)]);
        expect(merged.map((line) => line.index)).toEqual([1, 2, 100, 101, 102]);
    });
});
