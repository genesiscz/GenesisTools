import { expect, test } from "bun:test";
import { calculateHistoryRelevance } from "./search-rank";

test("preserves weighted relevance math with an injected clock", () => {
    const score = calculateHistoryRelevance({
        query: "alpha beta",
        customTitle: "Alpha Beta topic",
        summary: "ignored fallback",
        firstUserMessage: "Please inspect alpha beta",
        allText: `${"alpha ".repeat(12)}beta beta`,
        timestamp: new Date("2026-01-04T12:00:00.000Z"),
        now: new Date("2026-01-08T00:00:00.000Z"),
    });

    expect(score).toBe(172);
});

test("preserves word weights and future-date recency edge cases", () => {
    expect(
        calculateHistoryRelevance({
            query: "alpha beta",
            customTitle: "beta middle alpha",
            firstUserMessage: "beta middle alpha",
            allText: "",
            timestamp: new Date("2025-12-31T00:00:00.000Z"),
            now: new Date("2026-01-08T00:00:00.000Z"),
        })
    ).toBe(50);
    expect(
        calculateHistoryRelevance({
            query: "x",
            allText: "",
            timestamp: new Date("2026-01-09T00:00:00.000Z"),
            now: new Date("2026-01-08T00:00:00.000Z"),
        })
    ).toBe(23);
    expect(
        calculateHistoryRelevance({
            query: "",
            allText: "x",
            timestamp: new Date("2026-01-08T00:00:00.000Z"),
            now: new Date("2026-01-08T00:00:00.000Z"),
        })
    ).toBe(0);
});
