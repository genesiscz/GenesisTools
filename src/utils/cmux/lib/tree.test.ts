import { describe, expect, test } from "bun:test";
import type { CmuxLivePane, CmuxLiveSnapshot, CmuxLiveWindow, CmuxLiveWorkspace } from "./live-snapshot";
import { buildCmuxHierarchy } from "./tree";

function pane(id: string, workspaceId: string): CmuxLivePane {
    return { id, workspaceId, title: "zsh", active: false, surfaceCount: 1, surfaces: [] };
}

function workspace(id: string, windowRef?: string): CmuxLiveWorkspace {
    return { id, name: id, windowRef };
}

function snapshotOf(
    workspaces: CmuxLiveWorkspace[],
    panes: CmuxLivePane[],
    windows?: CmuxLiveWindow[]
): CmuxLiveSnapshot {
    return { fetchedAt: "2026-08-27T13:00:00.000Z", available: true, windows, workspaces, panes };
}

describe("buildCmuxHierarchy", () => {
    test("a snapshot with no window list collapses into one synthetic window", () => {
        const snapshot = snapshotOf(
            [workspace("workspace:11"), workspace("workspace:12", "window:9")],
            [pane("pane:1", "workspace:11"), pane("pane:2", "workspace:12")]
        );

        const windows = buildCmuxHierarchy(snapshot);

        expect(windows).toHaveLength(1);
        expect(windows[0].id).toBe("window:current");
        expect(windows[0].key).toBe(true);
        expect(windows[0].ref).toBeUndefined();
        // Every workspace belongs to it, including one carrying a windowRef of its own.
        expect(windows[0].workspaces.map((ws) => ws.id)).toEqual(["workspace:11", "workspace:12"]);
        expect(windows[0].workspaces[0].panes.map((p) => p.id)).toEqual(["pane:1"]);
    });

    test("an empty window list behaves like a missing one", () => {
        const snapshot = snapshotOf([workspace("workspace:11")], [pane("pane:1", "workspace:11")], []);

        const windows = buildCmuxHierarchy(snapshot);

        expect(windows).toHaveLength(1);
        expect(windows[0].id).toBe("window:current");
        expect(windows[0].workspaces.map((ws) => ws.id)).toEqual(["workspace:11"]);
    });

    test("listed windows take the workspaces their refs name", () => {
        const snapshot = snapshotOf(
            [workspace("workspace:11", "window:1"), workspace("workspace:22", "window:2")],
            [pane("pane:1", "workspace:11"), pane("pane:2", "workspace:22")],
            [
                { id: "win-a", ref: "window:1", index: 0, key: true, workspaceCount: 1 },
                { id: "win-b", ref: "window:2", index: 1, key: false, workspaceCount: 1 },
            ]
        );

        const windows = buildCmuxHierarchy(snapshot);

        expect(windows.map((w) => w.workspaces.map((ws) => ws.id))).toEqual([["workspace:11"], ["workspace:22"]]);
        expect(windows[1].workspaces[0].panes.map((p) => p.id)).toEqual(["pane:2"]);
    });

    test("a workspace with no ref lands in the key window only", () => {
        const snapshot = snapshotOf(
            [workspace("workspace:11")],
            [pane("pane:1", "workspace:11")],
            [
                { id: "win-a", ref: "window:1", index: 0, key: false, workspaceCount: 0 },
                { id: "win-b", ref: "window:2", index: 1, key: true, workspaceCount: 1 },
            ]
        );

        const windows = buildCmuxHierarchy(snapshot);

        expect(windows[0].workspaces).toEqual([]);
        expect(windows[1].workspaces.map((ws) => ws.id)).toEqual(["workspace:11"]);
    });

    test("panes in no listed workspace surface under the key window", () => {
        const snapshot = snapshotOf(
            [workspace("workspace:11", "window:1")],
            [pane("pane:1", "workspace:11"), pane("pane:9", "workspace:gone")],
            [
                { id: "win-a", ref: "window:1", index: 0, key: false, workspaceCount: 1 },
                { id: "win-b", ref: "window:2", index: 1, key: true, workspaceCount: 0 },
            ]
        );

        const windows = buildCmuxHierarchy(snapshot);

        expect(windows[1].workspaces.map((ws) => ws.id)).toEqual(["workspace:unmatched"]);
        expect(windows[1].workspaces[0].panes.map((p) => p.id)).toEqual(["pane:9"]);
    });
});
