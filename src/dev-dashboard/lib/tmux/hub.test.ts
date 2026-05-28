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

    test("marks sessions attached in cmux", () => {
        const cmuxBySession = new Map([
            [
                "busy-session",
                [{ workspaceId: "workspace:1", surfaceId: "surface:1", title: "busy-session" }],
            ],
        ]);
        const enriched = enrichSessionsForHub(
            [{ name: "busy-session", attached: 1, windows: 1 }],
            [],
            cmuxBySession
        );

        expect(enriched[0]?.inCmux).toBe(true);
        expect(enriched[0]?.cmuxSurfaces).toHaveLength(1);
    });
});
