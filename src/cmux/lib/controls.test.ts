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

        await focusCmuxPane({ workspaceId: "workspace:1", paneId: "pane:2", runner });

        expect(calls).toEqual([
            ["select-workspace", "--workspace", "workspace:1"],
            ["focus-pane", "--workspace", "workspace:1", "--pane", "pane:2"],
        ]);
    });

    test("focusCmuxPane rejects blank identifiers", async () => {
        await expect(focusCmuxPane({ workspaceId: "", paneId: "pane:2" })).rejects.toThrow("workspaceId");
        await expect(focusCmuxPane({ workspaceId: "workspace:1", paneId: "" })).rejects.toThrow("paneId");
    });

    test("focusCmuxSurface sends surface.focus with a surface_id parameter", async () => {
        // Pinned here rather than only through the command, because this is a raw RPC with
        // no CLI equivalent: cmux answers `Missing or invalid surface_id` for the obvious
        // `{ surface }` spelling, and a typo would fail silently in the daemon while every
        // command-level test kept passing against its mock.
        const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

        await focusCmuxSurface({
            surfaceId: "surface:46",
            sendRpc: async (method, params) => {
                calls.push({ method, params });
                return {};
            },
        });

        expect(calls).toEqual([{ method: "surface.focus", params: { surface_id: "surface:46" } }]);
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
        expect(buildRenameTabArgs("workspace:1", "surface:3", "prod-audit")).toEqual([
            "rename-tab",
            "--workspace",
            "workspace:1",
            "--surface",
            "surface:3",
            "prod-audit",
        ]);
    });

    test("rename-workspace args", () => {
        expect(buildRenameWorkspaceArgs("workspace:1", "audit")).toEqual([
            "rename-workspace",
            "--workspace",
            "workspace:1",
            "audit",
        ]);
    });

    test("renameCmuxSurface runs rename-tab", async () => {
        const calls: string[][] = [];
        await renameCmuxSurface(
            { workspaceId: "workspace:1", surfaceId: "surface:3", title: "build" },
            okRunner(calls)
        );
        expect(calls).toEqual([["rename-tab", "--workspace", "workspace:1", "--surface", "surface:3", "build"]]);
    });

    test("renameCmuxWorkspace runs rename-workspace", async () => {
        const calls: string[][] = [];
        await renameCmuxWorkspace({ workspaceId: "workspace:2", title: "agent run" }, okRunner(calls));
        expect(calls).toEqual([["rename-workspace", "--workspace", "workspace:2", "agent run"]]);
    });

    test("rejects blank inputs", async () => {
        await expect(renameCmuxSurface({ workspaceId: "", surfaceId: "surface:1", title: "x" })).rejects.toThrow(
            "workspaceId"
        );
        await expect(renameCmuxWorkspace({ workspaceId: "workspace:1", title: " " })).rejects.toThrow("title");
    });
});
