import { describe, expect, test } from "bun:test";
import {
    deriveDistrictFromLocation,
    getListingPersistenceDistrict,
    matchesRequestedDistrict,
} from "@app/Internal/commands/reas/lib/district-matching";

describe("district-matching", () => {
    test("derives Praha ward from a listing address", () => {
        expect(deriveDistrictFromLocation("Varšavská, Praha 2 - Vinohrady")).toBe("Praha 2");
    });

    test("derives non-Prague district from locality strings", () => {
        expect(deriveDistrictFromLocation("Hradec Králové, okres Hradec Králové")).toBe("Hradec Králové");
    });

    test("rejects off-district Prague listings", () => {
        expect(
            matchesRequestedDistrict({ requestedDistrict: "Praha 4", locality: "Varšavská, Praha 2 - Vinohrady" })
        ).toBe(false);
        expect(
            matchesRequestedDistrict({ requestedDistrict: "Praha 4", locality: "Mečislavova, Praha 4 - Nusle" })
        ).toBe(true);
    });

    test("keeps generic Praha rows under Praha for cache snapshots", () => {
        expect(
            getListingPersistenceDistrict({
                requestedDistrict: "Praha",
                locality: "Rybná, Praha 1 - Staré Město",
            })
        ).toBe("Praha");
    });

    test("repairs stale rows to the derived district when the requested district was specific", () => {
        expect(
            getListingPersistenceDistrict({
                requestedDistrict: "Praha 4",
                locality: "Varšavská, Praha 2 - Vinohrady",
            })
        ).toBe("Praha 2");
    });
});
