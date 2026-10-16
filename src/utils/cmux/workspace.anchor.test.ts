import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { CmuxRunResult } from "@genesiscz/utils/cmux/lib/cli";
import * as cli from "@genesiscz/utils/cmux/lib/cli";
import { withFocusedWorkspace } from "@genesiscz/utils/cmux/lib/focus-guard";
import type { PaneListPane, PaneListResponse } from "@genesiscz/utils/cmux/lib/socket";
import { anchorFromLayout, ensureWorkspaceTitle } from "@genesiscz/utils/cmux/workspace";
import { SafeJSON } from "@genesiscz/utils/json";

const WORKSPACE = "11111111-1111-4111-8111-111111111113";
const OTHER_WORKSPACE = "11111111-1111-4111-8111-111111111103";
const PANE = "22222222-2222-4222-8222-222222222266";
const SURFACE = "33333333-3333-4333-8333-333333333187";

function pane(overrides: Partial<PaneListPane> = {}): PaneListPane {
    return {
        id: PANE,
        ref: "pane:66",
        index: 0,
        surface_count: 1,
        surface_ids: [SURFACE],
        surface_refs: ["surface:187"],
        selected_surface_id: SURFACE,
        selected_surface_ref: "surface:187",
        focused: true,
        pixel_frame: { x: 0, y: 0, width: 1600, height: 1360 },
        ...overrides,
    };
}

function layout(overrides: Partial<PaneListResponse> = {}): PaneListResponse {
    return {
        workspace_id: WORKSPACE,
        workspace_ref: "workspace:13",
        window_ref: "window:1",
        panes: [pane()],
        container_frame: { width: 1600, height: 1360 },
        ...overrides,
    };
}

describe("anchorFromLayout", () => {
    test("returns the focused pane's selected surface, by UUID", () => {
        expect(anchorFromLayout(WORKSPACE, layout())).toEqual({ paneId: PANE, surfaceId: SURFACE });
    });

    /**
     * The 2026-08-31 bug: a workspace created but never shown does not resolve,
     * and cmux answers with the ACTIVE workspace's panes. The monitor typed the
     * resume command into surface:179 — the terminal the user was sitting in.
     */
    test("refuses a layout that belongs to a different workspace, asked by ref", () => {
        const answeredAboutCaller = layout({
            workspace_id: OTHER_WORKSPACE,
            workspace_ref: "workspace:3",
            panes: [pane({ ref: "pane:58", selected_surface_ref: "surface:179", surface_refs: ["surface:179"] })],
        });

        expect(() => anchorFromLayout("workspace:13", answeredAboutCaller)).toThrow(/workspace:3.*workspace:13/);
    });

    /** The same guard used to be skipped for a UUID request, which is now the only kind code makes. */
    test("refuses a layout that belongs to a different workspace, asked by UUID", () => {
        const answeredAboutCaller = layout({ workspace_id: OTHER_WORKSPACE, workspace_ref: "workspace:13" });

        expect(() => anchorFromLayout(WORKSPACE, answeredAboutCaller)).toThrow(
            new RegExp(`workspace:13.*${WORKSPACE}`)
        );
    });

    test.each([undefined, ""])("refuses to expose surface UUIDs when the workspace UUID echo is missing (%s)", (id) => {
        expect(() => anchorFromLayout(WORKSPACE, layout({ workspace_id: id }))).toThrow(WORKSPACE);
    });

    test("compares UUIDs without regard to case", () => {
        expect(anchorFromLayout(WORKSPACE.toLowerCase(), layout()).surfaceId).toBe(SURFACE);
    });

    test("falls back to the first pane when none is focused", () => {
        const second = "22222222-2222-4222-8222-222222222271";
        const unfocused = layout({
            panes: [pane({ ref: "pane:70", focused: false }), pane({ id: second, ref: "pane:71", focused: false })],
        });

        expect(anchorFromLayout(WORKSPACE, unfocused).paneId).toBe(PANE);
    });

    test("throws when the workspace has no panes", () => {
        expect(() => anchorFromLayout(WORKSPACE, layout({ panes: [] }))).toThrow(/no panes/);
    });
});

describe("ensureWorkspaceTitle", () => {
    function runner(
        workspaces: Array<{ id: string; ref: string; title: string }>,
        renameCode = 0
    ): { calls: string[][]; run: (args: string[]) => Promise<CmuxRunResult> } {
        const calls: string[][] = [];
        return {
            calls,
            run: async (args) => {
                calls.push(args);

                if (args[1] === "list") {
                    return { code: 0, stdout: SafeJSON.stringify({ workspaces }), stderr: "" };
                }

                return { code: renameCode, stdout: "", stderr: renameCode ? "Workspace ref not found" : "" };
            },
        };
    }

    test("a title create already set runs no rename", async () => {
        const fake = runner([{ id: WORKSPACE, ref: "workspace:9", title: "Ship" }]);
        const outcome = await ensureWorkspaceTitle(
            { workspace: WORKSPACE, window: "window:1", title: "Ship" },
            fake.run
        );

        expect(outcome).toBe("already-set");
        expect(fake.calls).toEqual([["workspace", "list", "--window", "window:1"]]);
    });

    test("a different title is renamed with the noun form, and a failed rename is reported, not thrown", async () => {
        const fake = runner([{ id: WORKSPACE, ref: "workspace:9", title: "zsh" }]);
        expect(await ensureWorkspaceTitle({ workspace: WORKSPACE, title: "Ship" }, fake.run)).toBe("renamed");
        expect(fake.calls[1]).toEqual(["workspace", "rename", WORKSPACE, "--title", "Ship"]);

        const failing = runner([{ id: WORKSPACE, ref: "workspace:9", title: "zsh" }], 1);
        expect(await ensureWorkspaceTitle({ workspace: WORKSPACE, title: "Ship" }, failing.run)).toBe("failed");
    });

    /** After a relaunch `workspace:9` is another workspace; only the UUID says which one is ours. */
    test("a workspace that took over our old ref does not answer for ours", async () => {
        const fake = runner([
            { id: OTHER_WORKSPACE, ref: "workspace:9", title: "Ship" },
            { id: WORKSPACE, ref: "workspace:4", title: "zsh" },
        ]);

        expect(await ensureWorkspaceTitle({ workspace: WORKSPACE, title: "Ship" }, fake.run)).toBe("renamed");
        expect(fake.calls[1]).toEqual(["workspace", "rename", WORKSPACE, "--title", "Ship"]);
    });
});

describe("withFocusedWorkspace", () => {
    afterEach(() => mock.restore());

    /** The focused workspace is read through `identify`; everything else lands in `steps`. */
    function cmux(focused: { workspace_id?: string; workspace_ref?: string }) {
        const steps: string[][] = [];
        const identify = spyOn(cli, "runCmuxJSON").mockResolvedValue({ focused });
        spyOn(cli, "runCmuxOk").mockImplementation(async (args: string[]) => {
            steps.push(args);
            return { code: 0, stdout: "", stderr: "" };
        });
        return { identify, steps };
    }

    /**
     * After a relaunch the focused workspace can carry the ref a caller remembers for another
     * workspace. Compared by ref, the switch was skipped and the work ran in the wrong workspace.
     */
    test("switches when only the ref matches, and switches back after", async () => {
        const { identify, steps } = cmux({ workspace_id: OTHER_WORKSPACE, workspace_ref: "workspace:13" });

        await withFocusedWorkspace(WORKSPACE, async () => {
            steps.push(["work"]);
        });

        expect(identify.mock.calls).toEqual([[["--id-format", "both", "identify"]]]);
        expect(steps).toEqual([
            ["select-workspace", "--workspace", WORKSPACE],
            ["work"],
            ["select-workspace", "--workspace", OTHER_WORKSPACE],
        ]);
    });

    test("does not switch when the focused workspace is the one asked for", async () => {
        const { steps } = cmux({ workspace_id: WORKSPACE, workspace_ref: "workspace:13" });

        await withFocusedWorkspace(WORKSPACE.toLowerCase(), async () => {
            steps.push(["work"]);
        });

        expect(steps).toEqual([["work"]]);
    });
});
