import { describe, expect, test } from "bun:test";
import {
    DISTRICTS,
    getAllDistrictNames,
    getDistrict,
    getPrahaDistrictNames,
    PRAHA_DISTRICTS,
    searchDistricts,
} from "@app/Internal/commands/reas/data/districts";

describe("District Database", () => {
    test("has at least 13 major Czech cities", () => {
        expect(Object.keys(DISTRICTS).length).toBeGreaterThanOrEqual(13);
    });

    test("every district has reasId and srealityId", () => {
        for (const [name, info] of Object.entries(DISTRICTS)) {
            expect(info.reasId, `${name} missing reasId`).toBeGreaterThan(0);
            expect(info.srealityId, `${name} missing srealityId`).toBeGreaterThan(0);
        }
    });

    test("no duplicate reasIds", () => {
        const ids = Object.values(DISTRICTS).map((d) => d.reasId);
        const unique = new Set(ids);

        expect(unique.size).toBe(ids.length);
    });

    test("Brno reasId is not the same as Hradec Králové", () => {
        expect(DISTRICTS.Brno.reasId).not.toBe(DISTRICTS["Hradec Králové"].reasId);
    });

    test("Brno reasId is 3702", () => {
        expect(DISTRICTS.Brno.reasId).toBe(3702);
    });

    test("Praha uses region locality type", () => {
        expect(DISTRICTS.Praha.srealityLocality).toBe("region");
    });

    test("non-Praha districts use district locality type", () => {
        expect(DISTRICTS["Hradec Králové"].srealityLocality).toBe("district");
        expect(DISTRICTS.Brno.srealityLocality).toBe("district");
        expect(DISTRICTS.Ostrava.srealityLocality).toBe("district");
    });
});

describe("Praha sub-districts", () => {
    test("covers Praha 1-10", () => {
        for (let i = 1; i <= 10; i++) {
            expect(PRAHA_DISTRICTS[`Praha ${i}`], `Missing Praha ${i}`).toBeDefined();
        }
    });

    test("covers Praha 1-22", () => {
        for (let i = 1; i <= 22; i++) {
            expect(PRAHA_DISTRICTS[`Praha ${i}`], `Missing Praha ${i}`).toBeDefined();
        }
    });

    test("each has correct wardNumber", () => {
        for (let i = 1; i <= 22; i++) {
            expect(PRAHA_DISTRICTS[`Praha ${i}`].wardNumber).toBe(i);
        }
    });

    test("each has srealityQuarterId", () => {
        for (const [name, info] of Object.entries(PRAHA_DISTRICTS)) {
            expect(info.srealityQuarterId, `${name} missing srealityQuarterId`).toBeGreaterThan(0);
        }
    });

    test("all share reasId 3100 (Praha city-level)", () => {
        for (const info of Object.values(PRAHA_DISTRICTS)) {
            expect(info.reasId).toBe(3100);
        }
    });
});

describe("getDistrict", () => {
    test("returns exact match", () => {
        const result = getDistrict("Praha");

        expect(result).toBeDefined();
        expect(result!.name).toBe("Praha");
    });

    test("case-insensitive match", () => {
        const result = getDistrict("hradec králové");

        expect(result).toBeDefined();
        expect(result!.name).toBe("Hradec Králové");
    });

    test("finds Praha sub-district", () => {
        const result = getDistrict("Praha 5");

        expect(result).toBeDefined();
        expect(result!.name).toBe("Praha 5");
    });

    test("returns undefined for unknown", () => {
        expect(getDistrict("Mordor")).toBeUndefined();
    });
});

describe("searchDistricts", () => {
    test("finds partial matches", () => {
        const results = searchDistricts("Hrad");

        expect(results.length).toBeGreaterThan(0);
        expect(results[0].name).toContain("Hradec");
    });

    test("startsWith results come first", () => {
        const results = searchDistricts("Pra");
        const names = results.map((r) => r.name);

        expect(names[0]).toMatch(/^Pra/);
    });

    test("finds Praha sub-districts", () => {
        const results = searchDistricts("Praha 1");

        expect(results.length).toBeGreaterThan(0);
        expect(results.some((r) => r.name === "Praha 1")).toBe(true);
    });

    test("returns empty for no match", () => {
        expect(searchDistricts("Mordor")).toHaveLength(0);
    });
});

describe("getAllDistrictNames", () => {
    test("returns sorted array", () => {
        const names = getAllDistrictNames();

        expect(names.length).toBeGreaterThanOrEqual(13);

        for (let i = 1; i < names.length; i++) {
            expect(names[i - 1].localeCompare(names[i], "cs")).toBeLessThanOrEqual(0);
        }
    });

    test("does not include Praha sub-districts", () => {
        const names = getAllDistrictNames();

        expect(names.includes("Praha 1")).toBe(false);
    });
});

describe("getPrahaDistrictNames", () => {
    test("returns 22 names sorted by ward number", () => {
        const names = getPrahaDistrictNames();

        expect(names).toHaveLength(22);
        expect(names[0]).toBe("Praha 1");
        expect(names[21]).toBe("Praha 22");
    });
});
