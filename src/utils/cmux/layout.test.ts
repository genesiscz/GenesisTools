import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { fetchCmuxFullLayout, findWorkspaceByName, formatDualPreview } from "@genesiscz/utils/cmux/layout";
import * as cli from "@genesiscz/utils/cmux/lib/cli";
import * as socket from "@genesiscz/utils/cmux/lib/socket";

const WINDOW = "0B000000-0000-4000-8000-000000000001";
const WORKSPACE = "11111111-1111-4111-8111-111111111101";
const PANE = "22222222-2222-4222-8222-222222222201";
const SURFACE = "33333333-3333-4333-8333-333333333301";

describe("formatDualPreview", () => {
    test("passes through short output unchanged", () => {
        expect(formatDualPreview("line1\nline2")).toBe("line1\nline2");
    });

    test("collapses long output to head and tail", () => {
        const lines = Array.from({ length: 120 }, (_, index) => `line-${index}`);
        const formatted = formatDualPreview(lines.join("\n"));
        expect(formatted.startsWith("line-0\nline-1")).toBe(true);
        expect(formatted).toContain("── ··· 21 lines ··· ──");
        expect(formatted.endsWith("line-119")).toBe(true);
    });
});

describe("fetchCmuxFullLayout", () => {
    afterEach(() => {
        // restore spies if still active
    });

    test("maps multi-window layout tree", async () => {
        const windowListSpy = spyOn(socket, "windowList").mockResolvedValue([
            {
                ref: "window:1",
                id: WINDOW,
                index: 0,
                visible: true,
                key: false,
                workspace_count: 1,
            },
        ]);
        const rpcSpy = spyOn(socket, "rpc").mockResolvedValue({
            workspaces: [{ ref: "workspace:1", id: WORKSPACE, index: 0, title: "Main", selected: true }],
        });
        const runJsonSpy = spyOn(cli, "runCmuxJSON")
            .mockResolvedValueOnce({
                panes: [
                    {
                        id: PANE,
                        ref: "pane:1",
                        title: "shell",
                        focused: true,
                        selected_surface_ref: "surface:1",
                        surface_count: 1,
                    },
                ],
            })
            .mockResolvedValueOnce({
                surfaces: [
                    {
                        id: SURFACE,
                        ref: "surface:1",
                        title: "zsh",
                        type: "terminal",
                        selected: true,
                    },
                ],
            });
        const runSpy = spyOn(cli, "runCmux").mockResolvedValue({ code: 0, stdout: "prompt $", stderr: "" });

        const layout = await fetchCmuxFullLayout();

        expect(layout.available).toBe(true);
        expect(layout.windows).toHaveLength(1);
        expect(layout.windows[0]?.workspaces[0]?.name).toBe("Main");
        expect(layout.windows[0]?.workspaces[0]?.panes[0]?.surfaces[0]?.title).toBe("zsh");

        // Every id is the UUID, and every follow-up call names its target by UUID: these ids go
        // back into focus, rename and close commands, where a renumbered ref names another tab.
        expect(layout.windows[0]?.id).toBe(WINDOW);
        expect(layout.windows[0]?.workspaces[0]?.id).toBe(WORKSPACE);
        expect(layout.windows[0]?.workspaces[0]?.panes[0]?.id).toBe(PANE);
        expect(layout.windows[0]?.workspaces[0]?.panes[0]?.surfaces[0]?.id).toBe(SURFACE);
        expect(rpcSpy).toHaveBeenCalledWith("workspace.list", { window_id: WINDOW });
        expect(runJsonSpy.mock.calls).toEqual([
            [["list-panes", "--workspace", WORKSPACE]],
            [["list-pane-surfaces", "--workspace", WORKSPACE, "--pane", PANE]],
        ]);
        expect(runSpy.mock.calls[0]?.[0]).toEqual([
            "capture-pane",
            "--workspace",
            WORKSPACE,
            "--surface",
            SURFACE,
            "--lines",
            "100",
        ]);

        windowListSpy.mockRestore();
        rpcSpy.mockRestore();
        runJsonSpy.mockRestore();
        runSpy.mockRestore();
    });

    test("findWorkspaceByName returns the workspace and window UUIDs when present", async () => {
        const windowListSpy = spyOn(socket, "windowList").mockResolvedValue([
            {
                ref: "window:1",
                id: WINDOW,
                index: 0,
                visible: true,
                key: false,
                workspace_count: 1,
            },
        ]);
        const rpcSpy = spyOn(socket, "rpc").mockResolvedValue({
            workspaces: [{ ref: "workspace:5", id: WORKSPACE, index: 0, title: "DevDashboard", selected: false }],
        });
        spyOn(cli, "runCmuxJSON").mockResolvedValue({ panes: [] });
        spyOn(cli, "runCmux").mockResolvedValue({ code: 0, stdout: "", stderr: "" });

        const found = await findWorkspaceByName("DevDashboard");

        expect(found).toEqual({ workspaceId: WORKSPACE, windowId: WINDOW });

        windowListSpy.mockRestore();
        rpcSpy.mockRestore();
    });
});
