import { describe, expect, it } from "bun:test";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import { MOCK_WATCHING } from "@/api/fixtures/watching";
import { attentionCount, muteWatch, rowsOf, watchingQuery } from "@/features/watching/queries";

describe("the Watching screen", () => {
    it("reads the list and sends a mute through the real client", async () => {
        const list = await watchingQuery(fixtureDashboardClient).queryFn?.({} as never);
        const receipt = await muteWatch(fixtureDashboardClient, { source: "monitor", id: "3", minutes: 120, idempotencyKey: "k1" });

        expect(list).toEqual(MOCK_WATCHING);
        expect(receipt).toMatchObject({ source: "monitor", id: "3", muted: false });
    });

    it("filters by source and counts what needs a look", () => {
        expect(rowsOf(MOCK_WATCHING, "monitor").map((row) => row.id)).toEqual(["3", "7"]);
        expect(rowsOf(MOCK_WATCHING, "all")).toHaveLength(4);
        expect(attentionCount(MOCK_WATCHING.rows)).toBe(2);
    });
});
