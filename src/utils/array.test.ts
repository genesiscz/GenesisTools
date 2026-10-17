import { describe, expect, it } from "bun:test";
import { moveItem, wrapArray } from "./array";

describe("wrapArray", () => {
    it("wraps a single value in an array", () => {
        expect(wrapArray("hello")).toEqual(["hello"]);
        expect(wrapArray(42)).toEqual([42]);
    });

    it("returns the same array if already an array", () => {
        const arr = [1, 2, 3];
        expect(wrapArray(arr)).toBe(arr);
    });

    it("returns empty array for null", () => {
        expect(wrapArray(null)).toEqual([]);
    });

    it("returns empty array for undefined", () => {
        expect(wrapArray(undefined)).toEqual([]);
    });
});

describe("moveItem", () => {
    it("moves in either direction without mutating a readonly input", () => {
        const input = Object.freeze(["a", "b", "c"]);
        expect(moveItem(input, 0, 2)).toEqual(["b", "c", "a"]);
        expect(moveItem(input, 2, 0)).toEqual(["c", "a", "b"]);
        expect(input).toEqual(["a", "b", "c"]);
    });

    it("returns a copy for empty, unchanged and invalid moves", () => {
        const input = ["a", "b"];
        for (const [from, to] of [
            [0, 0],
            [-1, 0],
            [2, 0],
            [0, 2],
            [NaN, 0],
            [0, Infinity],
            [0.5, 1],
        ]) {
            const moved = moveItem(input, from, to);
            expect(moved).toEqual(input);
            expect(moved).not.toBe(input);
        }
        expect(moveItem([], 0, 0)).toEqual([]);
    });
});
