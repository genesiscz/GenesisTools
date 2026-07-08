import { describe, expect, it } from "bun:test";
import { cardSides, nearestSidePair, nearestSideToPoint } from "./edge-anchor";

describe("cardSides", () => {
    it("returns top/bottom/left/right midpoints", () => {
        const sides = cardSides({ x: 0, y: 0, w: 100, h: 50 });
        expect(sides).toEqual([
            { x: 50, y: 0 },
            { x: 50, y: 50 },
            { x: 0, y: 25 },
            { x: 100, y: 25 },
        ]);
    });
});

describe("nearestSidePair", () => {
    it("picks right-of-a / left-of-b when b sits to the right", () => {
        const a = { x: 0, y: 0, w: 100, h: 100 };
        const b = { x: 300, y: 0, w: 100, h: 100 };
        const [pa, pb] = nearestSidePair(a, b);
        expect(pa).toEqual({ x: 100, y: 50 }); // a's right side
        expect(pb).toEqual({ x: 300, y: 50 }); // b's left side
    });

    it("picks bottom-of-a / top-of-b when b sits directly below", () => {
        const a = { x: 0, y: 0, w: 100, h: 100 };
        const b = { x: 0, y: 300, w: 100, h: 100 };
        const [pa, pb] = nearestSidePair(a, b);
        expect(pa).toEqual({ x: 50, y: 100 }); // a's bottom side
        expect(pb).toEqual({ x: 50, y: 300 }); // b's top side
    });

    it("is symmetric: swapping a/b swaps the returned pair", () => {
        // Offset asymmetrically (not a 45° diagonal) so there's no exact tie between candidate pairs.
        const a = { x: 0, y: 0, w: 100, h: 100 };
        const b = { x: 400, y: 300, w: 100, h: 100 };
        const [pa, pb] = nearestSidePair(a, b);
        const [pb2, pa2] = nearestSidePair(b, a);
        expect(pa).toEqual(pa2);
        expect(pb).toEqual(pb2);
    });
});

describe("nearestSideToPoint", () => {
    it("picks the side closest to a point below-left of the card", () => {
        const r = { x: 0, y: 0, w: 100, h: 100 };
        const side = nearestSideToPoint(r, { x: -50, y: 200 });
        expect(side).toEqual({ x: 50, y: 100 }); // bottom is closest
    });
});
