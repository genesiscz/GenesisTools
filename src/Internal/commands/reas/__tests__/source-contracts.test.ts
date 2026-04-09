import { describe, expect, test } from "bun:test";
import { SOURCE_CONTRACTS } from "@app/Internal/commands/reas/api/source-contracts";

describe("SOURCE_CONTRACTS", () => {
    test("contains all known provider contracts", () => {
        const values = Object.values(SOURCE_CONTRACTS);

        expect(values).toContain("reas-catalog");
        expect(values).toContain("reas-pointers-and-clusters");
        expect(values).toContain("sreality-v2");
        expect(values).toContain("sreality-v2-sale");
        expect(values).toContain("sreality-v1-histogram");
        expect(values).toContain("sreality-v1-clusters");
        expect(values).toContain("sreality-v1-geometries");
        expect(values).toContain("graphql:listAdverts");
        expect(values).toContain("graphql:listAdverts:sale");
        expect(values).toContain("ereality-html");
        expect(values).toContain("mf-cenova-mapa");
    });

    test("exports exactly 11 contract identifiers", () => {
        expect(Object.keys(SOURCE_CONTRACTS)).toHaveLength(11);
    });

    test("all values are unique strings", () => {
        const values = Object.values(SOURCE_CONTRACTS);
        expect(new Set(values).size).toBe(values.length);
    });
});
