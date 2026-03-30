import { describe, expect, test } from "bun:test";
import { parseSrealityName } from "../api/sreality-client";

describe("parseSrealityName()", () => {
    test("parses standard rental name", () => {
        expect(parseSrealityName("Pronájem bytu 2+kk 54 m²")).toEqual({ disposition: "2+kk", area: 54 });
    });

    test("parses without diacritics", () => {
        expect(parseSrealityName("Pronajem bytu 3+1 68 m²")).toEqual({ disposition: "3+1", area: 68 });
    });

    test("returns undefineds for non-matching input", () => {
        expect(parseSrealityName("Prodej domu 150 m²")).toEqual({});
    });

    test("parses 1+kk", () => {
        expect(parseSrealityName("Pronájem bytu 1+kk 28 m²")).toEqual({ disposition: "1+kk", area: 28 });
    });

    test("parses large area", () => {
        expect(parseSrealityName("Pronájem bytu 4+1 120 m²")).toEqual({ disposition: "4+1", area: 120 });
    });
});
