import { describe, expect, it } from "bun:test";
import { formatChunkDisplayName, stripPartSuffixes } from "./display-name";

describe("stripPartSuffixes", () => {
    it("strips single part suffix", () => {
        expect(stripPartSuffixes("MyClass (part 2)")).toBe("MyClass");
    });

    it("strips stacked part suffixes", () => {
        expect(stripPartSuffixes("MyClass (part 3) (part 8)")).toBe("MyClass");
    });

    it("leaves names without suffixes unchanged", () => {
        expect(stripPartSuffixes("MyClass")).toBe("MyClass");
    });
});

describe("formatChunkDisplayName", () => {
    it("shows name:lines for named chunk", () => {
        expect(formatChunkDisplayName("MyClass", 10, 45)).toBe("MyClass:10-45");
    });

    it("strips stacked part suffixes", () => {
        expect(formatChunkDisplayName("MyClass (part 3) (part 8)", 100, 150)).toBe("MyClass:100-150");
    });

    it("strips single part suffix", () => {
        expect(formatChunkDisplayName("MyClass (part 2)", 50, 80)).toBe("MyClass:50-80");
    });

    it("falls back to kind:lines when no name", () => {
        expect(formatChunkDisplayName(undefined, 1, 30, "function")).toBe("function:1-30");
    });

    it("falls back to just lines when no name or kind", () => {
        expect(formatChunkDisplayName(undefined, 1, 30)).toBe("L1-30");
    });

    it("handles single-line chunk", () => {
        expect(formatChunkDisplayName("handler", 42, 42)).toBe("handler:42");
    });
});
