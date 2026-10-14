import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as cli from "@genesiscz/utils/cmux/lib/cli";
import * as controls from "@genesiscz/utils/cmux/lib/controls";
import { attachTmuxToCmux } from "@genesiscz/utils/cmux/send-tmux";
import * as workspace from "@genesiscz/utils/cmux/workspace";
import { resetTmuxBinCache, setTmuxBinForTests } from "@genesiscz/utils/tmux/bin";
import { formatWithRecordSeparator, setTmuxSpawnSyncForTests } from "@genesiscz/utils/tmux/sessions";

const WORKSPACE = "11111111-1111-4111-8111-111111111109";
const PANE = "22222222-2222-4222-8222-222222222202";
const OTHER_PANE = "22222222-2222-4222-8222-222222222205";
const SURFACE = "33333333-3333-4333-8333-333333333303";
const OTHER_SURFACE = "33333333-3333-4333-8333-333333333307";

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

        const ensureSpy = spyOn(workspace, "ensureWorkspaceByName").mockResolvedValue(WORKSPACE);
        const splitSpy = spyOn(workspace, "openSplitInWorkspace").mockResolvedValue({
            workspaceId: WORKSPACE,
            paneId: PANE,
            surfaceId: SURFACE,
        });
        const sendSpy = spyOn(workspace, "sendAttachCommand").mockResolvedValue(undefined);
        const renameSpy = spyOn(workspace, "renameSurfaceTab").mockResolvedValue(undefined);
        const focusSpy = spyOn(controls, "focusCmuxPane").mockResolvedValue(undefined);

        const result = await attachTmuxToCmux({
            tmuxSessionName: "my-session",
            target: { mode: "workspace_by_name", workspaceName: "DevDashboard" },
        });

        expect(result).toEqual({
            workspaceId: WORKSPACE,
            paneId: PANE,
            surfaceId: SURFACE,
            tmuxSessionName: "my-session",
        });
        expect(ensureSpy).toHaveBeenCalledWith("DevDashboard", undefined);
        expect(splitSpy).toHaveBeenCalledWith(WORKSPACE);
        expect(sendSpy).toHaveBeenCalledWith({
            workspaceId: WORKSPACE,
            surfaceId: SURFACE,
            tmuxSessionName: "my-session",
        });
        expect(focusSpy).toHaveBeenCalledWith({ workspaceId: WORKSPACE, paneId: PANE });
        expect(renameSpy).toHaveBeenCalledWith(WORKSPACE, SURFACE, "my-session");

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
                target: { mode: "new_split", workspaceId: WORKSPACE },
            })
        ).rejects.toThrow("does not exist");
    });

    /**
     * The dashboard sends the surface UUID it got from the layout. The pane is found by that UUID;
     * the old lookup compared `surface_refs`, so a UUID never matched, and a stale `surface:N` matched
     * whichever tab holds that number now (here OTHER_PANE's tab, which took `surface:3`).
     */
    test("existing_surface finds the pane by surface UUID, not by a ref another tab now holds", async () => {
        setTmuxBinForTests("/mock/tmux");
        setTmuxSpawnSyncForTests((cmd) => {
            if (cmd.includes("list-sessions")) {
                return { exitCode: 0, stdout: listSessionsStdout(["my-session", "1", "1"]) };
            }

            return { exitCode: 0, stdout: "" };
        });

        // In call order: list-panes, list-pane-surfaces (the terminal check), identify (focus guard).
        const listed = spyOn(cli, "runCmuxJSON")
            .mockResolvedValueOnce({
                panes: [
                    { id: OTHER_PANE, ref: "pane:5", surface_ids: [OTHER_SURFACE], surface_refs: ["surface:3"] },
                    { id: PANE, ref: "pane:2", surface_ids: [SURFACE], surface_refs: ["surface:8"] },
                ],
            })
            .mockResolvedValueOnce({ surfaces: [{ id: SURFACE, ref: "surface:8", type: "terminal" }] })
            .mockResolvedValueOnce({ focused: { workspace_id: WORKSPACE } });
        const sendSpy = spyOn(workspace, "sendAttachCommand").mockResolvedValue(undefined);
        spyOn(workspace, "renameSurfaceTab").mockResolvedValue(undefined);
        const focusSpy = spyOn(controls, "focusCmuxPane").mockResolvedValue(undefined);

        try {
            const result = await attachTmuxToCmux({
                tmuxSessionName: "my-session",
                target: { mode: "existing_surface", workspaceId: WORKSPACE, surfaceId: SURFACE.toLowerCase() },
            });

            expect(result.paneId).toBe(PANE);
            expect(listed.mock.calls[1]?.[0]).toEqual(["list-pane-surfaces", "--workspace", WORKSPACE, "--pane", PANE]);
            expect(sendSpy).toHaveBeenCalledTimes(1);
            expect(focusSpy).toHaveBeenCalledWith({ workspaceId: WORKSPACE, paneId: PANE });
        } finally {
            mock.restore();
        }
    });
});
