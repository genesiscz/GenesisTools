import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as socket from "@app/cmux/lib/socket";

describe("cmux socket RPC params", () => {
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
