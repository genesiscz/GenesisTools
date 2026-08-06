import { describe, expect, test } from "bun:test";
import { enrichSessionsForHub } from "@app/dev-dashboard/lib/tmux/hub";

describe("tmux hub enrichment", () => {
    test("marks sessions open in ttyd and blocks duplicate attach", () => {
        const enriched = enrichSessionsForHub(
            [
                { name: "free-session", attached: 0, windows: 1 },
                { name: "busy-session", attached: 1, windows: 1 },
            ],
            [{ id: "tab-1", port: 60586, command: "/bin/zsh", cwd: "/work", tmuxSessionName: "busy-session" }]
        );

        expect(enriched[0]?.canAttachInTtyd).toBe(true);
        expect(enriched[0]?.ttydTabIds).toEqual([]);
        expect(enriched[0]?.ttydTabs).toEqual([]);
        expect(enriched[1]?.canAttachInTtyd).toBe(false);
        expect(enriched[1]?.ttydTabIds).toEqual(["tab-1"]);
        expect(enriched[1]?.ttydTabs).toEqual([
            {
                id: "tab-1",
                port: 60586,
                label: "busy-session",
                cwd: "/work",
                lastCommand: undefined,
            },
        ]);
    });

    test("surfaces ttyd display name / lastCommand on hub tabs", () => {
        const enriched = enrichSessionsForHub(
            [{ name: "bridge", attached: 1, windows: 1 }],
            [
                {
                    id: "t1",
                    port: 50100,
                    command: "/bin/zsh",
                    cwd: "/Users/me/proj",
                    tmuxSessionName: "bridge",
                    name: "My Bridge",
                    lastCommand: "claude",
                },
            ]
        );

        expect(enriched[0]?.ttydTabs[0]).toEqual({
            id: "t1",
            port: 50100,
            label: "My Bridge",
            cwd: "/Users/me/proj",
            lastCommand: "claude",
        });
    });

    test("marks sessions attached in cmux", () => {
        const cmuxBySession = new Map([
            ["busy-session", [{ workspaceId: "workspace:1", surfaceId: "surface:1", title: "busy-session" }]],
        ]);
        const enriched = enrichSessionsForHub([{ name: "busy-session", attached: 1, windows: 1 }], [], cmuxBySession);

        expect(enriched[0]?.inCmux).toBe(true);
        expect(enriched[0]?.cmuxSurfaces).toHaveLength(1);
        expect(enriched[0]?.ttydTabs).toEqual([]);
    });
});
