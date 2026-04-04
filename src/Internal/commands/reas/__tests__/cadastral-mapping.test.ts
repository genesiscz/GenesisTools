import { describe, expect, test } from "bun:test";
import { getCadastralMunicipalities } from "@app/Internal/commands/reas/data/cadastral-mapping";

describe("getCadastralMunicipalities", () => {
    test("returns Praha for Prague district names", () => {
        expect(getCadastralMunicipalities("Praha 2")).toEqual(["Praha"]);
        expect(getCadastralMunicipalities("Praha 10")).toEqual(["Praha"]);
    });

    test("returns direct match for city districts", () => {
        expect(getCadastralMunicipalities("Ostrava")).toEqual(["Ostrava"]);
        expect(getCadastralMunicipalities("Brno")).toEqual(["Brno"]);
    });

    test("returns district name itself as fallback", () => {
        expect(getCadastralMunicipalities("SomeUnknown")).toEqual(["SomeUnknown"]);
    });
});
