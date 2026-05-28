import { describe, expect, test } from "bun:test";
import { enrichSessionsForHub } from "@app/dev-dashboard/lib/tmux/hub";

describe("tmux hub enrichment", () => {
    test("marks sessions open in ttyd and blocks duplicate attach", () => {
        const enriched = enrichSessionsForHub(
            [
                { name: "free-session", attached: 0, windows: 1 },
                { name: "busy-session", attached: 1, windows: 1 },
            ],
            [{ id: "tab-1", tmuxSessionName: "busy-session" }]
        );

        expect(enriched[0]?.canAttachInTtyd).toBe(true);
        expect(enriched[0]?.ttydTabIds).toEqual([]);
        expect(enriched[1]?.canAttachInTtyd).toBe(false);
        expect(enriched[1]?.ttydTabIds).toEqual(["tab-1"]);
    });
});
