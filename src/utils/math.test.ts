import { describe, expect, it } from "bun:test";
import { cosineDistance, IntervalIndex, median } from "./math";

describe("cosineDistance", () => {
    it("returns 0 for identical vectors", () => {
        const a = new Float32Array([1, 2, 3]);
        const b = new Float32Array([1, 2, 3]);
        expect(cosineDistance(a, b)).toBeCloseTo(0, 5);
    });

    it("returns ~1 for orthogonal vectors", () => {
        const a = new Float32Array([1, 0]);
        const b = new Float32Array([0, 1]);
        expect(cosineDistance(a, b)).toBeCloseTo(1, 5);
    });

    it("returns ~2 for opposite vectors", () => {
        const a = new Float32Array([1, 0]);
        const b = new Float32Array([-1, 0]);
        expect(cosineDistance(a, b)).toBeCloseTo(2, 5);
    });

    it("returns 2 for zero vectors", () => {
        const a = new Float32Array([0, 0, 0]);
        const b = new Float32Array([0, 0, 0]);
        expect(cosineDistance(a, b)).toBe(2);
    });

    it("handles scaled versions of same vector", () => {
        const a = new Float32Array([1, 2, 3]);
        const b = new Float32Array([2, 4, 6]);
        expect(cosineDistance(a, b)).toBeCloseTo(0, 5);
    });
});

describe("median", () => {
    it("takes the middle value of an odd count and the mean of the two middle values of an even count", () => {
        expect(median([9, 1, 5])).toBe(5);
        expect(median([9, 1])).toBe(5);
        expect(median([])).toBeUndefined();
    });
});

describe("IntervalIndex", () => {
    const spans = [
        { name: "long", from: 0, to: 100 },
        { name: "early", from: 1, to: 3 },
        { name: "late", from: 50, to: 60 },
        { name: "same start", from: 50, to: 55 },
        { name: "point", from: 70, to: 70 },
    ];
    const index = new IntervalIndex(spans, (span) => ({ from: span.from, to: span.to }));
    const names = (rows: typeof spans) => rows.map((row) => row.name);

    it("answers the same intervals as a linear scan, in input order", () => {
        for (const point of [-1, 0, 2, 3, 4, 50, 55, 56, 70, 100, 101]) {
            expect(names(index.containing(point))).toEqual(
                names(spans.filter((span) => span.from <= point && point <= span.to))
            );
        }
    });

    it("finds open overlaps with a range", () => {
        for (const [from, to] of [
            [3, 50],
            [55, 70],
            [100, 120],
            [60, 60.5],
        ] as const) {
            expect(names(index.overlapping(from, to))).toEqual(
                names(spans.filter((span) => span.from < to && span.to > from))
            );
        }
    });

    it("handles an empty list", () => {
        expect(new IntervalIndex([], () => ({ from: 0, to: 1 })).containing(0)).toEqual([]);
    });
});
