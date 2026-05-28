import { describe, expect, spyOn, test, afterEach } from "bun:test";
import * as cli from "@app/cmux/lib/cli";
import * as socket from "@app/cmux/lib/socket";
import { fetchCmuxFullLayout, findWorkspaceByName, formatDualPreview } from "@app/utils/cmux/layout";

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
                id: "w1",
                index: 0,
                visible: true,
                key: false,
                workspace_count: 1,
            },
        ]);
        const rpcSpy = spyOn(socket, "rpc").mockResolvedValue({
            workspaces: [{ ref: "workspace:1", id: "ws1", index: 0, title: "Main", selected: true }],
        });
        const runJsonSpy = spyOn(cli, "runCmuxJSON").mockImplementation(async (args: string[]) => {
            if (args[0] === "list-panes") {
                return {
                    panes: [
                        {
                            ref: "pane:1",
                            title: "shell",
                            focused: true,
                            selected_surface_ref: "surface:1",
                            surface_count: 1,
                        },
                    ],
                };
            }

            if (args[0] === "list-pane-surfaces") {
                return {
                    surfaces: [
                        {
                            ref: "surface:1",
                            title: "zsh",
                            type: "terminal",
                            selected: true,
                        },
                    ],
                };
            }

            throw new Error(`unexpected args ${args.join(" ")}`);
        });
        const runSpy = spyOn(cli, "runCmux").mockResolvedValue({ code: 0, stdout: "prompt $", stderr: "" });

        const layout = await fetchCmuxFullLayout();

        expect(layout.available).toBe(true);
        expect(layout.windows).toHaveLength(1);
        expect(layout.windows[0]?.workspaces[0]?.name).toBe("Main");
        expect(layout.windows[0]?.workspaces[0]?.panes[0]?.surfaces[0]?.title).toBe("zsh");

        windowListSpy.mockRestore();
        rpcSpy.mockRestore();
        runJsonSpy.mockRestore();
        runSpy.mockRestore();
    });

    test("findWorkspaceByName returns ref when present", async () => {
        const windowListSpy = spyOn(socket, "windowList").mockResolvedValue([
            {
                ref: "window:1",
                id: "w1",
                index: 0,
                visible: true,
                key: false,
                workspace_count: 1,
            },
        ]);
        const rpcSpy = spyOn(socket, "rpc").mockResolvedValue({
            workspaces: [{ ref: "workspace:5", id: "ws5", index: 0, title: "DevDashboard", selected: false }],
        });
        spyOn(cli, "runCmuxJSON").mockResolvedValue({ panes: [] });
        spyOn(cli, "runCmux").mockResolvedValue({ code: 0, stdout: "", stderr: "" });

        const found = await findWorkspaceByName("DevDashboard");

        expect(found).toEqual({ workspaceId: "workspace:5", windowId: "window:1" });

        windowListSpy.mockRestore();
        rpcSpy.mockRestore();
    });
});
