import { describe, expect, it } from "bun:test";
import { cosineDistance } from "./math";

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
