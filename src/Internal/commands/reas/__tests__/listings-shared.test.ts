import { describe, expect, test } from "bun:test";
import {
    appendFilterParams,
    countActiveFilters,
    getListingRangeLabel,
    type ListingsFilters,
    normalizeFilters,
} from "@app/Internal/commands/reas/ui/src/components/listings/listings-shared";

function makeFilters(overrides?: Partial<ListingsFilters>): ListingsFilters {
    return {
        district: "",
        dispositions: [],
        sources: [],
        priceMin: "",
        priceMax: "",
        areaMin: "",
        areaMax: "",
        seenFrom: "",
        seenTo: "",
        ...overrides,
    };
}

describe("listings-shared", () => {
    test("normalizeFilters trims each field before applying queries", () => {
        expect(
            normalizeFilters(
                makeFilters({
                    district: " Praha 2 ",
                    dispositions: [" 2+kk ", " 3+1 "],
                    sources: [" sreality ", " reas "],
                    priceMin: " 2500000 ",
                    areaMax: " 120 ",
                    seenFrom: " 2026-04-01 ",
                })
            )
        ).toEqual({
            district: "Praha 2",
            dispositions: ["2+kk", "3+1"],
            sources: ["sreality", "reas"],
            priceMin: "2500000",
            priceMax: "",
            areaMin: "",
            areaMax: "120",
            seenFrom: "2026-04-01",
            seenTo: "",
        });
    });

    test("countActiveFilters only counts populated normalized fields", () => {
        expect(
            countActiveFilters(
                makeFilters({
                    district: " Praha 2 ",
                    sources: [" "],
                    priceMin: " 2500000 ",
                    seenFrom: "2026-04-01",
                    seenTo: "2026-04-30",
                })
            )
        ).toBe(3);
    });

    test("appendFilterParams serializes multi-select and date filters", () => {
        const params = new URLSearchParams();
        appendFilterParams(
            params,
            makeFilters({
                district: "Praha 2",
                dispositions: ["2+kk", "3+1"],
                sources: ["sreality", "reas"],
                seenFrom: "2026-04-01",
                seenTo: "2026-04-30",
            })
        );

        expect(params.get("district")).toBe("Praha 2");
        expect(params.get("dispositions")).toBe("2+kk,3+1");
        expect(params.get("sources")).toBe("sreality,reas");
        expect(params.get("seenFrom")).toBe("2026-04-01");
        expect(params.get("seenTo")).toBe("2026-04-30");
    });

    test("getListingRangeLabel reflects the visible window for pagination", () => {
        expect(getListingRangeLabel({ page: 2, limit: 25, total: 43 })).toBe("Showing 26 - 43 of 43");
    });
});
