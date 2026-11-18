import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as cli from "@genesiscz/utils/cmux/lib/cli";
import * as socket from "@genesiscz/utils/cmux/lib/socket";

describe("cmux socket RPC params", () => {
    test("paneList uses the workspace-scoped CLI and preserves geometry", async () => {
        const layout = {
            workspace_ref: "workspace:5",
            window_ref: "window:2",
            panes: [],
            container_frame: { width: 100, height: 80 },
        };
        const cliSpy = spyOn(cli, "runCmuxJSON").mockResolvedValue(layout);
        const rpcSpy = spyOn(socket, "rpc").mockResolvedValue({ ...layout, workspace_ref: "workspace:1" });
        try {
            expect(await socket.paneList("workspace:5")).toEqual(layout);
            expect(cliSpy).toHaveBeenCalledWith(["--id-format", "both", "list-panes", "--workspace", "workspace:5"]);
            expect(rpcSpy).not.toHaveBeenCalled();
        } finally {
            cliSpy.mockRestore();
            rpcSpy.mockRestore();
        }
    });

    test("paneList drops a Dock pane, which has no geometry and claims the focus", async () => {
        const split = {
            id: "8A3C2B10-0000-4000-8000-000000000001",
            ref: "pane:1",
            index: 0,
            surface_count: 1,
            surface_ids: ["8A3C2B10-0000-4000-8000-0000000000A1"],
            surface_refs: ["surface:1"],
            selected_surface_id: "8A3C2B10-0000-4000-8000-0000000000A1",
            selected_surface_ref: "surface:1",
            focused: false,
            columns: 112,
            rows: 30,
            pixel_frame: { x: 0, y: 0, width: 1600, height: 1000 },
        };
        // cmux 0.65.1, 2026-11-18: the global Dock pane, field for field.
        const dock = {
            dock_scope: "global",
            focused: true,
            id: "8A3C2B10-0000-4000-8000-000000000002",
            index: 1,
            ref: "pane:2",
            selected_surface_id: null,
            selected_surface_ref: null,
            surface_count: 0,
            surface_ids: [],
            surface_refs: [],
        };
        const layout = {
            workspace_ref: "workspace:5",
            window_ref: "window:2",
            panes: [split, dock],
            container_frame: { width: 1816, height: 1262 },
        };
        const cliSpy = spyOn(cli, "runCmuxJSON").mockResolvedValue(layout);
        try {
            expect((await socket.paneList("workspace:5")).panes).toEqual([split]);
        } finally {
            cliSpy.mockRestore();
        }
    });

    test("paneList rejects a response for another workspace", async () => {
        const layout = { workspace_ref: "workspace:1", panes: [] };
        const cliSpy = spyOn(cli, "runCmuxJSON").mockResolvedValue(layout);
        const rpcSpy = spyOn(socket, "rpc").mockResolvedValue(layout);
        try {
            await expect(socket.paneList("workspace:5")).rejects.toThrow("workspace:1");
        } finally {
            cliSpy.mockRestore();
            rpcSpy.mockRestore();
        }
    });

    /**
     * Code asks by UUID now. The echoed ref cannot be compared with a UUID, and before
     * `--id-format both` there was no echoed UUID either, so this answer was believed.
     */
    test("paneList rejects a response for another workspace when asked by UUID", async () => {
        const asked = "11111111-1111-4111-8111-111111111105";
        const layout = {
            workspace_id: "11111111-1111-4111-8111-111111111101",
            workspace_ref: "workspace:1",
            panes: [],
        };
        const cliSpy = spyOn(cli, "runCmuxJSON").mockResolvedValue(layout);
        try {
            await expect(socket.paneList(asked)).rejects.toThrow("workspace:1");
            cliSpy.mockResolvedValue({ ...layout, workspace_id: asked.toUpperCase() });
            expect((await socket.paneList(asked)).workspace_ref).toBe("workspace:1");
        } finally {
            cliSpy.mockRestore();
        }
    });
    test.each([undefined, ""])("paneList rejects a missing UUID echo (%s) even when the ref matches", async (echo) => {
        const asked = "abcdefab-1111-4111-8111-111111111105";
        const cliSpy = spyOn(cli, "runCmuxJSON").mockResolvedValue({
            workspace_id: echo,
            workspace_ref: "workspace:5",
            panes: [],
        });
        try {
            await expect(socket.paneList(asked)).rejects.toThrow(asked);
        } finally {
            cliSpy.mockRestore();
        }
    });

    test.each([undefined, ""])("paneList rejects a missing workspace ref echo (%s)", async (echo) => {
        const cliSpy = spyOn(cli, "runCmuxJSON").mockResolvedValue({ workspace_ref: echo, panes: [] });
        try {
            await expect(socket.paneList("workspace:5")).rejects.toThrow("workspace:5");
        } finally {
            cliSpy.mockRestore();
        }
    });

    test("bare workspace indices remain uncheckable, while matching UUID echoes are case-insensitive", () => {
        expect(() => socket.assertLayoutIsFor("5", { workspace_ref: "" })).not.toThrow();
        const asked = "abcdefab-1111-4111-8111-111111111105";
        expect(() =>
            socket.assertLayoutIsFor(asked, { workspace_id: asked.toUpperCase(), workspace_ref: "workspace:5" })
        ).not.toThrow();
    });

    afterEach(() => {
        socket.resetSocketPathCache();
    });

    test("workspaceList passes window_id not window", async () => {
        const rpcSpy = spyOn(socket, "rpc").mockResolvedValue({
            window_ref: "window:1",
            window_id: "abc",
            workspaces: [],
        });

        await socket.workspaceList("window:1");

        expect(rpcSpy).toHaveBeenCalledWith("workspace.list", { window_id: "window:1" });

        rpcSpy.mockRestore();
    });

    test("workspaceCreate passes window_id not window", async () => {
        const rpcSpy = spyOn(socket, "rpc").mockResolvedValue({
            workspace_ref: "workspace:1",
            workspace_id: "ws",
            window_ref: "window:1",
            window_id: "abc",
        });

        await socket.workspaceCreate({ window: "window:1", name: "test" });

        expect(rpcSpy).toHaveBeenCalledWith("workspace.create", { name: "test", window_id: "window:1" });

        rpcSpy.mockRestore();
    });
});
