import { describe, expect, test } from "bun:test";
import type { CmuxRunResult } from "@genesiscz/utils/cmux/lib/cli";
import {
    buildRenameTabArgs,
    buildRenameWorkspaceArgs,
    focusCmuxPane,
    focusCmuxSurface,
    renameCmuxSurface,
    renameCmuxWorkspace,
} from "@genesiscz/utils/cmux/lib/controls";

// Code passes cmux UUIDs: a `surface:N` ref is renumbered at every relaunch.
const WORKSPACE_1 = "11111111-1111-4111-8111-111111111101";
const WORKSPACE_2 = "11111111-1111-4111-8111-111111111102";
const PANE_2 = "22222222-2222-4222-8222-222222222202";
const SURFACE_1 = "33333333-3333-4333-8333-333333333301";
const SURFACE_3 = "33333333-3333-4333-8333-333333333303";
const SURFACE_46 = "33333333-3333-4333-8333-333333333346";

const okRunner =
    (calls: string[][]) =>
    async (args: string[]): Promise<CmuxRunResult> => {
        calls.push(args);

        return { code: 0, stdout: "", stderr: "" };
    };

describe("cmux controls", () => {
    test("focusCmuxPane selects workspace and focuses pane", async () => {
        const calls: string[][] = [];
        const runner = async (args: string[]): Promise<CmuxRunResult> => {
            calls.push(args);

            return { code: 0, stdout: "", stderr: "" };
        };

        await focusCmuxPane({ workspaceId: WORKSPACE_1, paneId: PANE_2, runner });

        expect(calls).toEqual([
            ["select-workspace", "--workspace", WORKSPACE_1],
            ["focus-pane", "--workspace", WORKSPACE_1, "--pane", PANE_2],
        ]);
    });

    test("focusCmuxPane rejects blank identifiers", async () => {
        await expect(focusCmuxPane({ workspaceId: "", paneId: PANE_2 })).rejects.toThrow("workspaceId");
        await expect(focusCmuxPane({ workspaceId: WORKSPACE_1, paneId: "" })).rejects.toThrow("paneId");
    });

    test("focusCmuxSurface sends surface.focus with a surface_id parameter", async () => {
        // Pinned here rather than only through the command, because this is a raw RPC with
        // no CLI equivalent: cmux answers `Missing or invalid surface_id` for the obvious
        // `{ surface }` spelling, and a typo would fail silently in the daemon while every
        // command-level test kept passing against its mock.
        const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

        await focusCmuxSurface({
            surfaceId: SURFACE_46,
            sendRpc: async (method, params) => {
                calls.push({ method, params });
                return {};
            },
        });

        expect(calls).toEqual([{ method: "surface.focus", params: { surface_id: SURFACE_46 } }]);
    });

    test("focusCmuxSurface rejects a blank surface id before it reaches the daemon", async () => {
        let sent = 0;

        await expect(
            focusCmuxSurface({
                surfaceId: "  ",
                sendRpc: async () => {
                    sent++;
                    return {};
                },
            })
        ).rejects.toThrow("surfaceId");

        expect(sent).toBe(0);
    });
});

describe("cmux rename", () => {
    test("rename-tab args", () => {
        expect(buildRenameTabArgs(WORKSPACE_1, SURFACE_3, "prod-audit")).toEqual([
            "rename-tab",
            "--workspace",
            WORKSPACE_1,
            "--surface",
            SURFACE_3,
            "prod-audit",
        ]);
    });

    test("rename-workspace args", () => {
        expect(buildRenameWorkspaceArgs(WORKSPACE_1, "audit")).toEqual([
            "rename-workspace",
            "--workspace",
            WORKSPACE_1,
            "audit",
        ]);
    });

    test("renameCmuxSurface runs rename-tab", async () => {
        const calls: string[][] = [];
        await renameCmuxSurface({ workspaceId: WORKSPACE_1, surfaceId: SURFACE_3, title: "build" }, okRunner(calls));
        expect(calls).toEqual([["rename-tab", "--workspace", WORKSPACE_1, "--surface", SURFACE_3, "build"]]);
    });

    test("renameCmuxWorkspace runs rename-workspace", async () => {
        const calls: string[][] = [];
        await renameCmuxWorkspace({ workspaceId: WORKSPACE_2, title: "agent run" }, okRunner(calls));
        expect(calls).toEqual([["rename-workspace", "--workspace", WORKSPACE_2, "agent run"]]);
    });

    test("rejects blank inputs", async () => {
        await expect(renameCmuxSurface({ workspaceId: "", surfaceId: SURFACE_1, title: "x" })).rejects.toThrow(
            "workspaceId"
        );
        await expect(renameCmuxWorkspace({ workspaceId: WORKSPACE_1, title: " " })).rejects.toThrow("title");
    });
});
