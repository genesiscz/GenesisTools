import { describe, expect, it } from "bun:test";
import { parseJSON, SafeJSON } from "./json";

describe("SafeJSON", () => {
    it("parses standard JSON", () => {
        expect(SafeJSON.parse('{"a":1}')).toEqual({ a: 1 });
        expect(SafeJSON.parse("123")).toBe(123);
    });

    it("parses // comments, /* */ comments, trailing commas, unquoted keys", () => {
        expect(SafeJSON.parse('{ /* comment */ "a": 1, }')).toEqual({ a: 1 });
        expect(SafeJSON.parse("{ a: 1 }")).toEqual({ a: 1 });
        expect(SafeJSON.parse('{ "a": 1, // trailing\n }')).toEqual({ a: 1 });
    });

    it("stringify produces valid output", () => {
        expect(SafeJSON.stringify({ a: 1 })).toBe('{"a":1}');
    });

    it("supports reviver and replacer", () => {
        const reviver = (_key: string, val: unknown) => (typeof val === "number" ? val * 2 : val);
        expect(SafeJSON.parse('{"a":1}', reviver)).toEqual({ a: 2 });
        expect(SafeJSON.stringify({ a: 1 }, ["a"])).toBe('{"a":1}');
    });
});

describe("parseJSON", () => {
    it("parses valid JSON", () => {
        expect(parseJSON<Record<string, number>>('{"a":1}')).toEqual({ a: 1 });
        expect(parseJSON<number>("123")).toBe(123);
        expect(parseJSON<string>('"hello"')).toBe("hello");
    });

    it("parses JSON5 (comments, trailing commas)", () => {
        expect(parseJSON<Record<string, number>>('{ /* c */ "a": 1 }')).toEqual({ a: 1 });
    });

    it("returns null for invalid JSON", () => {
        expect(parseJSON("not json")).toBeNull();
        expect(parseJSON("{invalid}")).toBeNull();
    });

    it("returns fallback for invalid JSON when provided", () => {
        expect(parseJSON("not json", { default: true })).toEqual({ default: true });
    });

    it("returns parsed value even when fallback is provided", () => {
        const result = parseJSON<Record<string, number>>('{"a":1}', { b: 2 });
        expect(result).toEqual({ a: 1 });
    });
});
