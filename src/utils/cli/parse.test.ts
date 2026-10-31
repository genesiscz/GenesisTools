import { describe, expect, test } from "bun:test";
import { commandWords, parseNonNegativeInt, parseNonNegativeNumber } from "./parse";

describe("parseNonNegativeNumber", () => {
    test("parses zero and decimals", () => {
        expect(parseNonNegativeNumber("0", "--threshold")).toBe(0);
        expect(parseNonNegativeNumber("0.25", "--threshold")).toBe(0.25);
    });

    test("accepts the max itself", () => {
        expect(parseNonNegativeNumber("1", "--threshold", { max: 1 })).toBe(1);
    });

    test("rejects a negative number, a non-number, infinity and a value over max", () => {
        expect(() => parseNonNegativeNumber("-1", "--min-area")).toThrow(
            '--min-area must be a number from 0, got "-1"'
        );
        expect(() => parseNonNegativeNumber("abc", "--min-area")).toThrow('got "abc"');
        expect(() => parseNonNegativeNumber("Infinity", "--min-area")).toThrow('got "Infinity"');
        expect(() => parseNonNegativeNumber("2", "--threshold", { max: 1 })).toThrow(
            '--threshold must be a number from 0 to 1, got "2"'
        );
    });
});

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

describe("commandWords", () => {
    test("splits on whitespace and keeps a quoted part as one word, without expansion", () => {
        expect(commandWords("tools artifact serve")).toEqual(["tools", "artifact", "serve"]);
        expect(commandWords(`tools say "two words" 'it''s' $HOME`)).toEqual([
            "tools",
            "say",
            "two words",
            "its",
            "$HOME",
        ]);
        expect(commandWords(`  a   ""  b  `)).toEqual(["a", "", "b"]);
    });

    test("an unclosed quote is an error, not shifted words", () => {
        expect(() => commandWords(`tools say "open`)).toThrow("unclosed");
    });
});
