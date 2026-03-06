import { describe, expect, it } from "bun:test";
import { SyncRangePlanner } from "../SyncRangePlanner";

describe("SyncRangePlanner", () => {
    it("maps missing unix ranges into Date ranges", () => {
        const planner = new SyncRangePlanner();
        const fakeStore = {
            getMissingSegments: () => [
                { sinceUnix: 1_700_000_000, untilUnix: 1_700_000_100 },
                { sinceUnix: 1_700_000_200, untilUnix: 1_700_000_300 },
            ],
        };

        const ranges = planner.planQueryBackfill(
            fakeStore as unknown as Parameters<SyncRangePlanner["planQueryBackfill"]>[0],
            "chat-1",
            new Date("2024-01-01T00:00:00.000Z"),
            new Date("2024-02-01T00:00:00.000Z")
        );

        expect(ranges).toHaveLength(2);
        expect(ranges[0].source).toBe("query");
        expect(ranges[0].since.toISOString()).toBe("2023-11-14T22:13:20.000Z");
        expect(ranges[1].until.toISOString()).toBe("2023-11-14T22:18:20.000Z");
    });
});
