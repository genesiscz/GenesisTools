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
            expect(cliSpy).toHaveBeenCalledWith(["list-panes", "--workspace", "workspace:5"]);
            expect(rpcSpy).not.toHaveBeenCalled();
        } finally {
            cliSpy.mockRestore();
            rpcSpy.mockRestore();
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
