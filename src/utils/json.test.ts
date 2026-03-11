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

    describe("parse options", () => {
        it("throws on invalid JSON when failfast=true (default)", () => {
            expect(() => SafeJSON.parse("invalid json")).toThrow();
            expect(() => SafeJSON.parse("invalid json", { failfast: true })).toThrow();
        });

        it("returns undefined on invalid JSON when failfast=false", () => {
            expect(SafeJSON.parse("invalid json", { failfast: false })).toBeUndefined();
            expect(SafeJSON.parse("{broken}", { failfast: false })).toBeUndefined();
        });

        it("supports reviver in options", () => {
            const reviver = (key: string, value: unknown) => {
                if (key === "a") return (value as number) * 2;
                return value;
            };
            const result = SafeJSON.parse('{"a":5,"b":10}', { reviver }) as Record<string, number>;
            expect(result.a).toBe(10);
            expect(result.b).toBe(10);
        });

        it("supports legacy reviver as second argument", () => {
            const reviver = (key: string, value: unknown) => {
                if (key === "a") return (value as number) * 3;
                return value;
            };
            const result = SafeJSON.parse('{"a":2}', reviver) as Record<string, number>;
            expect(result.a).toBe(6);
        });
    });

    describe("stringify options", () => {
        it("supports space option for pretty-printing", () => {
            const result = SafeJSON.stringify({ a: 1, b: 2 }, { space: 2 });
            expect(result).toContain("\n");
            expect(result).toContain("  ");
        });

        it("supports replacer in options", () => {
            const result = SafeJSON.stringify({ a: 1, b: 2 }, { replacer: ["a"] });
            expect(result).toBe('{"a":1}');
        });

        it("supports both replacer and space in options", () => {
            const result = SafeJSON.stringify({ a: 1, b: 2 }, { replacer: ["b"], space: 2 });
            expect(result).toContain('"b"');
            expect(result).not.toContain('"a"');
            expect(result).toContain("\n");
        });

        it("supports legacy replacer and space as separate arguments", () => {
            const result = SafeJSON.stringify({ a: 1 }, ["a"], 2);
            expect(result).toContain("\n");
            expect(result).toContain('"a"');
        });
    });
});

describe("parseJSON", () => {
    it("parses valid JSON", () => {
        expect(parseJSON<Record<string, number>>('{"a":1}')).toEqual({ a: 1 });
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