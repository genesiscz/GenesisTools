import { describe, it, expect } from "bun:test";
import {
    levenshteinDistance, similarityScore, timeOverlapRatio,
    wordSimilarity, fuzzyMatchBest,
} from "./fuzzy-match";

describe("levenshteinDistance", () => {
    it("returns 0 for identical strings", () => {
        expect(levenshteinDistance("hello", "hello")).toBe(0);
    });

    it("is case insensitive", () => {
        expect(levenshteinDistance("Hello", "hello")).toBe(0);
    });

    it("returns length of other string when one is empty", () => {
        expect(levenshteinDistance("", "hello")).toBe(5);
        expect(levenshteinDistance("hello", "")).toBe(5);
    });

    it("returns correct distance for single char diff", () => {
        expect(levenshteinDistance("cat", "car")).toBe(1);
        expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    });

    it("handles both empty strings", () => {
        expect(levenshteinDistance("", "")).toBe(0);
    });
});

describe("similarityScore", () => {
    it("returns 1 for identical strings", () => {
        expect(similarityScore("hello", "hello")).toBe(1);
    });

    it("returns 1 for both empty strings", () => {
        expect(similarityScore("", "")).toBe(1);
    });

    it("returns 0 for completely different single-char strings", () => {
        expect(similarityScore("a", "b")).toBe(0);
    });

    it("returns value between 0 and 1 for partial matches", () => {
        const score = similarityScore("hello", "hallo");
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThan(1);
    });
});

describe("timeOverlapRatio", () => {
    it("returns 1 for full overlap (source within target)", () => {
        expect(timeOverlapRatio({ from: "10:00", to: "11:00" }, { from: "09:00", to: "12:00" })).toBe(1);
    });

    it("returns partial overlap ratio", () => {
        expect(timeOverlapRatio({ from: "10:00", to: "12:00" }, { from: "11:00", to: "13:00" })).toBeCloseTo(0.5, 5);
    });

    it("returns 0 for no overlap", () => {
        expect(timeOverlapRatio({ from: "10:00", to: "11:00" }, { from: "12:00", to: "13:00" })).toBe(0);
    });

    it("returns 0 when times are null", () => {
        expect(timeOverlapRatio({ from: null, to: "11:00" }, { from: "10:00", to: "12:00" })).toBe(0);
    });

    it("returns 0 for zero-duration source", () => {
        expect(timeOverlapRatio({ from: "10:00", to: "10:00" }, { from: "09:00", to: "12:00" })).toBe(0);
    });

    it("parses ISO datetime format", () => {
        expect(timeOverlapRatio(
            { from: "2026-02-24T10:00:00Z", to: "2026-02-24T11:00:00Z" },
            { from: "2026-02-24T09:00:00Z", to: "2026-02-24T12:00:00Z" },
        )).toBe(1);
    });
});

describe("wordSimilarity", () => {
    it("returns 1 for identical multi-word text", () => {
        expect(wordSimilarity("hello world test", "hello world test")).toBe(1);
    });

    it("returns 0 when no words overlap", () => {
        expect(wordSimilarity("alpha bravo charlie", "delta echo foxtrot")).toBe(0);
    });

    it("returns partial score for some overlap", () => {
        const score = wordSimilarity("hello world", "hello there");
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThan(1);
    });

    it("filters out short words (<=2 chars)", () => {
        expect(wordSimilarity("a b c", "a b c")).toBe(0);
    });
});

describe("fuzzyMatchBest", () => {
    it("returns best matching candidate", () => {
        const result = fuzzyMatchBest(
            { text: "project meeting", from: "10:00", to: "11:00" },
            [
                { id: 1, text: "project meeting notes", from: "10:00", to: "11:00" },
                { id: 2, text: "lunch break", from: "12:00", to: "13:00" },
            ],
        );
        expect(result).not.toBeNull();
        expect(result!.targetId).toBe(1);
    });

    it("returns null when below threshold", () => {
        const result = fuzzyMatchBest(
            { text: "completely different", from: "10:00", to: "11:00" },
            [{ id: 1, text: "unrelated topic", from: "14:00", to: "15:00" }],
            0.9,
        );
        expect(result).toBeNull();
    });

    it("returns null for empty candidates", () => {
        expect(fuzzyMatchBest({ text: "test", from: "10:00", to: "11:00" }, [])).toBeNull();
    });
});
