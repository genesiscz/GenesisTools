import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { materializeWorkspace } from "@app/cmux/lib/restore";
import type { Workspace } from "@app/cmux/lib/types";
import * as socket from "@genesiscz/utils/cmux/lib/socket";
import * as split from "@genesiscz/utils/cmux/split-tree";

afterEach(() => mock.restore());

test("an invalid browser anchor marks non-convergence and attempts later panes", async () => {
    spyOn(split, "applySplitTree").mockResolvedValue(
        new Map([
            [0, "pane:1"],
            [1, "pane:2"],
        ])
    );
    spyOn(split, "measureCellDelta").mockResolvedValue(0);
    const inspect = spyOn(socket, "paneList").mockResolvedValue({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        container_frame: { width: 800, height: 600 },
        panes: [
            {
                ref: "pane:1",
                index: 0,
                surface_count: 2,
                surface_refs: ["surface:1", "surface:2"],
                selected_surface_ref: "surface:1",
                focused: false,
                pixel_frame: { x: 0, y: 0, width: 400, height: 600 },
            },
        ],
    });
    const ws: Workspace = {
        ref: "workspace:1",
        title: "fixture",
        selected: true,
        panes: [0, 1].map((index) => ({
            ref: `pane:${index + 1}`,
            index,
            columns: 40,
            rows: 30,
            selected_surface_index: 0,
            pixel_frame: { x: index * 400, y: 0, width: 400, height: 600 },
            surfaces: [{ type: "browser", title: "fixture", url: "https://example.com" }],
        })),
    };
    const result = await materializeWorkspace(ws, "workspace:1", {
        prefix: "",
        replay: false,
        enter: false,
        yes: true,
        dryRun: false,
    });
    expect(result.converged).toBe(false);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatchObject({
        paneRef: "pane:1",
        message: expect.stringContaining("fresh restore anchor"),
    });
    expect(inspect).toHaveBeenCalledTimes(2);
});
