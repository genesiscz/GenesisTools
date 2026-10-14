import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { scanForInteractivePrompts } from "@app/cmux/lib/restore";
import * as cli from "@genesiscz/utils/cmux/lib/cli";
import * as socket from "@genesiscz/utils/cmux/lib/socket";

const WORKSPACE_5 = "11111111-1111-4111-8111-111111111105";
const WORKSPACE_6 = "11111111-1111-4111-8111-111111111106";
const PANE = "22222222-2222-4222-8222-222222222210";
const TERMINAL = "33333333-3333-4333-8333-333333333336";
const BROWSER = "33333333-3333-4333-8333-333333333340";

describe("restored prompt scan", () => {
    afterEach(() => mock.restore());

    function setup() {
        const panes = spyOn(socket, "paneList").mockImplementation(async (workspace) => ({
            workspace_id: workspace,
            workspace_ref: workspace === WORKSPACE_5 ? "workspace:5" : "workspace:6",
            window_ref: "window:2",
            container_frame: { width: 800, height: 600 },
            panes: [
                {
                    id: PANE,
                    ref: "pane:10",
                    index: 0,
                    surface_count: 2,
                    surface_ids: [TERMINAL, BROWSER],
                    surface_refs: ["surface:36", "surface:40"],
                    selected_surface_id: TERMINAL,
                    selected_surface_ref: "surface:36",
                    focused: false,
                    pixel_frame: { x: 0, y: 0, width: 800, height: 600 },
                },
            ],
        }));
        const list = spyOn(cli, "runCmuxJSON").mockResolvedValue({
            surfaces: [
                { id: TERMINAL, ref: "surface:36", type: "terminal" },
                { id: BROWSER, ref: "surface:40", type: "browser" },
            ],
        });
        return {
            panes,
            list,
            read: spyOn(cli, "runCmuxOk").mockResolvedValue({ code: 0, stdout: "Launch anyway?", stderr: "" }),
        };
    }

    test("reads only listed terminals by UUID and reports their prompts by ref", async () => {
        const { list, read } = setup();
        const result = await scanForInteractivePrompts([WORKSPACE_5]);
        expect(list.mock.calls).toEqual([[["list-pane-surfaces", "--workspace", WORKSPACE_5, "--pane", PANE]]]);
        expect(read.mock.calls).toEqual([[["read-screen", "--workspace", WORKSPACE_5, "--surface", TERMINAL]]]);
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
        setup().read.mockRejectedValue(new Error("surface closed"));
        const result = await scanForInteractivePrompts([WORKSPACE_5]);
        expect(result).toEqual({ waiting: [], failures: [expect.stringContaining("surface:36")] });
    });

    test("continues scanning later workspaces after a listing failure", async () => {
        const { panes } = setup();
        panes.mockRejectedValueOnce(new Error("workspace closed"));
        const result = await scanForInteractivePrompts([WORKSPACE_5, WORKSPACE_6]);
        expect(result.failures).toHaveLength(1);
        expect(result.waiting[0]?.workspaceRef).toBe("workspace:6");
    });
});
