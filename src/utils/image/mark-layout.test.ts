import { describe, expect, test } from "bun:test";
import type { LabelPosition } from "./annotation-plan";
import { clampedSpot, fallbackOrder, type LabelRequest, labelSpot, placeLabel, placeLabels } from "./mark-layout";

const RECT = { x: 100, y: 100, w: 80, h: 40 };
const SIZE = { w: 30, h: 10 };
const BOUNDS = { x: 0, y: 0, w: 400, h: 300 };

function request(position: LabelPosition, extra: Partial<LabelRequest> = {}): LabelRequest {
    return { rect: RECT, size: SIZE, position, gap: 4, ...extra };
}

describe("labelSpot", () => {
    test("each position puts the chip where its name says", () => {
        const spots = Object.fromEntries(
            (
                [
                    "top-left",
                    "top-right",
                    "top",
                    "bottom-left",
                    "bottom-right",
                    "bottom",
                    "left",
                    "right",
                    "inside",
                ] as const
            ).map((position) => {
                const { x, y } = labelSpot(request(position), position);
                return [position, [x, y]];
            })
        );

        expect(spots).toEqual({
            "top-left": [100, 86],
            "top-right": [150, 86],
            top: [125, 86],
            "bottom-left": [100, 144],
            "bottom-right": [150, 144],
            bottom: [125, 144],
            // side labels stand off by the leader reach and sit at the shape's vertical middle
            left: [34, 115],
            right: [216, 115],
            inside: [110, 108],
        });
    });

    test("an offset nudges the spot, and a side label without a leader stands off by the gap only", () => {
        expect(labelSpot(request("bottom-left", { offset: { x: 0, y: 40 } }), "bottom-left")).toMatchObject({
            x: 100,
            y: 184,
        });
        expect(labelSpot(request("left", { leader: false }), "left")).toMatchObject({ x: 66, y: 115 });
    });
});

describe("placeLabel", () => {
    test("the requested spot wins when it fits, and a side label gets its leader line", () => {
        const placement = placeLabel({ request: request("right"), bounds: BOUNDS, obstacles: [] });

        expect(placement).toEqual({
            ok: true,
            label: {
                chip: { x: 216, y: 115, w: 30, h: 10 },
                position: "right",
                moved: false,
                leader: { from: { x: 180, y: 120 }, to: { x: 216, y: 120 } },
            },
        });
    });

    test("a label that would leave the bounds takes the opposite side", () => {
        const placement = placeLabel({
            request: { ...request("top-left"), rect: { x: 100, y: 5, w: 80, h: 40 } },
            bounds: BOUNDS,
            obstacles: [],
        });

        expect(placement.ok && placement.label.position).toBe("bottom-left");
        expect(placement.ok && placement.label.moved).toBe(true);
    });

    test("a label skips spots that cover an obstacle (page text or an earlier label)", () => {
        const placement = placeLabel({
            request: request("top-left"),
            bounds: BOUNDS,
            obstacles: [
                { x: 90, y: 80, w: 100, h: 15 },
                { x: 90, y: 142, w: 100, h: 15 },
            ],
        });

        expect(placement.ok && placement.label.position).toBe("right");
    });

    test("a label that fits nowhere reports every position it tried", () => {
        const placement = placeLabel({ request: request("top-left"), bounds: RECT, obstacles: [RECT] });

        expect(placement).toEqual({ ok: false, tried: fallbackOrder("top-left") });
        expect(fallbackOrder("top-left")).toHaveLength(9);
        expect(fallbackOrder("left").slice(0, 2)).toEqual(["left", "right"]);
    });
});

describe("placeLabels", () => {
    test("a later label moves off an earlier one at the same spot", () => {
        const [first, second] = placeLabels({
            requests: [request("top-left"), request("top-left")],
            bounds: BOUNDS,
            obstacles: [],
        });

        expect(first.ok && first.label.position).toBe("top-left");
        expect(second.ok && second.label.position).toBe("bottom-left");
    });

    test("clampedSpot pushes the requested spot back inside the bounds", () => {
        const chip = clampedSpot({ ...request("top-left"), rect: { x: 390, y: 2, w: 8, h: 8 } }, BOUNDS).chip;

        expect(chip).toEqual({ x: 370, y: 0, w: 30, h: 10 });
    });
});
