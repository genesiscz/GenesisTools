import { describe, expect, test } from "bun:test";
import { fitBounds, MAX_SCALE, MIN_SCALE, screenToWorld, zoomAt } from "./useViewport";

describe("zoomAt", () => {
    test("keeps the anchor screen point fixed on the world plane", () => {
        const before = { x: 40, y: -20, scale: 1.3 };
        const sx = 250;
        const sy = 180;
        const worldBefore = screenToWorld(before, sx, sy);

        const after = zoomAt(before, 1.7, sx, sy);
        const worldAfter = screenToWorld(after, sx, sy);

        expect(Math.abs(worldAfter.x - worldBefore.x)).toBeLessThan(1e-9);
        expect(Math.abs(worldAfter.y - worldBefore.y)).toBeLessThan(1e-9);
    });

    test("clamps scale at MAX_SCALE", () => {
        const before = { x: 0, y: 0, scale: MAX_SCALE };
        const after = zoomAt(before, 10, 0, 0);
        expect(after.scale).toBe(MAX_SCALE);
    });

    test("clamps scale at MIN_SCALE", () => {
        const before = { x: 0, y: 0, scale: MIN_SCALE };
        const after = zoomAt(before, 0.01, 0, 0);
        expect(after.scale).toBe(MIN_SCALE);
    });
});

describe("fitBounds", () => {
    test("centers a 100x100 box in a 1000x350 screen", () => {
        const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
        const vp = fitBounds(bounds, 1000, 350, 0);

        // Square box, screen is much wider than tall -> scale is bound by height.
        expect(vp.scale).toBeCloseTo(3.5, 5);

        const topLeft = screenToWorld(vp, 0, 0);
        const bottomRight = screenToWorld(vp, 1000, 350);
        const worldCenterX = (topLeft.x + bottomRight.x) / 2;
        const worldCenterY = (topLeft.y + bottomRight.y) / 2;

        expect(worldCenterX).toBeCloseTo(50, 5);
        expect(worldCenterY).toBeCloseTo(50, 5);
    });

    test("respects padding when computing scale", () => {
        const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
        const vp = fitBounds(bounds, 1000, 600, 150);

        // (600 - 300) / 100 = 3 is the binding dimension.
        expect(vp.scale).toBeCloseTo(3, 5);
    });
});
