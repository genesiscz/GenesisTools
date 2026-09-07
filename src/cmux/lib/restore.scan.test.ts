import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { scanForInteractivePrompts } from "@app/cmux/lib/restore";
import * as cli from "@genesiscz/utils/cmux/lib/cli";
import * as socket from "@genesiscz/utils/cmux/lib/socket";

describe("restored prompt scan", () => {
    afterEach(() => mock.restore());

    function setup() {
        spyOn(socket, "paneList").mockImplementation(async (workspaceRef) => ({
            workspace_ref: workspaceRef,
            window_ref: "window:2",
            container_frame: { width: 800, height: 600 },
            panes: [
                {
                    ref: "pane:10",
                    index: 0,
                    surface_count: 2,
                    surface_refs: ["surface:36", "surface:40"],
                    selected_surface_ref: "surface:36",
                    focused: false,
                    pixel_frame: { x: 0, y: 0, width: 800, height: 600 },
                },
            ],
        }));
        spyOn(cli, "runCmuxJSON").mockResolvedValue({
            surfaces: [
                { ref: "surface:36", type: "terminal" },
                { ref: "surface:40", type: "browser" },
            ],
        });
        return spyOn(cli, "runCmuxOk").mockResolvedValue({ code: 0, stdout: "Launch anyway?", stderr: "" });
    }

    test("reads only listed terminals and reports their prompts", async () => {
        const read = setup();
        const result = await scanForInteractivePrompts(["workspace:5"]);
        expect(read.mock.calls).toEqual([[["read-screen", "--workspace", "workspace:5", "--surface", "surface:36"]]]);
        expect(result).toEqual({
            waiting: [
                {
                    workspaceRef: "workspace:5",
                    surfaceRef: "surface:36",
                    prompt: expect.stringContaining("account-headroom"),
                },
            ],
            failures: [],
        });
    });

    test("records read failures instead of claiming an empty successful scan", async () => {
        setup().mockRejectedValue(new Error("surface closed"));
        const result = await scanForInteractivePrompts(["workspace:5"]);
        expect(result).toEqual({ waiting: [], failures: [expect.stringContaining("surface:36")] });
    });

    test("continues scanning later workspaces after a listing failure", async () => {
        setup();
        spyOn(socket, "paneList").mockRejectedValueOnce(new Error("workspace closed"));
        const result = await scanForInteractivePrompts(["workspace:5", "workspace:6"]);
        expect(result.failures).toHaveLength(1);
        expect(result.waiting[0]?.workspaceRef).toBe("workspace:6");
    });
});
