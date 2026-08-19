import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as controls from "@genesiscz/utils/cmux/lib/controls";
import { attachTmuxToCmux } from "@genesiscz/utils/cmux/send-tmux";
import * as workspace from "@genesiscz/utils/cmux/workspace";
import { resetTmuxBinCache, setTmuxBinForTests } from "@genesiscz/utils/tmux/bin";
import { formatWithRecordSeparator, setTmuxSpawnSyncForTests } from "@genesiscz/utils/tmux/sessions";

/**
 * One `list-sessions` record as tmux really emits it.
 *
 * Built with the production formatter on purpose. This mock used to hand-write tab-separated
 * fields, so when `listTmuxSessions` moved to RS/US control bytes the fake output stopped
 * parsing: the whole line became the session name, `sessionExists` answered false, and the
 * test failed on a session it had just declared. Sharing the formatter makes that drift
 * impossible to reintroduce.
 */
function listSessionsStdout(fields: string[]): string {
    return `${formatWithRecordSeparator(fields)}\n`;
}

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
                return { exitCode: 0, stdout: listSessionsStdout(["my-session", "1", "1"]) };
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
