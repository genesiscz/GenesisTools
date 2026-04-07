import { describe, expect, test } from "bun:test";
import { analyzeComparables, median, percentile } from "@app/Internal/commands/reas/analysis/comparables";
import type { ReasListing, TargetProperty } from "@app/Internal/commands/reas/types";

describe("median()", () => {
    test("odd-length array", () => {
        expect(median([1, 3, 5])).toBe(3);
    });

    test("even-length array", () => {
        expect(median([1, 2, 3, 4])).toBe(2.5);
    });

    test("single element", () => {
        expect(median([42])).toBe(42);
    });

    test("empty array returns 0", () => {
        expect(median([])).toBe(0);
    });
});

describe("percentile()", () => {
    test("p50 equals median", () => {
        expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    });

    test("p0 equals min", () => {
        expect(percentile([10, 20, 30], 0)).toBe(10);
    });

    test("p100 equals max", () => {
        expect(percentile([10, 20, 30], 100)).toBe(30);
    });

    test("empty array returns 0", () => {
        expect(percentile([], 50)).toBe(0);
    });

    test("single element returns that element", () => {
        expect(percentile([42], 25)).toBe(42);
    });
});

describe("analyzeComparables()", () => {
    const makeListing = (
        soldPrice: number,
        utilityArea: number,
        originalPrice: number,
        soldAt: string,
        firstVisibleAt: string
    ): ReasListing => ({
        _id: `listing-${soldPrice}`,
        formattedAddress: "Test Address",
        formattedLocation: "Test Location",
        soldPrice,
        price: soldPrice,
        originalPrice,
        disposition: "2+kk",
        utilityArea,
        displayArea: utilityArea,
        soldAt,
        firstVisibleAt,
        point: { type: "Point", coordinates: [14.4, 50.0] },
        cadastralAreaSlug: "test",
        municipalitySlug: "test",
        link: "https://example.com",
    });

    const listings: ReasListing[] = [
        makeListing(3_000_000, 60, 3_200_000, "2024-06-01", "2024-03-01"), // 50,000/m²
        makeListing(4_000_000, 70, 4_000_000, "2024-07-01", "2024-05-01"), // ~57,143/m²
        makeListing(2_500_000, 50, 2_800_000, "2024-08-01", "2024-06-15"), // 50,000/m²
    ];

    const target: TargetProperty = {
        price: 3_500_000,
        area: 65,
        disposition: "2+kk",
        constructionType: "panel",
        monthlyRent: 15_000,
        monthlyCosts: 5_000,
        district: "Praha",
        districtId: 3100,
        srealityDistrictId: 1,
    };

    test("computes median price per m2", () => {
        const result = analyzeComparables(listings, target);
        // sorted prices/m2: [50000, 50000, 50000] — all are 50k/m2
        expect(result.pricePerM2.median).toBe(50_000);
    });

    test("computes target percentile", () => {
        const result = analyzeComparables(listings, target);
        // target CZK/m2 = 3500000/65 ~ 53846
        expect(result.targetPercentile).toBeGreaterThan(0);
        expect(result.targetPercentile).toBeLessThanOrEqual(100);
    });

    test("filters out listings with zero area", () => {
        const withZero = [...listings, makeListing(1_000_000, 0, 1_000_000, "2024-01-01", "2024-01-01")];
        const result = analyzeComparables(withZero, target);
        expect(result.listings.length).toBe(3);
    });

    test("computes days on market", () => {
        const result = analyzeComparables(listings, target);
        // First listing: 2024-03-01 to 2024-06-01 = ~92 days
        const firstListing = result.listings.find((l) => l._id === "listing-3000000");
        expect(firstListing).toBeDefined();
        expect(firstListing!.daysOnMarket).toBeGreaterThan(80);
    });

    test("computes discount", () => {
        const result = analyzeComparables(listings, target);
        // First listing: (3000000 - 3200000) / 3200000 * 100 = -6.25%
        const firstListing = result.listings.find((l) => l._id === "listing-3000000");
        expect(firstListing).toBeDefined();
        expect(firstListing!.discount).toBeCloseTo(-6.25, 1);
    });

    test("returns sorted listings by pricePerM2", () => {
        const result = analyzeComparables(listings, target);
        for (let i = 1; i < result.listings.length; i++) {
            expect(result.listings[i].pricePerM2).toBeGreaterThanOrEqual(result.listings[i - 1].pricePerM2);
        }
    });
});
