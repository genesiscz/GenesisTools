import { describe, expect, it } from "bun:test";
import { compareImagePixels } from "@genesiscz/utils/image/difference";
import type { DecodedRgba } from "@genesiscz/utils/image/raster";
import { FrameDifferenceGuard, frameDifferenceSummary } from "./difference-guard";

function pixels(changed: number): DecodedRgba {
    const data = new Uint8ClampedArray(10 * 4);
    for (let i = 0; i < 10; i++) {
        data.set(i < changed ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
    }

    return { width: 10, height: 1, data };
}

describe("image comparison and video difference guard", () => {
    it("returns exact changed pixel counts and an optional highlighted buffer", () => {
        const result = compareImagePixels({ a: pixels(0), b: pixels(3), includeDiff: true });
        expect(result.mismatchedPixels).toBe(3);
        expect(result.totalPixels).toBe(10);
        expect(result.differencePct).toBe(30);
        expect(result.similarity).toBe(0.7);
        expect(result.diff?.length).toBe(40);
        expect(compareImagePixels({ a: pixels(0), b: pixels(0) }).diff).toBeUndefined();
    });

    it("keeps the first and equal-threshold samples, compares gradual changes to the last kept frame", () => {
        const guard = new FrameDifferenceGuard({ minimumDifferencePct: 30 });
        const decisions = [0, 1, 2, 3, 5, 7].map((n, index) => guard.consider({ id: String(index), image: pixels(n) }));
        expect(decisions.map((d) => d.kept)).toEqual([true, false, false, true, false, true]);
        expect(decisions.map((d) => d.comparedToId)).toEqual([null, "0", "0", "0", "3", "3"]);
        expect(decisions.map((d) => d.differencePct)).toEqual([null, 10, 20, 30, 20, 40]);
    });

    it("keeps identical frames when filtering is disabled at zero", () => {
        const guard = new FrameDifferenceGuard({ minimumDifferencePct: 0 });
        expect(guard.consider({ id: "a", image: pixels(0) }).kept).toBe(true);
        expect(guard.consider({ id: "b", image: pixels(0) }).kept).toBe(true);
    });

    it("at 100 keeps only wholly changed frames after the forced first", () => {
        const guard = new FrameDifferenceGuard({ minimumDifferencePct: 100 });
        expect([0, 9, 10].map((n) => guard.consider({ id: String(n), image: pixels(n) }).kept)).toEqual([
            true,
            false,
            true,
        ]);
    });

    it("does not let reuse of a decoder buffer mutate the kept baseline", () => {
        const guard = new FrameDifferenceGuard({ minimumDifferencePct: 30 });
        const reused = pixels(0);
        guard.consider({ id: "a", image: reused });
        reused.data.set(pixels(3).data);
        expect(guard.consider({ id: "b", image: reused }).differencePct).toBe(30);
    });

    it("summarizes kept frames into partial sheets without padding", () => {
        const decisions = Array.from({ length: 28 }, (_, index) => ({
            id: String(index),
            kept: index < 25,
            differencePct: 10,
            comparedToId: "first",
        }));
        expect(frameDifferenceSummary({ decisions, framesPerImage: 16 })).toEqual({
            candidates: 28,
            kept: 25,
            skipped: 3,
            images: 2,
            lastImageFrames: 9,
        });
        expect(frameDifferenceSummary({ decisions: [], framesPerImage: 4 })).toEqual({
            candidates: 0,
            kept: 0,
            skipped: 0,
            images: 0,
            lastImageFrames: 0,
        });
    });

    it("rejects invalid thresholds, layouts, and dimension changes", () => {
        for (const n of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => new FrameDifferenceGuard({ minimumDifferencePct: n })).toThrow();
        }

        expect(() => compareImagePixels({ a: pixels(0), b: pixels(0), sensitivity: 2 })).toThrow();
        expect(() => compareImagePixels({ a: pixels(0), b: { ...pixels(0), width: 5, height: 2 } })).toThrow();
        expect(() =>
            compareImagePixels({ a: pixels(0), b: { ...pixels(0), data: new Uint8ClampedArray(0) } })
        ).toThrow();
        expect(() => frameDifferenceSummary({ decisions: [], framesPerImage: 3 })).toThrow();
    });
});
