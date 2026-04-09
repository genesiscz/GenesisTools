import { describe, expect, test } from "bun:test";
import type { RentalSource } from "@app/Internal/commands/reas/analysis/rental-aggregation";
import { aggregateRentals, deduplicateListings } from "@app/Internal/commands/reas/analysis/rental-aggregation";

describe("deduplicateListings()", () => {
    test("removes same-address same-price duplicates across providers", () => {
        const sources: RentalSource[] = [
            {
                provider: "sreality",
                listings: [{ disposition: "2+kk", area: 54, rent: 15_000, address: "Letňany, Praha 9" }],
            },
            {
                provider: "ereality",
                listings: [{ disposition: "2+kk", area: 54, rent: 15_000, address: "Letňany, Praha 9" }],
            },
        ];

        const deduped = deduplicateListings(sources);
        expect(deduped.length).toBe(1);
    });

    test("keeps same-address same-rent listings when area differs", () => {
        const sources: RentalSource[] = [
            {
                provider: "sreality",
                listings: [{ disposition: "2+kk", area: 50, rent: 15_000, address: "Letňany, Praha 9" }],
            },
            {
                provider: "ereality",
                listings: [{ disposition: "2+kk", area: 62, rent: 15_000, address: "Letňany, Praha 9" }],
            },
        ];

        const deduped = deduplicateListings(sources);
        expect(deduped.length).toBe(2);
    });

    test("keeps listings with different prices", () => {
        const sources: RentalSource[] = [
            {
                provider: "sreality",
                listings: [{ disposition: "2+kk", area: 54, rent: 15_000, address: "Letňany" }],
            },
            {
                provider: "ereality",
                listings: [{ disposition: "2+kk", area: 54, rent: 16_000, address: "Letňany" }],
            },
        ];

        const deduped = deduplicateListings(sources);
        expect(deduped.length).toBe(2);
    });

    test("keeps listings with different addresses", () => {
        const sources: RentalSource[] = [
            {
                provider: "sreality",
                listings: [
                    { disposition: "2+kk", area: 54, rent: 15_000, address: "Letňany" },
                    { disposition: "2+kk", area: 54, rent: 15_000, address: "Holešovice" },
                ],
            },
        ];

        const deduped = deduplicateListings(sources);
        expect(deduped.length).toBe(2);
    });
});

describe("aggregateRentals()", () => {
    test("groups by disposition and computes stats", () => {
        const sources: RentalSource[] = [
            {
                provider: "sreality",
                listings: [
                    { disposition: "2+kk", area: 50, rent: 14_000, address: "A" },
                    { disposition: "2+kk", area: 55, rent: 16_000, address: "B" },
                    { disposition: "3+1", area: 70, rent: 18_000, address: "C" },
                ],
            },
        ];

        const result = aggregateRentals(sources);
        const twoKk = result.find((r) => r.disposition === "2+kk");
        expect(twoKk).toBeDefined();
        expect(twoKk!.count).toBe(2);
        expect(twoKk!.medianRent).toBe(15_000);
    });

    test("assigns confidence based on sample size", () => {
        const manyListings = Array.from({ length: 15 }, (_, i) => ({
            disposition: "2+kk",
            area: 50 + i,
            rent: 14_000 + i * 500,
            address: `Addr ${i}`,
        }));

        const result = aggregateRentals([{ provider: "sreality", listings: manyListings }]);
        expect(result[0].confidence).toBe("high");
    });

    test("assigns low confidence for small samples", () => {
        const sources: RentalSource[] = [
            {
                provider: "sreality",
                listings: [{ disposition: "2+kk", area: 50, rent: 14_000, address: "A" }],
            },
        ];

        const result = aggregateRentals(sources);
        expect(result[0].confidence).toBe("low");
    });

    test("tracks per-provider stats", () => {
        const sources: RentalSource[] = [
            {
                provider: "sreality",
                listings: [{ disposition: "2+kk", area: 50, rent: 14_000, address: "A" }],
            },
            {
                provider: "ereality",
                listings: [{ disposition: "2+kk", area: 55, rent: 16_000, address: "B" }],
            },
        ];

        const result = aggregateRentals(sources);
        const twoKk = result.find((r) => r.disposition === "2+kk");
        expect(twoKk).toBeDefined();
        expect(twoKk!.sources.sreality).toBeDefined();
        expect(twoKk!.sources.ereality).toBeDefined();
        expect(twoKk!.sources.sreality.count).toBe(1);
    });

    test("sorts results by disposition", () => {
        const sources: RentalSource[] = [
            {
                provider: "sreality",
                listings: [
                    { disposition: "3+1", area: 70, rent: 18_000, address: "A" },
                    { disposition: "1+kk", area: 30, rent: 10_000, address: "B" },
                    { disposition: "2+kk", area: 50, rent: 14_000, address: "C" },
                ],
            },
        ];

        const result = aggregateRentals(sources);
        expect(result[0].disposition).toBe("1+kk");
        expect(result[1].disposition).toBe("2+kk");
        expect(result[2].disposition).toBe("3+1");
    });

    test("computes rent per m2", () => {
        const sources: RentalSource[] = [
            {
                provider: "sreality",
                listings: [{ disposition: "2+kk", area: 50, rent: 15_000, address: "A" }],
            },
        ];

        const result = aggregateRentals(sources);
        // rentPerM2 = median of per-listing rent/area = 15000/50 = 300
        expect(result[0].rentPerM2).toBe(300);
    });
});
