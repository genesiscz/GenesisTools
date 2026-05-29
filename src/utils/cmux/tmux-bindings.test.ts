import { describe, expect, test } from "bun:test";
import { findCmuxSurfacesForTmuxSession, indexCmuxSurfacesByTmuxSession } from "@app/utils/cmux/tmux-bindings";
import type { CmuxLayoutTree } from "@app/utils/cmux/types";

const layout: CmuxLayoutTree = {
    fetchedAt: "now",
    available: true,
    windows: [
        {
            id: "window:1",
            index: 0,
            visible: true,
            workspaces: [
                {
                    id: "workspace:1",
                    name: "Main",
                    panes: [
                        {
                            id: "pane:1",
                            title: "shell",
                            active: true,
                            surfaces: [
                                {
                                    id: "surface:1",
                                    title: "dev-dashboard-abc",
                                    type: "terminal",
                                    selected: true,
                                },
                                {
                                    id: "surface:2",
                                    title: "browser",
                                    type: "browser",
                                    selected: false,
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

describe("cmux tmux bindings", () => {
    test("findCmuxSurfacesForTmuxSession matches terminal tab titles", () => {
        expect(findCmuxSurfacesForTmuxSession(layout, "dev-dashboard-abc")).toEqual([
            { workspaceId: "workspace:1", surfaceId: "surface:1", title: "dev-dashboard-abc" },
        ]);
    });

    test("indexCmuxSurfacesByTmuxSession groups by title", () => {
        const map = indexCmuxSurfacesByTmuxSession(layout);
        expect(map.get("dev-dashboard-abc")?.length).toBe(1);
        expect(map.has("browser")).toBe(false);
    });
});
