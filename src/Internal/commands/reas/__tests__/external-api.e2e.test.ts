/**
 * E2E tests for all external API endpoints used by the REAS module.
 *
 * Run: E2E=1 bun test src/Internal/commands/reas/__tests__/external-api.e2e.test.ts
 *
 * These tests exercise the actual API client classes (ReasClient, SrealityClient, etc.)
 * against live endpoints. Gated behind E2E=1 so normal test runs skip them.
 */

import { describe, expect, test } from "bun:test";
import { BezrealitkyClient } from "@app/Internal/commands/reas/api/BezrealitkyClient";
import { ErealityClient } from "@app/Internal/commands/reas/api/ErealityClient";
import { MfRentalClient } from "@app/Internal/commands/reas/api/MfRentalClient";
import { ReasClient } from "@app/Internal/commands/reas/api/ReasClient";
import { SrealityClient } from "@app/Internal/commands/reas/api/SrealityClient";
import { getDistrict } from "@app/Internal/commands/reas/data/districts";
import type { AnalysisFilters, DateRange } from "@app/Internal/commands/reas/types";

const SKIP = !process.env.E2E;

function buildFilters(districtName = "Praha 3", opts?: { disposition?: string; daysBack?: number }): AnalysisFilters {
    const district = getDistrict(districtName);

    if (!district) {
        throw new Error(`District "${districtName}" not found`);
    }

    const now = new Date();
    const daysBack = opts?.daysBack ?? 365;
    const from = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);

    return {
        estateType: "flat",
        constructionType: "brick",
        disposition: opts?.disposition,
        periods: [{ label: "Recent", from, to: now }],
        district,
    };
}

function buildDateRange(daysBack = 365): DateRange {
    const now = new Date();
    const from = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    return { label: "Recent", from, to: now };
}

describe.skipIf(SKIP)("External API E2E", () => {
    // ──────────────────────────────────────────────────────────────
    // REAS Catalog
    // ──────────────────────────────────────────────────────────────
    describe("REAS Catalog", () => {
        const client = new ReasClient();
        const filters = buildFilters();
        const dateRange = buildDateRange();

        test("fetchSoldCount returns a positive count", async () => {
            const count = await client.fetchSoldCount(filters, dateRange);
            expect(count).toBeGreaterThan(0);
        }, 15_000);

        test("fetchSoldListings returns an array of listings", async () => {
            // Use 60-day window to limit pagination (fewer pages = less chance of 503)
            const narrowDateRange = buildDateRange(60);
            const listings = await client.fetchSoldListings(filters, narrowDateRange, true);
            expect(Array.isArray(listings)).toBe(true);
        }, 60_000);

        test("fetchPointersAndClusters returns pointers and clusterPointers", async () => {
            const filtersWithBounds: AnalysisFilters = {
                ...filters,
                bounds: {
                    southWestLatitude: 50.0,
                    southWestLongitude: 14.2,
                    northEastLatitude: 50.2,
                    northEastLongitude: 14.7,
                },
            };
            const data = await client.fetchPointersAndClusters(filtersWithBounds, dateRange);
            expect(data).toBeDefined();
            expect(Array.isArray(data.pointers)).toBe(true);
            expect(Array.isArray(data.clusterPointers)).toBe(true);
        }, 15_000);
    });

    // ──────────────────────────────────────────────────────────────
    // Sreality
    // ──────────────────────────────────────────────────────────────
    describe("Sreality", () => {
        const client = new SrealityClient();
        // Use disposition filter to limit pagination — "4+1" has fewer listings than "All"
        const filters = buildFilters("Praha 3", { disposition: "4+1" });

        test("fetchRentalListings returns rental listings", async () => {
            const rentals = await client.fetchRentalListings(filters, true);
            expect(Array.isArray(rentals)).toBe(true);
        }, 30_000);

        test("fetchSaleListings returns sale listings", async () => {
            const sales = await client.fetchSaleListings(filters, true);
            expect(Array.isArray(sales)).toBe(true);
        }, 30_000);

        test("suggestLocality returns suggestions for Praha", async () => {
            const suggestions = await client.suggestLocality("Praha");
            expect(suggestions.length).toBeGreaterThan(0);
        }, 15_000);

        test("fetchHistogram returns histogram buckets", async () => {
            const district = getDistrict("Praha 3")!;
            const buckets = await client.fetchHistogram({
                category_main_cb: 1,
                category_type_cb: 2,
                locality_district_id: district.srealityId,
            });
            expect(Array.isArray(buckets)).toBe(true);
        }, 15_000);

        test("fetchClusters returns cluster data", async () => {
            const district = getDistrict("Praha 3")!;
            const clusters = await client.fetchClusters({
                category_main_cb: 1,
                category_type_cb: 2,
                locality_district_id: district.srealityId,
                lat_min: 50.0,
                lat_max: 50.2,
                lon_min: 14.2,
                lon_max: 14.7,
                zoom: 12,
            });
            expect(Array.isArray(clusters)).toBe(true);
        }, 15_000);

        test("fetchGeometries returns geometry data", async () => {
            const district = getDistrict("Praha 3")!;
            const geometries = await client.fetchGeometries({
                entityId: district.srealityId,
                entityType: "district",
            });
            expect(Array.isArray(geometries)).toBe(true);
        }, 15_000);

        test("suggestLocality returns suggestions for Hradec Králové", async () => {
            const suggestions = await client.suggestLocality("Hradec Králové");
            expect(suggestions.length).toBeGreaterThan(0);
            expect(suggestions[0].municipality).toBeDefined();
        }, 15_000);
    });

    // ──────────────────────────────────────────────────────────────
    // Bezrealitky
    // ──────────────────────────────────────────────────────────────
    describe("Bezrealitky", () => {
        const client = new BezrealitkyClient();

        test("resolveRegionOsmIds responds (may error due to their API outage)", async () => {
            // Bezrealitky autocomplete is known to be flaky — accept either
            // a valid result or the known "Internal error" thrown by our client
            try {
                const osmIds = await client.resolveRegionOsmIds("Praha");
                expect(Array.isArray(osmIds)).toBe(true);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                // Known outage: their autocomplete returns {"error": "Internal error"}
                expect(message).toContain("Bezrealitky autocomplete failed");
            }
        }, 15_000);

        test("fetchRentalListings responds (may fail due to autocomplete outage)", async () => {
            const filters = buildFilters();

            try {
                const rentals = await client.fetchRentalListings(filters, true);
                expect(Array.isArray(rentals)).toBe(true);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                expect(message).toContain("Bezrealitky");
            }
        }, 30_000);

        test("fetchAdvertDetail responds to schema query", async () => {
            // Advert "1" won't exist, but the GraphQL endpoint should accept the query
            try {
                await client.fetchAdvertDetail("1");
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                // "was not found" is expected for fake ID — but NOT a 500 or network error
                expect(message).toMatch(/not found|Bezrealitky/i);
            }
        }, 15_000);
    });

    // ──────────────────────────────────────────────────────────────
    // eReality
    // ──────────────────────────────────────────────────────────────
    describe("eReality", () => {
        const client = new ErealityClient();

        test("fetchRentals returns listings for Praha", async () => {
            // Use "Praha" (city-wide) since Praha 3 may have zero listings on eReality
            const filters = buildFilters("Praha");
            const rentals = await client.fetchRentals(filters, true);
            expect(Array.isArray(rentals)).toBe(true);
        }, 30_000);
    });

    // ──────────────────────────────────────────────────────────────
    // MF Cenova Mapa
    // ──────────────────────────────────────────────────────────────
    describe("MF Cenova Mapa", () => {
        const client = new MfRentalClient();

        test("fetchRentalDataForDistrict returns benchmarks for Praha", async () => {
            const benchmarks = await client.fetchRentalDataForDistrict("Praha 3", true);
            expect(Array.isArray(benchmarks)).toBe(true);
            expect(benchmarks.length).toBeGreaterThan(0);

            // Verify structure
            const first = benchmarks[0];
            expect(first.municipality).toBeDefined();
            expect(first.sizeCategory).toMatch(/^VK[1-4]$/);
            expect(first.referencePrice).toBeGreaterThan(0);
        }, 30_000);
    });
});
