import { describe, expect, test } from "bun:test";
import { appendLiveWithCap, BACKLOG_LIMIT, trimRowRefsForEvictedLive } from "./live-cap";

describe("LogStream live tail cap", () => {
    test("caps the live array to a rolling window instead of growing unboundedly", () => {
        let live: Array<{ id: number }> = [];
        const rowRefs = new Map<number, unknown>();

        for (let i = 0; i < 1000; i++) {
            // Seed the ref this entry will occupy before capping, so eviction has a
            // real, position-matched key to trim rather than an always-empty map.
            rowRefs.set(live.length, { id: i });

            const { next, evictedCount } = appendLiveWithCap(live, { id: i });
            live = next;

            if (evictedCount > 0) {
                trimRowRefsForEvictedLive(rowRefs, 0, evictedCount);
            }
        }

        expect(live.length).toBe(BACKLOG_LIMIT);
        expect(live[0]?.id).toBe(1000 - BACKLOG_LIMIT);
        expect(live[live.length - 1]?.id).toBe(999);

        // rowRefs must stay bounded alongside live, and the evicted (oldest) position
        // must actually be gone rather than silently retained.
        expect(rowRefs.size).toBe(BACKLOG_LIMIT);
        expect(rowRefs.has(0)).toBe(false);
    });
});
