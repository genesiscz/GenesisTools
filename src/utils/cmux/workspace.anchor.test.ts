import { describe, expect, test } from "bun:test";
import type { CmuxRunResult } from "@genesiscz/utils/cmux/lib/cli";
import type { PaneListPane, PaneListResponse } from "@genesiscz/utils/cmux/lib/socket";
import { anchorFromLayout, ensureWorkspaceTitle } from "@genesiscz/utils/cmux/workspace";
import { SafeJSON } from "@genesiscz/utils/json";

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

describe("ensureWorkspaceTitle", () => {
    function runner(
        title: string,
        renameCode = 0
    ): { calls: string[][]; run: (args: string[]) => Promise<CmuxRunResult> } {
        const calls: string[][] = [];
        return {
            calls,
            run: async (args) => {
                calls.push(args);

                if (args[1] === "list") {
                    return {
                        code: 0,
                        stdout: SafeJSON.stringify({ workspaces: [{ ref: "workspace:9", title }] }),
                        stderr: "",
                    };
                }

                return { code: renameCode, stdout: "", stderr: renameCode ? "Workspace ref not found" : "" };
            },
        };
    }

    test("a title create already set runs no rename", async () => {
        const fake = runner("Ship");
        const outcome = await ensureWorkspaceTitle(
            { workspace: "workspace:9", window: "window:1", title: "Ship" },
            fake.run
        );

        expect(outcome).toBe("already-set");
        expect(fake.calls).toEqual([["workspace", "list", "--window", "window:1"]]);
    });

    test("a different title is renamed with the noun form, and a failed rename is reported, not thrown", async () => {
        const fake = runner("zsh");
        expect(await ensureWorkspaceTitle({ workspace: "workspace:9", title: "Ship" }, fake.run)).toBe("renamed");
        expect(fake.calls[1]).toEqual(["workspace", "rename", "workspace:9", "--title", "Ship"]);

        const failing = runner("zsh", 1);
        expect(await ensureWorkspaceTitle({ workspace: "workspace:9", title: "Ship" }, failing.run)).toBe("failed");
    });
});
