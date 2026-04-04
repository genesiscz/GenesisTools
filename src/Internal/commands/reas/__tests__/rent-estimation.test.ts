import { describe, expect, test } from "bun:test";
import { computeDispositionYields, estimateRent } from "@app/Internal/commands/reas/analysis/rent-estimation";
import type { RentalListing } from "@app/Internal/commands/reas/types";

function makeListing(overrides: Partial<RentalListing> = {}): RentalListing {
    return {
        id: "1",
        source: "sreality",
        sourceId: "1",
        sourceContract: "sreality-v2",
        type: "rental",
        price: 18000,
        locality: "Praha 2",
        disposition: "2+kk",
        area: 55,
        labels: [],
        ...overrides,
    };
}

describe("estimateRent", () => {
    test("uses disposition-median method when enough matching listings exist", () => {
        const rentals = [
            makeListing({ price: 16000, area: 50 }),
            makeListing({ price: 18000, area: 55 }),
            makeListing({ price: 20000, area: 60 }),
            makeListing({ price: 22000, area: 65 }),
        ];

        const result = estimateRent({ area: 58, disposition: "2+kk", rentals });

        expect(result).toBeDefined();
        expect(result!.method).toBe("disposition-median");
        expect(result!.sampleSize).toBe(4);
        expect(result!.estimatedMonthlyRent).toBeGreaterThan(0);
    });

    test("falls back to area-regression when disposition has too few matches", () => {
        const rentals = [
            makeListing({ disposition: "2+kk", price: 16000, area: 50 }),
            makeListing({ disposition: "3+kk", price: 25000, area: 80 }),
            makeListing({ disposition: "3+kk", price: 27000, area: 85 }),
            makeListing({ disposition: "1+kk", price: 12000, area: 35 }),
            makeListing({ disposition: "1+kk", price: 13000, area: 38 }),
        ];

        const result = estimateRent({ area: 60, disposition: "2+1", rentals });

        expect(result).toBeDefined();
        expect(result!.method).toBe("area-regression");
    });

    test("returns undefined for empty rentals", () => {
        expect(estimateRent({ area: 60, rentals: [] })).toBeUndefined();
    });
});

describe("computeDispositionYields", () => {
    test("computes gross yield per disposition", () => {
        const rentals = [
            makeListing({ disposition: "2+kk", price: 18000, area: 55 }),
            makeListing({ disposition: "2+kk", price: 20000, area: 60 }),
        ];
        const soldListings = [
            { disposition: "2+kk", pricePerM2: 120000 },
            { disposition: "2+kk", pricePerM2: 130000 },
        ];

        const yields = computeDispositionYields({ rentals, soldListings });

        expect(yields).toHaveLength(1);
        expect(yields[0].disposition).toBe("2+kk");
        expect(yields[0].grossYieldPct).toBeGreaterThan(0);
        expect(yields[0].sampleRentals).toBe(2);
        expect(yields[0].sampleSold).toBe(2);
    });

    test("returns empty when no cross-reference possible", () => {
        const rentals = [makeListing({ disposition: "2+kk", price: 18000, area: 55 })];
        const soldListings = [{ disposition: "3+kk", pricePerM2: 120000 }];

        expect(computeDispositionYields({ rentals, soldListings })).toHaveLength(0);
    });
});
