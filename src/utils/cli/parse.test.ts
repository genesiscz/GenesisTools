import { describe, expect, test } from "bun:test";
import { parseNonNegativeInt } from "./parse";

describe("parseNonNegativeInt", () => {
    test("parses a valid non-negative integer", () => {
        expect(parseNonNegativeInt("42", "--count")).toBe(42);
    });

    test("parses zero", () => {
        expect(parseNonNegativeInt("0", "--count")).toBe(0);
    });

    test("throws on empty string", () => {
        expect(() => parseNonNegativeInt("", "--count")).toThrow('--count must be a non-negative integer, got ""');
    });

    test("throws on negative numbers", () => {
        expect(() => parseNonNegativeInt("-1", "--count")).toThrow('--count must be a non-negative integer, got "-1"');
    });

    test("throws on non-numeric strings", () => {
        expect(() => parseNonNegativeInt("abc", "--count")).toThrow(
            '--count must be a non-negative integer, got "abc"'
        );
    });

    test("throws on decimals", () => {
        expect(() => parseNonNegativeInt("1.5", "--count")).toThrow(
            '--count must be a non-negative integer, got "1.5"'
        );
    });
});
