import { describe, expect, test } from "bun:test";
import {
    buildBalancedMosaicLayout,
    flattenMosaicLeaves,
    pruneMosaicLeaves,
    reconcileMosaicLayout,
} from "@app/utils/ui/helpers/mosaic-layout";

describe("mosaic layout helpers", () => {
    test("balances ttyd panes into stable rows", () => {
        expect(flattenMosaicLeaves(buildBalancedMosaicLayout(["1", "2", "3"], { maxColumns: 3 }))).toEqual([
            "1",
            "2",
            "3",
        ]);

        const four = buildBalancedMosaicLayout(["1", "2", "3", "4"], { maxColumns: 3 });

        expect(four).toEqual({
            type: "split",
            direction: "column",
            children: [
                { type: "split", direction: "row", children: ["1", "2"], splitPercentages: [50, 50] },
                { type: "split", direction: "row", children: ["3", "4"], splitPercentages: [50, 50] },
            ],
            splitPercentages: [50, 50],
        });
    });

    test("adds fifth pane to the second balanced row", () => {
        const five = buildBalancedMosaicLayout(["1", "2", "3", "4", "5"], { maxColumns: 3 });

        expect(five).toEqual({
            type: "split",
            direction: "column",
            children: [
                { type: "split", direction: "row", children: ["1", "2"], splitPercentages: [50, 50] },
                {
                    type: "split",
                    direction: "row",
                    children: ["3", "4", "5"],
                    splitPercentages: [33.3333, 33.3333, 33.3333],
                },
            ],
            splitPercentages: [50, 50],
        });
    });

    test("can place extra panes in the first row for compact cmux grids", () => {
        const three = buildBalancedMosaicLayout(["1", "2", "3"], {
            maxColumns: 2,
            extraRowPlacement: "start",
        });

        expect(three).toEqual({
            type: "split",
            direction: "column",
            children: [{ type: "split", direction: "row", children: ["1", "2"], splitPercentages: [50, 50] }, "3"],
            splitPercentages: [50, 50],
        });
    });

    test("reconciles missing and new panes without losing existing order", () => {
        const current = buildBalancedMosaicLayout(["1", "2", "3", "4"], { maxColumns: 3 });
        const next = reconcileMosaicLayout(current, ["1", "3", "4", "5"], { maxColumns: 3 });

        expect(flattenMosaicLeaves(next)).toEqual(["1", "3", "4", "5"]);
    });

    test("followNextItemOrder lays out new panes in nextItems order (newest first)", () => {
        const current = buildBalancedMosaicLayout(["1", "2", "3", "4"], { maxColumns: 3 });
        const next = reconcileMosaicLayout(current, ["5", "1", "3", "4"], {
            maxColumns: 3,
            followNextItemOrder: true,
        });

        expect(flattenMosaicLeaves(next)).toEqual(["5", "1", "3", "4"]);
    });

    test("keeps the current layout object when panes did not change", () => {
        const current = buildBalancedMosaicLayout(["1", "2", "3"], { maxColumns: 3 });
        const next = reconcileMosaicLayout(current, ["1", "2", "3"], { maxColumns: 3 });

        expect(next).toBe(current);
    });

    test("removes hidden panes from the current layout", () => {
        const current = buildBalancedMosaicLayout(["1", "2", "3"], { maxColumns: 3 });
        const next = reconcileMosaicLayout(current, ["1", "3"], { maxColumns: 3 });

        expect(flattenMosaicLeaves(next)).toEqual(["1", "3"]);
        expect(next).not.toBe(current);
    });

    test("returns null when all panes are removed", () => {
        const current = buildBalancedMosaicLayout(["1", "2"], { maxColumns: 3 });
        const next = reconcileMosaicLayout(current, [], { maxColumns: 3 });

        expect(next).toBeNull();
    });

    test("prunes stale pane leaves while preserving remaining leaves", () => {
        const current = buildBalancedMosaicLayout(["1", "2", "3", "4"], { maxColumns: 3 });
        const next = pruneMosaicLeaves(current, new Set(["2"]));

        expect(flattenMosaicLeaves(next)).toEqual(["1", "3", "4"]);
    });
});
