import { describe, expect, test } from "bun:test";
import {
    DEFAULT_FILTERS,
    grainForMinutes,
    parseFilters,
    resolveRange,
    resolveStableRange,
    windowStepMs,
} from "./ai-accounts-filters";

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

/** Buckets are absolute, so a test that starts mid-bucket would cross a boundary by accident. */
function alignedTo(stepMs: number): number {
    return Math.floor(NOW / stepMs) * stepMs;
}

describe("resolveStableRange", () => {
    test("a 7d window is identical across a minute of ticks, so the query key holds", () => {
        const base = alignedTo(900_000);
        const first = resolveStableRange({ preset: "7d" }, base);
        const later = resolveStableRange({ preset: "7d" }, base + 59_000);

        expect(later.toMs).toBe(first.toMs);
        expect(later.fromMs).toBe(first.fromMs);
    });

    test("an hour window holds for a minute, then advances by exactly one minute", () => {
        const base = alignedTo(60_000);
        const first = resolveStableRange({ preset: "1h" }, base);

        expect(resolveStableRange({ preset: "1h" }, base + 59_000).toMs).toBe(first.toMs);
        expect(resolveStableRange({ preset: "1h" }, base + 61_000).toMs).toBe(first.toMs + 60_000);
    });

    test("a 30d window advances four times an hour, not once a render", () => {
        const base = alignedTo(900_000);
        const first = resolveStableRange({ preset: "30d" }, base);

        expect(resolveStableRange({ preset: "30d" }, base + 14 * 60_000).toMs).toBe(first.toMs);
        expect(resolveStableRange({ preset: "30d" }, base + 16 * 60_000).toMs).toBe(first.toMs + 900_000);
    });

    test("the end is snapped down, so a window never reaches into the future", () => {
        for (const preset of ["1h", "24h", "30d"] as const) {
            expect(resolveStableRange({ preset }, NOW).toMs).toBeLessThanOrEqual(NOW);
        }
    });

    test("the span is preserved exactly, only the end is snapped", () => {
        const r = resolveStableRange({ preset: "24h" }, NOW + 12_345);

        expect(r.toMs - r.fromMs).toBe(1440 * 60_000);
        expect(r.minutes).toBe(1440);
    });

    test("a custom range is already fixed, so snapping leaves it alone", () => {
        const from = new Date("2026-09-01T00:00:00").toISOString();
        const to = new Date("2026-09-03T00:00:00").toISOString();

        expect(resolveStableRange({ preset: "custom", from, to }, NOW)).toEqual(
            resolveRange({ preset: "custom", from, to }, NOW)
        );
    });
});

describe("windowStepMs", () => {
    test("the step grows with the window", () => {
        expect(windowStepMs(60)).toBe(60_000);
        expect(windowStepMs(1440)).toBe(300_000);
        expect(windowStepMs(43_200)).toBe(900_000);
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
