import { describe, expect, it } from "bun:test";
import { formatLogLineIndex } from "./log-line-index";

describe("formatLogLineIndex", () => {
    it("formats index as hash-prefixed number", () => {
        expect(formatLogLineIndex(42)).toBe("#42");
    });
});
