import type { WeatherRes } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { mockDashboardClient } from "@/api/mock-client";
import { WEATHER_INTERVAL_MS, weatherFeatureKeys, weatherSnapshotQuery } from "@/features/weather/queries";

/**
 * Proves the weather data layer flows through the D32 seam WITHOUT a React renderer (none installed
 * — adding one is a D20 decision). Exercises the mock client directly and the `queryOptions`
 * factory's queryFn against it — exactly what `useQuery` calls. Mirrors pulse/queries.test.ts.
 */

describe("mock dashboard client — weather", () => {
    it("weather() returns a labelled snapshot with a numeric/null temp", async () => {
        const w = await mockDashboardClient.weather();
        expect(typeof w.label).toBe("string");
        expect(w.label.length).toBeGreaterThan(0);
        expect(typeof w.description).toBe("string");
        expect(w.tempC === null || typeof w.tempC === "number").toBe(true);
        expect(typeof w.fetchedAt).toBe("string");
    });
});

describe("weather query factory", () => {
    it("builds the distinct weather-card key + 10-min interval + a queryFn that calls the client", async () => {
        const opts = weatherSnapshotQuery(mockDashboardClient);
        expect([...opts.queryKey]).toEqual([...weatherFeatureKeys.snapshot]);
        // Distinct root from pulse's ["weather"] — guards the D32 unique-root rule (see notes).
        expect(opts.queryKey[0]).toBe("weather-card");
        expect(opts.refetchInterval).toBe(WEATHER_INTERVAL_MS);
        expect(typeof opts.queryFn).toBe("function");
        const data = await (opts.queryFn as unknown as () => Promise<WeatherRes>)();
        expect(typeof data.label).toBe("string");
    });
});
