import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrandAliasesRepository } from "@app/shops/db/BrandAliasesRepository";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { extractBrandsFromActor, seedBrandAliases } from "@app/shops/db/seed-brand-aliases";

function tmpDb(): ShopsDatabase {
    return new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-seed-")), "test.db"));
}

describe("extractBrandsFromActor", () => {
    it("extracts BRANDS array literal", () => {
        const src = `
            const BRANDS = ["Ritter Sport", "Lindt", "Milka", "Nestle"];
            module.exports = { BRANDS };
        `;
        const brands = extractBrandsFromActor(src);
        expect(brands).toContain("Ritter Sport");
        expect(brands).toContain("Lindt");
        expect(brands).toContain("Milka");
        expect(brands).toContain("Nestle");
    });

    it("extracts brandsMap object values", () => {
        const src = `
            const brandsMap = {
                "ritterSport": "Ritter Sport",
                "lindt": "Lindt"
            };
        `;
        const brands = extractBrandsFromActor(src);
        expect(brands).toContain("Ritter Sport");
        expect(brands).toContain("Lindt");
    });

    it("ignores non-brand strings (URLs, numerics, html-ish)", () => {
        const src = `
            const URL = "https://example.com";
            const TIMEOUT = 5000;
        `;
        expect(extractBrandsFromActor(src)).toEqual([]);
    });
});

describe("seedBrandAliases (idempotent)", () => {
    it("inserts seed rows then no-ops on second run", async () => {
        const db = tmpDb();
        const repo = new BrandAliasesRepository(db);

        const first = await seedBrandAliases({
            repository: repo,
            brands: ["Ritter Sport", "Lindt", "Milka"],
        });
        expect(first.inserted).toBe(3);

        const second = await seedBrandAliases({
            repository: repo,
            brands: ["Ritter Sport", "Lindt", "Milka"],
        });
        expect(second.inserted).toBe(0);
        expect(second.skipped).toBe(3);
        db.close();
    });
});
