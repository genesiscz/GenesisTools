import { describe, expect, it } from "bun:test";
import { SearchRepository } from "@app/shops/db/SearchRepository";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";

async function tmpDb(): Promise<ShopsDatabase> {
    const db = new ShopsDatabase(":memory:");
    await db.upsertShop({
        origin: "rohlik.cz",
        display_name: "Rohlík.cz",
        currency: "CZK",
        cap_live: 1,
        cap_history: 1,
        cap_listing: 1,
        cap_ean: 1,
        cap_search: 1,
        bot_protection: "none",
    });
    return db;
}

async function seedProduct(db: ShopsDatabase, slug: string, name: string, brand: string | null = null) {
    const masterId = await db.upsertMasterProduct({
        canonical_name: name,
        canonical_name_normalized: name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(),
        canonical_slug: slug,
        attributes_json: "{}",
    });
    return await db.upsertProduct({
        shop_origin: "rohlik.cz",
        slug,
        url: `https://www.rohlik.cz/${slug}`,
        name,
        name_normalized: name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(),
        brand,
        brand_normalized: brand ? brand.toLowerCase() : null,
        master_product_id: masterId,
        match_method: "auto-seed",
    });
}

describe("SearchRepository", () => {
    it("matches Czech product names without diacritics in the query", async () => {
        const db = await tmpDb();
        try {
            await seedProduct(db, "1", "Ritter Sport mléčná čokoláda 100g");
            await seedProduct(db, "2", "Ritter Sport hořká čokoláda 100g");
            await seedProduct(db, "3", "Lindt Excellence 70% kakao");
            await seedProduct(db, "4", "Nescafé Gold instantní káva 100g");
            await seedProduct(db, "5", "Tatranky oplatky čokoládové");

            const repo = new SearchRepository(db);

            // Diacritic-free input, full diacritics in the data — the tokenizer should normalize both sides.
            const results1 = repo.search("cokolada");
            expect(results1.length).toBeGreaterThanOrEqual(2);

            const results2 = repo.search("Ritter");
            expect(results2.length).toBe(2);

            const results3 = repo.search("kava");
            expect(results3.length).toBeGreaterThanOrEqual(1);
            expect(results3[0]?.name).toContain("Nescafé");
        } finally {
            db.close();
        }
    });

    it("returns [] for an empty query", async () => {
        const db = await tmpDb();
        try {
            const repo = new SearchRepository(db);
            expect(repo.search("")).toEqual([]);
            expect(repo.search("   ")).toEqual([]);
        } finally {
            db.close();
        }
    });

    it("respects the limit option", async () => {
        const db = await tmpDb();
        try {
            for (let i = 0; i < 5; i++) {
                await seedProduct(db, `s${i}`, `Choco ${i}`);
            }

            const repo = new SearchRepository(db);
            expect(repo.search("Choco", { limit: 2 })).toHaveLength(2);
        } finally {
            db.close();
        }
    });
});
