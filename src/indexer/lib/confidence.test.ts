import { describe, expect, test } from "bun:test";
import { normalizeConfidence } from "./confidence";

describe("normalizeConfidence", () => {
    describe("cosine", () => {
        test("1.0 → 100", () => {
            expect(normalizeConfidence(1.0, "cosine")).toBe(100);
        });

        test("0.75 → 75", () => {
            expect(normalizeConfidence(0.75, "cosine")).toBe(75);
        });

        test("0 → 0", () => {
            expect(normalizeConfidence(0, "cosine")).toBe(0);
        });

        test("negative → 0", () => {
            expect(normalizeConfidence(-0.5, "cosine")).toBe(0);
        });
    });

    describe("rrf", () => {
        test("max theoretical (2/61) → 100", () => {
            expect(normalizeConfidence(2 / 61, "rrf")).toBe(100);
        });

        test("typical top result 0.016 → ~49", () => {
            const result = normalizeConfidence(0.016, "rrf");
            expect(result).toBeGreaterThanOrEqual(48);
            expect(result).toBeLessThanOrEqual(50);
        });

        test("0 → 0", () => {
            expect(normalizeConfidence(0, "rrf")).toBe(0);
        });
    });

    describe("bm25", () => {
        test("with maxScore 30: 30 → 100", () => {
            expect(normalizeConfidence(30, "bm25", 30)).toBe(100);
        });

        test("with maxScore 30: 15 → 50", () => {
            expect(normalizeConfidence(15, "bm25", 30)).toBe(50);
        });

        test("without maxScore: returns 0-100 range", () => {
            const low = normalizeConfidence(1, "bm25");
            const mid = normalizeConfidence(10, "bm25");
            const high = normalizeConfidence(25, "bm25");

            expect(low).toBeGreaterThanOrEqual(0);
            expect(low).toBeLessThanOrEqual(100);

            expect(mid).toBeGreaterThanOrEqual(0);
            expect(mid).toBeLessThanOrEqual(100);

            expect(high).toBeGreaterThanOrEqual(0);
            expect(high).toBeLessThanOrEqual(100);

            expect(low).toBeLessThan(mid);
            expect(mid).toBeLessThan(high);
        });
    });
});
