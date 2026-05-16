import { describe, expect, test } from "bun:test";
import type { CmuxRunResult } from "@app/cmux/lib/cli";
import { focusCmuxPane } from "@app/cmux/lib/controls";

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
