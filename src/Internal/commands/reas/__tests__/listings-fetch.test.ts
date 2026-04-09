import { describe, expect, test } from "bun:test";
import { buildListingsFetchFilters } from "@app/Internal/commands/reas/lib/listings-fetch";

describe("buildListingsFetchFilters", () => {
    test("requires a district before fetching listings", () => {
        expect(() =>
            buildListingsFetchFilters({
                type: "sale",
                district: "",
                constructionType: "brick",
            })
        ).toThrow("Select a district before fetching listings");
    });

    test("maps sale fetch filters and supported providers", () => {
        const filters = buildListingsFetchFilters({
            type: "sale",
            district: "Praha 2",
            constructionType: "brick",
            disposition: "2+kk",
            source: "sreality",
            priceMin: "3000000",
            priceMax: "9000000",
            areaMin: "45",
            areaMax: "90",
        });

        expect(filters.district.name).toBe("Praha 2");
        expect(filters.constructionType).toBe("brick");
        expect(filters.disposition).toBe("2+kk");
        expect(filters.providers).toEqual(["sreality"]);
        expect(filters.priceMin).toBe(3000000);
        expect(filters.priceMax).toBe(9000000);
        expect(filters.areaMin).toBe(45);
        expect(filters.areaMax).toBe(90);
        expect(filters.periods).toHaveLength(1);
    });

    test("returns an empty provider set for unsupported source filters", () => {
        const filters = buildListingsFetchFilters({
            type: "rental",
            district: "Praha 2",
            constructionType: "brick",
            source: "reas",
        });

        expect(filters.providers).toEqual([]);
    });
});
