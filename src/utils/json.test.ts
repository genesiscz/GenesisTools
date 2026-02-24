import { describe, it, expect } from "bun:test";
import { parseJSON } from "./json";

describe("parseJSON", () => {
    it("parses valid JSON", () => {
        expect(parseJSON<Record<string, number>>('{"a":1}')).toEqual({ a: 1 });
        expect(parseJSON<number>("123")).toBe(123);
        expect(parseJSON<string>('"hello"')).toBe("hello");
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
