import { describe, expect, it } from "bun:test";
import { parseJSON, SafeJSON } from "./json";

describe("SafeJSON", () => {
    it("parses standard JSON", () => {
        expect(SafeJSON.parse('{"a":1}') as Record<string, number>).toEqual({ a: 1 });
    });

    it("parses // comments, /* */ comments, trailing commas", () => {
        expect(SafeJSON.parse('{ /* comment */ "a": 1, }') as Record<string, number>).toEqual({ a: 1 });
        expect(SafeJSON.parse('{ "a": 1, // trailing\n }') as Record<string, number>).toEqual({ a: 1 });
    });

    it("stringify produces standard JSON (quoted keys)", () => {
        expect(SafeJSON.stringify({ a: 1 })).toBe('{"a":1}');
    });

    it("preserves comments through stringify", () => {
        const input = '{\n  // greeting\n  "name": "world"\n}';
        const obj = SafeJSON.parse(input);
        (obj as Record<string, string>).name = "updated";
        const output = SafeJSON.stringify(obj, null, 2);
        expect(output).toContain("// greeting");
        expect(output).toContain('"updated"');
    });

    it("supports replacer in stringify", () => {
        expect(SafeJSON.stringify({ a: 1 }, ["a"])).toBe('{"a":1}');
    });

    it("uses native JSON.parse with { jsonl: true }", () => {
        const result = SafeJSON.parse('{"a":1}', { jsonl: true });
        expect(result).toEqual({ a: 1 });
    });

    it("rejects comments with { jsonl: true }", () => {
        expect(() => SafeJSON.parse('{ /* comment */ "a": 1 }', { jsonl: true })).toThrow();
    });

    it("strict mode uses native JSON.parse (same as jsonl)", () => {
        expect(SafeJSON.parse('{"a":1}', { strict: true })).toEqual({ a: 1 });
        expect(() => SafeJSON.parse("{ /* comment */ }", { strict: true })).toThrow();
    });

    it("uses native JSON.stringify with { jsonl: true }", () => {
        const result = SafeJSON.stringify({ a: 1 }, { jsonl: true });
        expect(result).toBe('{"a":1}');
    });

    it("uses native JSON.stringify with { strict: true }", () => {
        const result = SafeJSON.stringify({ a: 1 }, { strict: true });
        expect(result).toBe('{"a":1}');
    });

    it("supports reviver with { jsonl: false }", () => {
        const result = SafeJSON.parse('{"a":"1"}', {
            jsonl: false,
            reviver: (_key, value) => (typeof value === "string" ? Number.parseInt(value, 10) : value),
        });
        expect(result).toEqual({ a: 1 });
    });
});

describe("parseJSON", () => {
    it("parses valid JSON", () => {
        expect(parseJSON<Record<string, number>>('{"a":1}')).toEqual({ a: 1 });
        expect(parseJSON<number>("123")).toBe(123);
        expect(parseJSON<string>('"hello"')).toBe("hello");
    });

    it("parses JSONC (comments, trailing commas)", () => {
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
