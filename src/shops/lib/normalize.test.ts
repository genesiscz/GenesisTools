import { describe, expect, it } from "bun:test";
import {
    extractFlavorKey,
    extractPackCount,
    extractSize,
    normalizeBrand,
    normalizeName,
    parseUnit,
} from "@app/shops/lib/normalize";

describe("normalizeBrand", () => {
    it("strips diacritics and lowercases", () => {
        expect(normalizeBrand("Ritter Sport")).toBe("ritter sport");
        expect(normalizeBrand("RITTER SPORT")).toBe("ritter sport");
        expect(normalizeBrand("RitterSport")).toBe("rittersport");
        expect(normalizeBrand("Madeta")).toBe("madeta");
        expect(normalizeBrand("Nescafé")).toBe("nescafe");
    });

    it("collapses whitespace", () => {
        expect(normalizeBrand("  Coca   Cola  ")).toBe("coca cola");
    });

    it("returns null for empty/null", () => {
        expect(normalizeBrand(null)).toBeNull();
        expect(normalizeBrand("")).toBeNull();
        expect(normalizeBrand("   ")).toBeNull();
    });
});

describe("normalizeName", () => {
    it("strips diakritika and punctuation, keeps % and decimal", () => {
        expect(normalizeName("Ritter Sport mléčná 100g")).toBe("ritter sport mlecna 100g");
        expect(normalizeName("Lindt Lindor 70%")).toBe("lindt lindor 70%");
        expect(normalizeName("Coca-Cola 1,5L")).toBe("cocacola 1,5l");
    });
});

describe("extractSize", () => {
    it("recognizes g, kg, ml, l, ks with czech variants", () => {
        expect(extractSize("Ritter Sport 100g")).toEqual({ unit: "g", unitAmount: 100 });
        expect(extractSize("Mléko 1L")).toEqual({ unit: "l", unitAmount: 1 });
        expect(extractSize("Mléko 1,5 litru")).toEqual({ unit: "l", unitAmount: 1.5 });
        expect(extractSize("Vajíčka 10ks")).toEqual({ unit: "ks", unitAmount: 10 });
        expect(extractSize("Mouka 1 kg")).toEqual({ unit: "kg", unitAmount: 1 });
        expect(extractSize("Šampón 250 mililitrů")).toEqual({ unit: "ml", unitAmount: 250 });
    });

    it("picks last occurrence for multipack notation", () => {
        expect(extractSize("Coca-Cola 6 × 1,5L")).toEqual({ unit: "l", unitAmount: 1.5 });
    });

    it("returns null when no size markers", () => {
        expect(extractSize("Ritter Sport mléčná")).toBeNull();
    });
});

describe("extractPackCount", () => {
    it("recognizes multi-pack notations", () => {
        expect(extractPackCount("Coca-Cola 6 × 1,5L")).toBe(6);
        expect(extractPackCount("6× Coca-Cola")).toBe(6);
        expect(extractPackCount("Vajíčka 10ks balení")).toBe(10);
        expect(extractPackCount("12-pack")).toBe(12);
    });

    it("returns null when single (not 1)", () => {
        expect(extractPackCount("Ritter Sport 100g")).toBeNull();
    });
});

describe("extractFlavorKey", () => {
    it("maps czech flavor adjectives to canonical tokens", () => {
        expect(extractFlavorKey("Lindt Lindor mléčná")).toBe("milk");
        expect(extractFlavorKey("Lindt Lindor hořká")).toBe("dark");
        expect(extractFlavorKey("Lindt Lindor jahodová")).toBe("strawberry");
        expect(extractFlavorKey("Ritter Sport bílá")).toBe("white");
        expect(extractFlavorKey("Ritter Sport vanilková")).toBe("vanilla");
        expect(extractFlavorKey("Ritter Sport oříšková")).toBe("hazelnut");
    });

    it("returns null when no flavor marker", () => {
        expect(extractFlavorKey("Coca-Cola 1,5L")).toBeNull();
    });
});

describe("parseUnit", () => {
    it("narrows known unit strings", () => {
        expect(parseUnit("g")).toBe("g");
        expect(parseUnit("ML")).toBe("ml");
        expect(parseUnit("kus")).toBe("ks");
        expect(parseUnit("kusy")).toBe("ks");
        expect(parseUnit("nope")).toBeNull();
    });
});
