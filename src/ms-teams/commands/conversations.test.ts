import { describe, expect, test } from "bun:test";
import { parsePositiveLimit } from "./conversations";

describe("parsePositiveLimit", () => {
    test("accepts a whole decimal integer", () => {
        expect(parsePositiveLimit("40", 10)).toBe(40);
        expect(parsePositiveLimit(undefined, 10)).toBe(10);
    });

    test("rejects prefixes and fractions", () => {
        expect(() => parsePositiveLimit("12junk", 10)).toThrow(/positive integer/);
        expect(() => parsePositiveLimit("1.5", 10)).toThrow(/positive integer/);
        expect(() => parsePositiveLimit("1e3", 10)).toThrow(/positive integer/);
    });
});
