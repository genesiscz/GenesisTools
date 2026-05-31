import { describe, expect, it } from "bun:test";
import { countTokens, estimateTokens, limitToTokens } from "./tokens";

describe("estimateTokens", () => {
    it("estimates ~4 chars per token", () => {
        expect(estimateTokens("abcd")).toBe(1);
        expect(estimateTokens("abcdefgh")).toBe(2);
    });

    it("returns 0 for empty string", () => {
        expect(estimateTokens("")).toBe(0);
    });

    it("rounds up", () => {
        expect(estimateTokens("abc")).toBe(1);
        expect(estimateTokens("abcde")).toBe(2);
    });
});

describe("countTokens", () => {
    it("counts tokens for text", () => {
        const count = countTokens("hello world");
        expect(count).toBeGreaterThan(0);
    });

    it("returns 0 for empty string", () => {
        expect(countTokens("")).toBe(0);
    });

    it("handles whitespace-only strings", () => {
        // gpt-3-encoder encodes spaces as tokens, so this should be > 0
        expect(countTokens("   ")).toBeGreaterThan(0);
    });
});

describe("limitToTokens", () => {
    it("returns original text when no limit", () => {
        const result = limitToTokens("hello world");
        expect(result.text).toBe("hello world");
        expect(result.truncated).toBe(false);
    });

    it("returns original text when within limit", () => {
        const result = limitToTokens("hi", 1000);
        expect(result.text).toBe("hi");
        expect(result.truncated).toBe(false);
    });

    it("truncates when exceeding limit", () => {
        const longText = "word ".repeat(1000);
        const result = limitToTokens(longText, 10);
        expect(result.truncated).toBe(true);
        expect(result.tokens).toBe(10);
        expect(result.text.length).toBeLessThan(longText.length);
    });
});
