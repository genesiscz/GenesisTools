import { describe, expect, test } from "bun:test";
import { DEFAULT_FILTERS, grainForMinutes, parseFilters, resolveRange } from "./ai-accounts-filters";

const NOW = new Date("2026-09-04T17:40:00").getTime();

describe("resolveRange", () => {
    test("a preset counts back from now", () => {
        const r = resolveRange({ preset: "24h" }, NOW);

        expect(r.toMs).toBe(NOW);
        expect(r.fromMs).toBe(NOW - 1440 * 60_000);
        expect(r.minutes).toBe(1440);
        expect(r.label.startsWith("last 24h, ")).toBe(true);
    });

    test("custom bounds are honoured and clamped to now", () => {
        const from = new Date("2026-09-01T00:00:00").toISOString();
        const to = new Date("2026-12-01T00:00:00").toISOString();
        const r = resolveRange({ preset: "custom", from, to }, NOW);

        expect(r.toMs).toBe(NOW);
        expect(r.fromMs).toBe(new Date(from).getTime());
    });

    test("a custom range with junk falls back to seven days ending now", () => {
        const r = resolveRange({ preset: "custom", from: "nope", to: "nope" }, NOW);

        expect(r.toMs).toBe(NOW);
        expect(r.minutes).toBe(7 * 1440);
    });

    test("a custom from after to falls back instead of producing a negative window", () => {
        const from = new Date("2026-09-03T00:00:00").toISOString();
        const to = new Date("2026-09-02T00:00:00").toISOString();
        const r = resolveRange({ preset: "custom", from, to }, NOW);

        expect(r.fromMs).toBeLessThan(r.toMs);
    });
});

describe("parseFilters", () => {
    test("accepts a stored value and rejects junk", () => {
        expect(parseFilters(DEFAULT_FILTERS)).toEqual(DEFAULT_FILTERS);
        expect(parseFilters({ providers: "x" })).toBeNull();
        expect(parseFilters({ providers: [], accountIds: [], range: { preset: "never" } })).toBeNull();
        expect(parseFilters(null)).toBeNull();
    });
});

describe("grainForMinutes", () => {
    test("picks a grain that keeps the point count readable", () => {
        expect(grainForMinutes(60)).toBe("minute");
        expect(grainForMinutes(1440)).toBe("hour");
        expect(grainForMinutes(10080)).toBe("day");
        expect(grainForMinutes(365 * 1440)).toBe("week");
    });
});
