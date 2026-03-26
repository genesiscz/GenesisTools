import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@app/utils/string";
import pc from "picocolors";
import { highlightQueryWords, parseQueryWords } from "./highlight";

const hasColors = pc.isColorSupported;

describe("parseQueryWords", () => {
    it("splits query into lowercase words", () => {
        expect(parseQueryWords("Telegram bot Notification")).toEqual(["telegram", "bot", "notification"]);
    });

    it("deduplicates words", () => {
        expect(parseQueryWords("test test Test")).toEqual(["test"]);
    });

    it("filters short words (<=2 chars)", () => {
        const result = parseQueryWords("how is the AI working");
        expect(result).toContain("how");
        expect(result).toContain("the");
        expect(result).toContain("working");
        expect(result).not.toContain("is");
        expect(result).not.toContain("AI");
    });
});

describe("highlightQueryWords", () => {
    it("highlights matching words in text", () => {
        const result = highlightQueryWords("Send telegram notification", ["telegram", "notification"]);
        const plain = stripAnsi(result);
        expect(plain).toBe("Send telegram notification");

        if (hasColors) {
            expect(result.length).toBeGreaterThan(plain.length);
        }
    });

    it("is case-insensitive", () => {
        const result = highlightQueryWords("Telegram TELEGRAM telegram", ["telegram"]);
        const plain = stripAnsi(result);
        expect(plain).toBe("Telegram TELEGRAM telegram");

        if (hasColors) {
            // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape code matching
            const matches = result.match(/\x1b\[/g);
            expect(matches!.length).toBeGreaterThanOrEqual(3);
        }
    });

    it("handles no matches gracefully", () => {
        const result = highlightQueryWords("no match here", ["xyz"]);
        expect(result).toBe("no match here");
    });

    it("handles special regex chars in query", () => {
        const result = highlightQueryWords("cost is $100 (total)", ["$100", "(total)"]);
        const plain = stripAnsi(result);
        expect(plain).toBe("cost is $100 (total)");
    });

    it("returns empty string for empty input", () => {
        expect(highlightQueryWords("", ["test"])).toBe("");
    });
});
