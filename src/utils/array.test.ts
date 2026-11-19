import { describe, expect, it } from "bun:test";
import { IntervalIndex, moveItem, wrapArray } from "./array";

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

describe("IntervalIndex", () => {
    it("finds the same overlaps as a full scan, with strict ends, in any insertion order", () => {
        const spans: Array<[number, number]> = [];
        let seed = 7;
        const next = () => {
            seed = (seed * 48271) % 2147483647;
            return seed / 2147483647;
        };
        const index = new IntervalIndex<number>();
        for (let i = 0; i < 300; i++) {
            const from = Math.floor(next() * 1000);
            const span: [number, number] = [from, from + 1 + Math.floor(next() * 40)];
            spans.push(span);
            index.add(span[0], span[1], i);
        }
        expect(index.size).toBe(300);
        for (let q = 0; q < 200; q++) {
            const from = Math.floor(next() * 1000);
            const to = from + Math.floor(next() * 30);
            const scan = spans.flatMap(([a, b], i) => (a < to && b > from ? [i] : [])).sort((a, b) => a - b);
            expect(index.overlapping(from, to).sort((a, b) => a - b)).toEqual(scan);
        }
        const edges = new IntervalIndex<string>();
        edges.add(10, 20, "middle");
        expect(edges.overlapping(20, 30)).toEqual([]);
        expect(edges.overlapping(0, 10)).toEqual([]);
        expect(edges.overlapping(19.5, 30)).toEqual(["middle"]);
    });
});
