import { describe, expect, test } from "bun:test";
import { commandWords, parseNonNegativeInt } from "./parse";

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
