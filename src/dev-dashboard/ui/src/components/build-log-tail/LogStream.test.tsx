import { describe, expect, test } from "bun:test";
import { appendLiveWithCap, BACKLOG_LIMIT, trimRowRefsForEvictedLive } from "./live-cap";

describe("LogStream live tail cap", () => {
    test("caps the live array to a rolling window instead of growing unboundedly", () => {
        let live: Array<{ id: number }> = [];

        for (let i = 0; i < 1000; i++) {
            const { next, evictedCount } = appendLiveWithCap(live, { id: i });
            live = next;

            if (evictedCount > 0) {
                const rowRefs = new Map<number, unknown>();
                trimRowRefsForEvictedLive(rowRefs, 0, evictedCount);
            }
        }

        expect(live.length).toBeLessThanOrEqual(BACKLOG_LIMIT);
    });
});