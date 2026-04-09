import { describe, expect, test } from "bun:test";
import type { DistrictInfo } from "@app/Internal/commands/reas/data/districts";

describe("parseResolvedAddress", () => {
    test("extracts district from suggest result with matching district DB entry", async () => {
        const { parseResolvedAddress } = await import("../lib/address-resolver");

        const result = parseResolvedAddress({
            value: "Hradec Králové",
            regionType: "municipality",
            regionId: 569810,
            districtId: 5203,
            municipality: "Hradec Králové",
        });

        expect(result).not.toBeNull();
        expect(result!.district.name).toBe("Hradec Králové");
        expect(result!.district.reasId).toBe(3602);
        expect(result!.district.srealityId).toBe(28);
        expect(result!.municipalityName).toBe("Hradec Králové");
    });

    test("returns null for unknown district", async () => {
        const { parseResolvedAddress } = await import("../lib/address-resolver");

        const result = parseResolvedAddress({
            value: "Neexistující Město",
            regionType: "municipality",
            regionId: 999999,
            districtId: 9999,
            municipality: "Neexistující",
        });

        expect(result).toBeNull();
    });

    test("resolves Praha districts correctly", async () => {
        const { parseResolvedAddress } = await import("../lib/address-resolver");

        const result = parseResolvedAddress({
            value: "Praha 3",
            regionType: "quarter",
            regionId: 500003,
            districtId: 3100,
            municipality: "Praha",
        });

        expect(result).not.toBeNull();
        expect(result!.district.name).toBe("Praha 3");
        expect(result!.district.reasId).toBe(3100);
        expect(result!.municipalityName).toBe("Praha");
    });

    test("resolves Brno by municipality name fallback", async () => {
        const { parseResolvedAddress } = await import("../lib/address-resolver");

        const result = parseResolvedAddress({
            value: "Brno-Žabovřesky",
            regionType: "ward",
            regionId: 582786,
            districtId: 3702,
            municipality: "Brno",
        });

        expect(result).not.toBeNull();
        expect(result!.district.name).toBe("Brno");
        expect(result!.district.reasId).toBe(3702);
    });
});

describe("buildSearchFilters", () => {
    test("builds filters from resolved address and options", async () => {
        const { buildSearchFilters } = await import("../lib/address-resolver");

        const district: DistrictInfo = {
            name: "Hradec Králové",
            reasId: 3602,
            srealityId: 28,
            srealityLocality: "district",
        };

        const filters = buildSearchFilters({
            district,
            constructionType: "panel",
            disposition: "3+1",
            periods: ["2024", "2025"],
        });

        expect(filters.estateType).toBe("flat");
        expect(filters.constructionType).toBe("panel");
        expect(filters.disposition).toBe("3+1");
        expect(filters.district.name).toBe("Hradec Králové");
        expect(filters.district.reasId).toBe(3602);
        expect(filters.district.srealityId).toBe(28);
        expect(filters.periods).toHaveLength(2);
        expect(filters.periods[0].label).toBe("2024");
    });

    test("omits disposition when 'all' is specified", async () => {
        const { buildSearchFilters } = await import("../lib/address-resolver");

        const district: DistrictInfo = {
            name: "Brno",
            reasId: 3702,
            srealityId: 72,
            srealityLocality: "district",
        };

        const filters = buildSearchFilters({
            district,
            constructionType: "brick",
            disposition: "all",
        });

        expect(filters.disposition).toBeUndefined();
    });

    test("defaults to current year when no periods specified", async () => {
        const { buildSearchFilters } = await import("../lib/address-resolver");

        const district: DistrictInfo = {
            name: "Praha",
            reasId: 3100,
            srealityId: 10,
            srealityLocality: "region",
        };

        const filters = buildSearchFilters({ district, constructionType: "panel" });
        const currentYear = new Date().getFullYear();

        expect(filters.periods).toHaveLength(1);
        expect(filters.periods[0].label).toBe(String(currentYear));
    });
});

describe("resolveAddress", () => {
    test.skipIf(!process.env.INTEGRATION)("calls suggestLocality and cross-references with district DB", async () => {
        const { resolveAddress } = await import("../lib/address-resolver");

        const results = await resolveAddress("Hradec Králové");

        expect(results.length).toBeGreaterThan(0);
        expect(results[0].district.name).toBe("Hradec Králové");
        expect(results[0].district.reasId).toBe(3602);
        expect(results[0].municipalityName).toBe("Hradec Králové");
    });
});
