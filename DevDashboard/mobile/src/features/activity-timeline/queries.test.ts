import type { TimelineEvent } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { mockDashboardClient } from "@/api/mock-client";
import { TIMELINE_INTERVAL_MS, timelineKeys, timelineQuery } from "@/features/activity-timeline/queries";

describe("mock dashboard client — timeline (escape hatch)", () => {
    it("get(/api/timeline) returns the mock event array", async () => {
        const events = await mockDashboardClient.get<TimelineEvent[]>("/api/timeline?since=0");
        expect(Array.isArray(events)).toBe(true);
        expect(events.length).toBeGreaterThan(0);
        expect(new Set(events.map((e) => e.type))).toEqual(new Set(["run", "qa", "terminal"]));
    });
});

describe("timelineQuery factory", () => {
    it("builds the since-pinned key + interval + a queryFn returning the array", async () => {
        const opts = timelineQuery(mockDashboardClient, 123);
        expect([...opts.queryKey]).toEqual(["timeline", "feed", 123]);
        expect(opts.refetchInterval).toBe(TIMELINE_INTERVAL_MS);
        const data = await (opts.queryFn as unknown as () => Promise<TimelineEvent[]>)();
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBeGreaterThan(0);
    });

    it("timelineKeys.feed namespaces under 'timeline'", () => {
        expect(timelineKeys.feed(0)[0]).toBe("timeline");
    });
});
