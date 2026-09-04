import { describe, expect, test } from "bun:test";
import type { PaneListPane, PaneListResponse } from "@genesiscz/utils/cmux/lib/socket";
import { anchorFromLayout } from "@genesiscz/utils/cmux/workspace";

function pane(overrides: Partial<PaneListPane> = {}): PaneListPane {
    return {
        ref: "pane:66",
        index: 0,
        surface_count: 1,
        surface_refs: ["surface:187"],
        selected_surface_ref: "surface:187",
        focused: true,
        pixel_frame: { x: 0, y: 0, width: 1600, height: 1360 },
        ...overrides,
    };
}

function layout(overrides: Partial<PaneListResponse> = {}): PaneListResponse {
    return {
        workspace_ref: "workspace:13",
        window_ref: "window:1",
        panes: [pane()],
        container_frame: { width: 1600, height: 1360 },
        ...overrides,
    };
}

describe("anchorFromLayout", () => {
    test("returns the focused pane's selected surface", () => {
        expect(anchorFromLayout("workspace:13", layout())).toEqual({
            paneRef: "pane:66",
            surfaceRef: "surface:187",
        });
    });

    /**
     * The 2026-08-31 bug: a workspace created but never shown does not resolve,
     * and cmux answers with the ACTIVE workspace's panes. The monitor typed the
     * resume command into surface:179 — the terminal the user was sitting in.
     */
    test("refuses a layout that belongs to a different workspace", () => {
        const answeredAboutCaller = layout({
            workspace_ref: "workspace:3",
            panes: [pane({ ref: "pane:58", selected_surface_ref: "surface:179", surface_refs: ["surface:179"] })],
        });

        expect(() => anchorFromLayout("workspace:13", answeredAboutCaller)).toThrow(/workspace:3.*workspace:13/);
    });

    test("skips the comparison when the request was not a short ref", () => {
        const byUuid = layout({ workspace_ref: "workspace:13" });

        expect(anchorFromLayout("C1F8109B-E268-49A2-A3D6-0DEF8CE404D1", byUuid).surfaceRef).toBe("surface:187");
    });

    test("falls back to the first pane when none is focused", () => {
        const unfocused = layout({
            panes: [
                pane({ ref: "pane:70", focused: false, selected_surface_ref: "surface:200" }),
                pane({ ref: "pane:71", focused: false, selected_surface_ref: "surface:201" }),
            ],
        });

        expect(anchorFromLayout("workspace:13", unfocused).paneRef).toBe("pane:70");
    });

    test("throws when the workspace has no panes", () => {
        expect(() => anchorFromLayout("workspace:13", layout({ panes: [] }))).toThrow(/no panes/);
    });
});
