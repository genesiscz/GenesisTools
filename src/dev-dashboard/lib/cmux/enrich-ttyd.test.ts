import { describe, expect, it } from "bun:test";
import type { CmuxLivePane, CmuxLiveSnapshot, CmuxLiveSurface } from "@app/cmux/lib/live-snapshot";
import { enrichPanesWithTtyd, resolveTtydForCmuxSurface } from "@app/dev-dashboard/lib/cmux/enrich-ttyd";

function surface(overrides: Partial<CmuxLiveSurface>): CmuxLiveSurface {
    return {
        id: "surface:1",
        title: "dev-dashboard-abc12345",
        type: "terminal",
        index: 0,
        selected: false,
        active: false,
        ...overrides,
    };
}

function pane(overrides: Partial<CmuxLivePane>): CmuxLivePane {
    return {
        id: "pane:1",
        workspaceId: "ws:1",
        title: "pane",
        active: false,
        surfaceCount: 1,
        surfaces: [surface({})],
        ...overrides,
    };
}

function snapshot(panes: CmuxLivePane[]): CmuxLiveSnapshot {
    return { fetchedAt: "2026-06-01T00:00:00.000Z", available: true, workspaces: [], panes };
}

describe("enrichPanesWithTtyd", () => {
    it("sets ttydSessionId when a terminal surface title matches a ttyd tmux session", () => {
        const result = enrichPanesWithTtyd(snapshot([pane({})]), [
            { id: "ttyd-7", tmuxSessionName: "dev-dashboard-abc12345" },
        ]);
        expect(result.panes[0].ttydSessionId).toBe("ttyd-7");
    });

    it("prefers the selected terminal surface for the join", () => {
        const p = pane({
            selectedSurfaceRef: "surface:b",
            surfaces: [
                surface({ id: "surface:a", title: "other-session", selected: false }),
                surface({ id: "surface:b", title: "dev-dashboard-abc12345", selected: true }),
            ],
        });
        const result = enrichPanesWithTtyd(snapshot([p]), [
            { id: "ttyd-match", tmuxSessionName: "dev-dashboard-abc12345" },
            { id: "ttyd-other", tmuxSessionName: "other-session" },
        ]);
        expect(result.panes[0].ttydSessionId).toBe("ttyd-match");
    });

    it("leaves panes unchanged when no ttyd matches", () => {
        const result = enrichPanesWithTtyd(snapshot([pane({})]), [
            { id: "ttyd-x", tmuxSessionName: "unrelated-session" },
        ]);
        expect(result.panes[0].ttydSessionId).toBeUndefined();
    });

    it("ignores non-terminal surfaces (e.g. browser/editor panes)", () => {
        const p = pane({ surfaces: [surface({ type: "browser", title: "dev-dashboard-abc12345" })] });
        const result = enrichPanesWithTtyd(snapshot([p]), [
            { id: "ttyd-7", tmuxSessionName: "dev-dashboard-abc12345" },
        ]);
        expect(result.panes[0].ttydSessionId).toBeUndefined();
    });

    it("returns the snapshot untouched when there are no ttyd sessions with tmux bindings", () => {
        const input = snapshot([pane({})]);
        const result = enrichPanesWithTtyd(input, [{ id: "ttyd-no-tmux" }]);
        expect(result).toBe(input);
    });
});

describe("resolveTtydForCmuxSurface", () => {
    it("finds the ttyd id by the surface's pre-rename title (= tmux session name)", () => {
        const snap = snapshot([
            pane({ surfaces: [surface({ id: "surface:x", title: "dev-dashboard-abc12345" })] }),
        ]);
        const id = resolveTtydForCmuxSurface(snap, "surface:x", [
            { id: "ttyd-7", tmuxSessionName: "dev-dashboard-abc12345" },
        ]);
        expect(id).toBe("ttyd-7");
    });

    it("returns null when the surface is not a terminal", () => {
        const snap = snapshot([
            pane({ surfaces: [surface({ id: "surface:b", type: "browser", title: "dev-dashboard-abc12345" })] }),
        ]);
        expect(resolveTtydForCmuxSurface(snap, "surface:b", [{ id: "ttyd-7", tmuxSessionName: "dev-dashboard-abc12345" }])).toBeNull();
    });

    it("returns null when no ttyd is bound to the surface's tmux session", () => {
        const snap = snapshot([pane({ surfaces: [surface({ id: "surface:x", title: "lonely-session" })] })]);
        expect(resolveTtydForCmuxSurface(snap, "surface:x", [{ id: "ttyd-7", tmuxSessionName: "other" }])).toBeNull();
    });

    it("returns null for an unknown surface id", () => {
        const snap = snapshot([pane({})]);
        expect(resolveTtydForCmuxSurface(snap, "surface:missing", [{ id: "ttyd-7", tmuxSessionName: "x" }])).toBeNull();
    });
});
