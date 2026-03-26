import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@app/utils/string";
import { createColors } from "picocolors";
import { highlightQueryWords, parseQueryWords } from "./highlight";

const colorsOn = createColors(true);
const colorsOff = createColors(false);

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
        expect(result).not.toContain("ai");
    });
});

describe("highlightQueryWords", () => {
    describe("with colors", () => {
        it("wraps matching words with ANSI codes", () => {
            const result = highlightQueryWords("Send telegram notification", ["telegram", "notification"], colorsOn);
            const plain = stripAnsi(result);
            expect(plain).toBe("Send telegram notification");
            expect(result.length).toBeGreaterThan(plain.length);
        });

        it("is case-insensitive", () => {
            const result = highlightQueryWords("Telegram TELEGRAM telegram", ["telegram"], colorsOn);
            const plain = stripAnsi(result);
            expect(plain).toBe("Telegram TELEGRAM telegram");
            // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape code matching
            const matches = result.match(/\x1b\[/g);
            expect(matches!.length).toBeGreaterThanOrEqual(3);
        });

        it("prefers longer matches over shorter overlapping ones", () => {
            const result = highlightQueryWords("mapped map mapper", ["map", "mapped"], colorsOn);
            const plain = stripAnsi(result);
            expect(plain).toBe("mapped map mapper");
            // "mapped" should be highlighted as a whole, not just the "map" prefix
            expect(result).toContain(colorsOn.bold(colorsOn.yellow("mapped")));
            expect(result).toContain(colorsOn.bold(colorsOn.yellow("map")));
        });
    });

    describe("without colors", () => {
        it("returns text unchanged when colors are disabled", () => {
            const result = highlightQueryWords("Send telegram notification", ["telegram", "notification"], colorsOff);
            expect(result).toBe("Send telegram notification");
        });

        it("is case-insensitive even without colors", () => {
            const result = highlightQueryWords("Telegram TELEGRAM telegram", ["telegram"], colorsOff);
            expect(result).toBe("Telegram TELEGRAM telegram");
        });
    });

    it("handles no matches gracefully", () => {
        const result = highlightQueryWords("no match here", ["xyz"]);
        expect(result).toBe("no match here");
    });

    it("handles special regex chars in query", () => {
        const result = highlightQueryWords("cost is $100 (total)", ["$100", "(total)"], colorsOff);
        expect(result).toBe("cost is $100 (total)");
    });

    it("returns empty string for empty input", () => {
        expect(highlightQueryWords("", ["test"])).toBe("");
    });
});
