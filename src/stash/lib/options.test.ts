import { describe, expect, test } from "bun:test";
import { InvalidArgumentError } from "commander";
import { parsePositiveInt, pickExclusive } from "./options";

describe("pickExclusive", () => {
    test("returns undefined when no flag set", () => {
        expect(pickExclusive({}, ["a", "b"])).toBeUndefined();
    });
    test("returns the single set flag", () => {
        expect(pickExclusive({ a: true }, ["a", "b"])).toBe("a");
        expect(pickExclusive({ b: 1 }, ["a", "b"])).toBe("b");
    });
    test("throws on conflicting flags", () => {
        expect(() => pickExclusive({ a: true, b: true }, ["a", "b"])).toThrow(InvalidArgumentError);
    });
});

describe("parsePositiveInt", () => {
    test("returns the int", () => {
        expect(parsePositiveInt("3")).toBe(3);
    });
    test("rejects NaN", () => {
        expect(() => parsePositiveInt("abc")).toThrow(InvalidArgumentError);
    });
    test("rejects 0 and negatives", () => {
        expect(() => parsePositiveInt("0")).toThrow(InvalidArgumentError);
        expect(() => parsePositiveInt("-1")).toThrow(InvalidArgumentError);
    });
    test("rejects empty string", () => {
        expect(() => parsePositiveInt("")).toThrow(InvalidArgumentError);
    });
    test("rejects floats", () => {
        expect(() => parsePositiveInt("1.5")).toThrow(InvalidArgumentError);
    });
    test("rejects non-decimal forms (hex / scientific / binary)", () => {
        // PR #222 t30: previous `Number()` impl silently accepted these.
        expect(() => parsePositiveInt("0x10")).toThrow(InvalidArgumentError);
        expect(() => parsePositiveInt("1e2")).toThrow(InvalidArgumentError);
        expect(() => parsePositiveInt("0b11")).toThrow(InvalidArgumentError);
    });
    test("rejects signed forms", () => {
        expect(() => parsePositiveInt("+1")).toThrow(InvalidArgumentError);
        expect(() => parsePositiveInt(" 1")).not.toThrow(); // trimmed first
    });
    test("rejects leading zero (no octal-by-accident)", () => {
        expect(() => parsePositiveInt("01")).toThrow(InvalidArgumentError);
    });
});
