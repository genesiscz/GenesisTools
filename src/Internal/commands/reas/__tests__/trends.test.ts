import { describe, expect, test } from "bun:test";
import { analyzeTrends } from "@app/Internal/commands/reas/analysis/trends";
import type { ReasListing } from "@app/Internal/commands/reas/types";

function makeListing(soldAt: string, utilityArea: number, soldPrice: number): ReasListing {
    return {
        _id: `listing-${soldPrice}-${soldAt}`,
        formattedAddress: "Test",
        formattedLocation: "Test",
        soldPrice,
        price: soldPrice,
        originalPrice: soldPrice,
        disposition: "2+kk",
        utilityArea,
        displayArea: utilityArea,
        soldAt,
        firstVisibleAt: soldAt,
        point: { type: "Point", coordinates: [14.4, 50.0] },
        cadastralAreaSlug: "test",
        municipalitySlug: "test",
        link: "https://example.com",
    };
}

describe("analyzeTrends()", () => {
    test("groups listings into quarters", () => {
        const listings = [
            makeListing("2024-01-15", 60, 3_000_000),
            makeListing("2024-02-20", 50, 2_500_000),
            makeListing("2024-04-10", 70, 3_500_000),
            makeListing("2024-07-05", 65, 3_250_000),
        ];

        const result = analyzeTrends(listings);
        expect(result.periods.length).toBe(3); // Q1, Q2, Q3
        expect(result.periods[0].label).toBe("Q1 2024");
    });

    test("detects rising market", () => {
        const listings = [
            makeListing("2024-01-15", 60, 2_400_000), // 40k/m2
            makeListing("2024-04-10", 60, 2_700_000), // 45k/m2
            makeListing("2024-07-05", 60, 3_000_000), // 50k/m2
        ];

        const result = analyzeTrends(listings);
        expect(result.direction).toBe("rising");
    });

    test("detects falling market", () => {
        const listings = [
            makeListing("2024-01-15", 60, 3_600_000), // 60k/m2
            makeListing("2024-04-10", 60, 3_000_000), // 50k/m2
            makeListing("2024-07-05", 60, 2_400_000), // 40k/m2
        ];

        const result = analyzeTrends(listings);
        expect(result.direction).toBe("declining");
    });

    test("returns null yoyChange with insufficient data", () => {
        const listings = [makeListing("2024-01-15", 60, 3_000_000)];

        const result = analyzeTrends(listings);
        expect(result.yoyChange).toBeNull();
    });

    test("computes yoy change when matching quarters exist", () => {
        const listings = [
            makeListing("2023-01-15", 60, 3_000_000), // Q1 2023: 50k/m2
            makeListing("2024-01-15", 60, 3_300_000), // Q1 2024: 55k/m2
        ];

        const result = analyzeTrends(listings);
        expect(result.yoyChange).not.toBeNull();
        // 10% increase
        expect(result.yoyChange).toBeCloseTo(10, 0);
    });

    test("period change is null for first period", () => {
        const listings = [makeListing("2024-01-15", 60, 3_000_000), makeListing("2024-04-10", 60, 3_300_000)];

        const result = analyzeTrends(listings);
        expect(result.periods[0].change).toBeNull();
        expect(result.periods[1].change).not.toBeNull();
    });
});
