import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as cli from "@genesiscz/utils/cmux/lib/cli";
import type { PaneListPane } from "@genesiscz/utils/cmux/lib/socket";
import * as socket from "@genesiscz/utils/cmux/lib/socket";
import { applySplitTree, resizeStep } from "@genesiscz/utils/cmux/split-tree";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PANE_1 = "22222222-2222-4222-8222-222222222201";
const PANE_2 = "22222222-2222-4222-8222-222222222202";
const SURFACE_1 = "33333333-3333-4333-8333-333333333301";
const SURFACE_2 = "33333333-3333-4333-8333-333333333302";

function pane(overrides: Partial<PaneListPane> & { ref: string }): PaneListPane {
    return {
        id: PANE_1,
        index: 0,
        surface_count: 1,
        surface_ids: [SURFACE_1],
        surface_refs: ["surface:1"],
        selected_surface_id: SURFACE_1,
        selected_surface_ref: "surface:1",
        focused: false,
        columns: 100,
        rows: 40,
        cell_width_px: 16,
        cell_height_px: 34,
        pixel_frame: { x: 0, y: 0, width: 1600, height: 1360 },
        ...overrides,
    };
}

const FIRST_PASS = Number.POSITIVE_INFINITY;

describe("resizeStep", () => {
    test("an even split that already matches needs no move", () => {
        const step = resizeStep({
            oldPane: pane({ ref: "pane:1", pixel_frame: { x: 0, y: 0, width: 800, height: 1000 } }),
            newPane: pane({ ref: "pane:2", pixel_frame: { x: 800, y: 0, width: 800, height: 1000 } }),
            vsplit: true,
            fraction: 0.5,
            lastDeltaPx: FIRST_PASS,
        });

        expect(step.kind).toBe("done");
    });

    test("a fresh 50/50 split targeting a third moves the border left, in pixels", () => {
        const step = resizeStep({
            oldPane: pane({ ref: "pane:1", pixel_frame: { x: 0, y: 0, width: 900, height: 1000 } }),
            newPane: pane({ ref: "pane:2", pixel_frame: { x: 900, y: 0, width: 900, height: 1000 } }),
            vsplit: true,
            fraction: 1 / 3,
            lastDeltaPx: FIRST_PASS,
        });

        // 1800px total, the left column should be 600 — so shrink the old pane by 300.
        expect(step).toEqual({ kind: "move", target: "new", direction: "-L", amountPx: 300, deltaPx: 300 });
    });

    test("an old pane that is too SMALL moves the border the other way, on the old pane", () => {
        const step = resizeStep({
            oldPane: pane({ ref: "pane:1", pixel_frame: { x: 0, y: 0, width: 600, height: 1000 } }),
            newPane: pane({ ref: "pane:2", pixel_frame: { x: 600, y: 0, width: 1200, height: 1000 } }),
            vsplit: true,
            fraction: 0.5,
            lastDeltaPx: FIRST_PASS,
        });

        expect(step).toMatchObject({ kind: "move", target: "old", direction: "-R", amountPx: 300 });
    });

    test("a horizontal split resizes vertically", () => {
        const step = resizeStep({
            oldPane: pane({ ref: "pane:1", pixel_frame: { x: 0, y: 0, width: 800, height: 900 } }),
            newPane: pane({ ref: "pane:2", pixel_frame: { x: 0, y: 900, width: 800, height: 900 } }),
            vsplit: false,
            fraction: 1 / 3,
            lastDeltaPx: FIRST_PASS,
        });

        expect(step).toMatchObject({ kind: "move", target: "new", direction: "-U", amountPx: 300 });
    });

    /**
     * The regression this whole function exists for: cmux reports NO columns/rows for a
     * pane it has not rendered yet, and the old cell-based math turned that into
     * `resize-pane --amount NaN`, which failed silently and left every grid at 50/50.
     */
    test("a brand-new pane with no cell geometry still produces a real pixel move", () => {
        const fresh = pane({
            ref: "pane:2",
            pixel_frame: { x: 900, y: 0, width: 900, height: 1000 },
        });
        delete fresh.columns;
        delete fresh.rows;
        delete fresh.cell_width_px;
        delete fresh.cell_height_px;

        const step = resizeStep({
            oldPane: pane({ ref: "pane:1", pixel_frame: { x: 0, y: 0, width: 900, height: 1000 } }),
            newPane: fresh,
            vsplit: true,
            fraction: 1 / 3,
            lastDeltaPx: FIRST_PASS,
        });

        expect(step).toMatchObject({ kind: "move", amountPx: 300 });

        if (step.kind === "move") {
            expect(Number.isFinite(step.amountPx)).toBe(true);
        }
    });

    test("missing pixel geometry gives up instead of sending a bad amount", () => {
        const broken = pane({ ref: "pane:2" });
        broken.pixel_frame = undefined as unknown as PaneListPane["pixel_frame"];

        expect(
            resizeStep({
                oldPane: pane({ ref: "pane:1" }),
                newPane: broken,
                vsplit: true,
                fraction: 0.5,
                lastDeltaPx: FIRST_PASS,
            })
        ).toEqual({ kind: "stuck", reason: "no-geometry" });
    });

    test("a delta that stopped shrinking is a stall, not another attempt", () => {
        const step = resizeStep({
            oldPane: pane({ ref: "pane:1", pixel_frame: { x: 0, y: 0, width: 900, height: 1000 } }),
            newPane: pane({ ref: "pane:2", pixel_frame: { x: 900, y: 0, width: 900, height: 1000 } }),
            vsplit: true,
            fraction: 1 / 3,
            lastDeltaPx: 300,
        });

        expect(step).toEqual({ kind: "stuck", reason: "no-progress" });
    });

    test("sub-cell differences are left alone", () => {
        const step = resizeStep({
            oldPane: pane({ ref: "pane:1", pixel_frame: { x: 0, y: 0, width: 808, height: 1000 } }),
            newPane: pane({ ref: "pane:2", pixel_frame: { x: 808, y: 0, width: 792, height: 1000 } }),
            vsplit: true,
            fraction: 0.5,
            lastDeltaPx: FIRST_PASS,
        });

        expect(step.kind).toBe("done");
    });
});

describe("applySplitTree", () => {
    afterEach(() => mock.restore());

    /**
     * Every call names panes and surfaces by UUID, and the result maps leaves to pane UUIDs. The
     * listings renumber the refs on purpose (the new pane takes the old pane's `pane:7` and
     * `surface:1`, as after a relaunch): matching by ref would map leaf 0 to the new pane.
     */
    test("splits, resizes and maps by UUID even when the refs move", async () => {
        const calls: string[][] = [];
        let resized = false;
        let listings = 0;

        spyOn(socket, "paneList").mockImplementation(async () => {
            listings += 1;
            // After the first listing the old pane is renumbered and the new one takes its refs.
            const first = pane({
                ref: listings === 1 ? "pane:7" : "pane:9",
                surface_refs: listings === 1 ? ["surface:1"] : ["surface:3"],
                focused: true,
            });

            if (listings === 1) {
                return {
                    workspace_id: WORKSPACE,
                    workspace_ref: "workspace:1",
                    window_ref: "window:1",
                    container_frame: { width: 1800, height: 1000 },
                    panes: [first],
                };
            }

            const widths = resized ? [600, 1200] : [900, 900];
            return {
                workspace_id: WORKSPACE,
                workspace_ref: "workspace:1",
                window_ref: "window:1",
                container_frame: { width: 1800, height: 1000 },
                panes: [
                    { ...first, pixel_frame: { x: 0, y: 0, width: widths[0], height: 1000 } },
                    pane({
                        id: PANE_2,
                        ref: "pane:7",
                        surface_ids: [SURFACE_2],
                        surface_refs: ["surface:1"],
                        selected_surface_id: SURFACE_2,
                        pixel_frame: { x: widths[0], y: 0, width: widths[1], height: 1000 },
                    }),
                ],
            };
        });
        const split = spyOn(cli, "runCmuxJSON").mockResolvedValue({
            pane_id: PANE_2,
            pane_ref: "pane:7",
            surface_id: SURFACE_2,
            surface_ref: "surface:1",
        });
        spyOn(cli, "runCmuxOk").mockImplementation(async (args: string[]) => {
            calls.push(args);
            resized = true;
            return { code: 0, stdout: "", stderr: "" };
        });

        const map = await applySplitTree(
            {
                kind: "vsplit",
                left: { kind: "leaf", paneIndex: 0 },
                right: { kind: "leaf", paneIndex: 1 },
                leftFraction: 1 / 3,
            },
            WORKSPACE
        );

        expect(split.mock.calls).toEqual([[["new-split", "right", "--workspace", WORKSPACE, "--surface", SURFACE_1]]]);
        expect(calls).toEqual([["resize-pane", "--workspace", WORKSPACE, "--pane", PANE_2, "-L", "--amount", "300"]]);
        expect([...map.entries()]).toEqual([
            [0, PANE_1],
            [1, PANE_2],
        ]);
    });

    test("a new-split answer without UUIDs fails by name instead of anchoring on a ref", async () => {
        spyOn(socket, "paneList").mockResolvedValue({
            workspace_id: WORKSPACE,
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            container_frame: { width: 1800, height: 1000 },
            panes: [pane({ ref: "pane:7" })],
        });
        spyOn(cli, "runCmuxJSON").mockResolvedValue({ pane_ref: "pane:8", surface_ref: "surface:2" });

        await expect(
            applySplitTree(
                {
                    kind: "vsplit",
                    left: { kind: "leaf", paneIndex: 0 },
                    right: { kind: "leaf", paneIndex: 1 },
                    leftFraction: 0.5,
                },
                WORKSPACE
            )
        ).rejects.toThrow(/without pane_id\/surface_id/);
    });
});
