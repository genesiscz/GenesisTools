import { describe, it, expect } from "bun:test";
import { wrapArray } from "./array";

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
