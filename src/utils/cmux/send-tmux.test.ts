import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as controls from "@app/cmux/lib/controls";
import { attachTmuxToCmux } from "@app/utils/cmux/send-tmux";
import * as workspace from "@app/utils/cmux/workspace";
import { resetTmuxBinCache, setTmuxBinForTests } from "@app/utils/tmux/bin";
import { setTmuxSpawnSyncForTests } from "@app/utils/tmux/sessions";

describe("attachTmuxToCmux", () => {
    afterEach(() => {
        setTmuxSpawnSyncForTests(null);
        setTmuxBinForTests(null);
        resetTmuxBinCache();
    });

    test("workspace_by_name ensures workspace, splits, and sends attach", async () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests((cmd) => {
            if (cmd.includes("list-sessions")) {
                return { exitCode: 0, stdout: "my-session\t1\t1\n" };
            }

            return { exitCode: 0, stdout: "" };
        });

        const ensureSpy = spyOn(workspace, "ensureWorkspaceByName").mockResolvedValue("workspace:9");
        const splitSpy = spyOn(workspace, "openSplitInWorkspace").mockResolvedValue({
            workspaceId: "workspace:9",
            paneId: "pane:2",
            surfaceId: "surface:3",
        });
        const sendSpy = spyOn(workspace, "sendAttachCommand").mockResolvedValue(undefined);
        const renameSpy = spyOn(workspace, "renameSurfaceTab").mockResolvedValue(undefined);
        const focusSpy = spyOn(controls, "focusCmuxPane").mockResolvedValue(undefined);

        const result = await attachTmuxToCmux({
            tmuxSessionName: "my-session",
            target: { mode: "workspace_by_name", workspaceName: "DevDashboard" },
        });

        expect(result).toEqual({
            workspaceId: "workspace:9",
            paneId: "pane:2",
            surfaceId: "surface:3",
            tmuxSessionName: "my-session",
        });
        expect(ensureSpy).toHaveBeenCalledWith("DevDashboard", undefined);
        expect(splitSpy).toHaveBeenCalledWith("workspace:9");
        expect(sendSpy).toHaveBeenCalledWith({
            workspaceRef: "workspace:9",
            surfaceRef: "surface:3",
            tmuxSessionName: "my-session",
        });
        expect(focusSpy).toHaveBeenCalledWith({ workspaceId: "workspace:9", paneId: "pane:2" });
        expect(renameSpy).toHaveBeenCalledWith("workspace:9", "surface:3", "my-session");

        ensureSpy.mockRestore();
        splitSpy.mockRestore();
        sendSpy.mockRestore();
        renameSpy.mockRestore();
        focusSpy.mockRestore();
    });

    test("throws when tmux session missing", async () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests(() => ({ exitCode: 0, stdout: "" }));

        await expect(
            attachTmuxToCmux({
                tmuxSessionName: "missing",
                target: { mode: "new_split", workspaceId: "workspace:1" },
            })
        ).rejects.toThrow("does not exist");
    });
});
