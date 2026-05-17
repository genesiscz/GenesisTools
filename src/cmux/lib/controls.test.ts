import { describe, expect, test } from "bun:test";
import type { CmuxRunResult } from "@app/cmux/lib/cli";
import {
    buildRenameTabArgs,
    buildRenameWorkspaceArgs,
    focusCmuxPane,
    renameCmuxSurface,
    renameCmuxWorkspace,
} from "@app/cmux/lib/controls";

const okRunner = (calls: string[][]) => async (args: string[]): Promise<CmuxRunResult> => {
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
        await renameCmuxSurface({ workspaceId: "workspace:1", surfaceId: "surface:3", title: "build" }, okRunner(calls));
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
