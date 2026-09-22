import { describe, expect, test } from "bun:test";
import { InvalidArgumentError } from "commander";
import { numberArg } from "../commands/options";
import { resolveFormat, UsageError } from "./format";

describe("resolveFormat", () => {
    test("text when nothing is asked", () => {
        expect(resolveFormat({})).toBe("text");
    });

    test("a shorthand and the same --format agree", () => {
        expect(resolveFormat({ format: "json", json: true })).toBe("json");
        expect(resolveFormat({ jsonCompact: true })).toBe("json-compact");
    });

    test("two different formats are a usage error, not a silent pick", () => {
        // `--md --json` used to print JSON without a word.
        expect(() => resolveFormat({ md: true, json: true })).toThrow(UsageError);
        expect(() => resolveFormat({ format: "md", toon: true })).toThrow(/md and toon/);
    });

    test("an unknown --format is a usage error", () => {
        expect(() => resolveFormat({ format: "yaml" })).toThrow(UsageError);
    });
});

describe("numberArg", () => {
    const similarity = numberArg({ min: 0, max: 1 });
    const lines = numberArg({ min: 1, integer: true });

    test("accepts a value inside the rule", () => {
        expect(similarity("0.8")).toBe(0.8);
        expect(lines("3")).toBe(3);
    });

    test("refuses what used to pass silently", () => {
        // `--similarity 5` reported zero groups and `-1` grouped everything, both as an answer.
        expect(() => similarity("5")).toThrow(InvalidArgumentError);
        expect(() => similarity("-1")).toThrow(InvalidArgumentError);
        expect(() => lines("2.7")).toThrow(/whole number/);
        expect(() => lines("0")).toThrow(/at least 1/);
    });

    test("refuses what used to crash", () => {
        expect(() => lines("abc")).toThrow(InvalidArgumentError);
        expect(() => lines("")).toThrow(InvalidArgumentError);
    });
});
