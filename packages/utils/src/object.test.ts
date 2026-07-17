import { describe, expect, it } from "bun:test";
import { deepMerge, isObject } from "./object";

describe("isObject", () => {
    it("returns true for plain objects", () => {
        expect(isObject({})).toBe(true);
        expect(isObject({ a: 1 })).toBe(true);
    });

    it("returns false for null", () => {
        expect(isObject(null)).toBe(false);
    });

    it("returns false for arrays", () => {
        expect(isObject([])).toBe(false);
        expect(isObject([1, 2])).toBe(false);
    });

    it("returns false for primitives", () => {
        expect(isObject("string")).toBe(false);
        expect(isObject(42)).toBe(false);
        expect(isObject(true)).toBe(false);
        expect(isObject(undefined)).toBe(false);
    });

    it("returns true for Date (non-null, non-array object)", () => {
        expect(isObject(new Date())).toBe(true);
    });
});

describe("deepMerge", () => {
    it("merges flat objects", () => {
        const result = deepMerge({ a: 1 } as Record<string, unknown>, { b: 2 });
        expect(result).toEqual({ a: 1, b: 2 });
    });

    it("overrides values in target", () => {
        expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
    });

    it("deep merges nested objects", () => {
        const result = deepMerge({ nested: { a: 1, b: 2 } } as Record<string, unknown>, { nested: { b: 3, c: 4 } });
        expect(result).toEqual({ nested: { a: 1, b: 3, c: 4 } });
    });

    it("overwrites arrays (no array merging)", () => {
        expect(deepMerge({ arr: [1, 2] }, { arr: [3, 4] })).toEqual({ arr: [3, 4] });
    });

    it("skips undefined values in source", () => {
        expect(deepMerge({ a: 1, b: 2 }, { a: undefined, b: 3 })).toEqual({ a: 1, b: 3 });
    });

    it("does not mutate the original target", () => {
        const target: Record<string, unknown> = { a: 1 };
        const result = deepMerge(target, { b: 2 });
        expect(target).toEqual({ a: 1 });
        expect(result).toEqual({ a: 1, b: 2 });
    });
});
