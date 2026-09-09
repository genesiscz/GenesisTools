import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { materializeWorkspace } from "@app/cmux/lib/restore";
import type { Pane, Workspace } from "@app/cmux/lib/types";
import * as cli from "@genesiscz/utils/cmux/lib/cli";
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

function singleTerminalPane(surfaces: Pane["surfaces"]): Workspace {
    return {
        ref: "workspace:1",
        title: "fixture",
        selected: true,
        panes: [
            {
                ref: "pane:1",
                index: 0,
                columns: 80,
                rows: 24,
                selected_surface_index: 0,
                pixel_frame: { x: 0, y: 0, width: 800, height: 600 },
                surfaces,
            },
        ],
    };
}

function mockLiveSurface(): void {
    spyOn(split, "applySplitTree").mockResolvedValue(new Map([[0, "pane:1"]]));
    spyOn(split, "measureCellDelta").mockResolvedValue(0);
    spyOn(socket, "paneList").mockResolvedValue({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        container_frame: { width: 800, height: 600 },
        panes: [
            {
                ref: "pane:1",
                index: 0,
                surface_count: 1,
                surface_refs: ["surface:1"],
                selected_surface_ref: "surface:1",
                focused: true,
                pixel_frame: { x: 0, y: 0, width: 800, height: 600 },
            },
        ],
    });
    spyOn(cli, "runCmux").mockResolvedValue({ code: 0, stdout: "➜  repo ", stderr: "" });
    spyOn(cli, "runCmuxOk").mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    spyOn(cli, "sendSurfaceText").mockResolvedValue({ code: 0, stdout: "", stderr: "" });
}

// PR #374 review: queueReplayCommand refused the pretype and warned, but the outcome
// still said converged, so the CLI printed Done with exit 0 on a short restore.
test("a refused pretype is reported as a restore failure, not a silent warning", async () => {
    mockLiveSurface();
    const result = await materializeWorkspace(
        singleTerminalPane([
            { type: "terminal", title: "logs", command: "echo one\necho two", command_source: "shell-journal" },
        ]),
        "workspace:1",
        { prefix: "", replay: true, enter: false, yes: true, dryRun: false }
    );
    expect(result.converged).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.paneRef).toBe("pane:1");
    expect(result.failures[0]?.message).toMatch(/surface:1.*--enter/);
});

test("an ordinary single-line replay still converges", async () => {
    mockLiveSurface();
    const send = spyOn(cli, "sendSurfaceText").mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const result = await materializeWorkspace(
        singleTerminalPane([
            { type: "terminal", title: "logs", command: "tail -f app.log", command_source: "shell-journal" },
        ]),
        "workspace:1",
        { prefix: "", replay: true, enter: false, yes: true, dryRun: false }
    );
    expect(result.failures).toEqual([]);
    expect(result.converged).toBe(true);
    expect(send).toHaveBeenCalledWith({ surfaceRef: "surface:1", text: "tail -f app.log" });
});
