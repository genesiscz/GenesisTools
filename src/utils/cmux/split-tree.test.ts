import { describe, expect, test } from "bun:test";
import type { PaneListPane } from "@genesiscz/utils/cmux/lib/socket";
import { resizeStep } from "@genesiscz/utils/cmux/split-tree";

function pane(overrides: Partial<PaneListPane> & { ref: string }): PaneListPane {
    return {
        index: 0,
        surface_count: 1,
        surface_refs: ["surface:1"],
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
