import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrandAliasesRepository } from "../db/BrandAliasesRepository";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { BrandResolver } from "./brand-resolver";
import { Matcher, type MatcherInput } from "./matcher";

interface Setup {
    db: ShopsDatabase;
    matcher: Matcher;
}

function setup(): Setup {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-matcher-")), "test.db"));
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`);
    const repo = new BrandAliasesRepository(db);
    repo.upsertIfAbsent({ alias: "Ritter Sport", canonical: "ritter sport", source: "seed" });
    const resolver = new BrandResolver(repo);
    const matcher = new Matcher(db, resolver);
    return { db, matcher };
}

interface MasterSeed {
    canonical_name?: string;
    canonical_name_normalized?: string;
    canonical_slug?: string;
    brand?: string | null;
    brand_normalized?: string | null;
    ean?: string | null;
    unit?: string | null;
    unit_amount?: number | null;
    pack_count?: number | null;
    flavor_key?: string | null;
}

let slugCounter = 0;
function seedMaster(db: ShopsDatabase, fields: MasterSeed): number {
    slugCounter += 1;
    const now = new Date().toISOString();
    db.raw().run(
        `INSERT INTO master_products
         (canonical_name, canonical_name_normalized, canonical_slug,
          brand, brand_normalized, ean, unit, unit_amount, pack_count, flavor_key,
          total_offers, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
            fields.canonical_name ?? "X",
            fields.canonical_name_normalized ?? "x",
            fields.canonical_slug ?? `slug-${slugCounter}-${Date.now()}`,
            fields.brand ?? null,
            fields.brand_normalized ?? null,
            fields.ean ?? null,
            fields.unit ?? null,
            fields.unit_amount ?? null,
            fields.pack_count ?? null,
            fields.flavor_key ?? null,
            now,
            now,
        ]
    );
    const row = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get();
    if (!row) {
        throw new Error("master insert failed");
    }
    return row.id;
}

function makeInput(overrides: Partial<MatcherInput>): MatcherInput {
    return {
        productId: 1,
        shopOrigin: "rohlik.cz",
        name: "Test product",
        nameNormalized: "test product",
        brandRaw: null,
        brandNormalized: null,
        ean: null,
        unit: null,
        unitAmount: null,
        packCount: null,
        flavorKey: null,
        ...overrides,
    };
}

describe("Matcher Layer 0 (EAN)", () => {
    it("links on exact EAN match", async () => {
        const { db, matcher } = setup();
        const masterId = seedMaster(db, { ean: "1234567890123", canonical_name: "Coca-Cola 1.5L" });
        const input = makeInput({ ean: "1234567890123" });
        const result = await matcher.match(input);
        expect(result.kind).toBe("linked");
        if (result.kind === "linked") {
            expect(result.method).toBe("ean");
            expect(result.layer).toBe(0);
            expect(result.masterProductId).toBe(masterId);
        }
        db.close();
    });

    it("multipack guard blocks EAN match across pack_count mismatch", async () => {
        const { db, matcher } = setup();
        seedMaster(db, { ean: "1234567890123", pack_count: 6 });
        const input = makeInput({ ean: "1234567890123", packCount: null });
        const result = await matcher.match(input);
        expect(result.kind).not.toBe("linked");
        db.close();
    });
});

describe("Matcher Layer 1 (full signature + fuzzy name)", () => {
    it("links on exact signature + high name similarity", async () => {
        const { db, matcher } = setup();
        const masterId = seedMaster(db, {
            canonical_name: "Ritter Sport mléčná 100g",
            canonical_name_normalized: "ritter sport mlecna 100g",
            brand: "Ritter Sport",
            brand_normalized: "ritter sport",
            unit: "g",
            unit_amount: 100,
            flavor_key: "milk",
        });
        const input = makeInput({
            nameNormalized: "ritter sport mlecna 100g",
            brandRaw: "Ritter Sport",
            brandNormalized: "ritter sport",
            unit: "g",
            unitAmount: 100,
            flavorKey: "milk",
        });
        const result = await matcher.match(input);
        expect(result.kind).toBe("linked");
        if (result.kind === "linked") {
            expect(result.layer).toBe(1);
            expect(result.method).toBe("fuzzy");
            expect(result.masterProductId).toBe(masterId);
            expect(result.similarity).toBeGreaterThanOrEqual(0.9);
        }
        db.close();
    });
});

describe("Matcher Layer 2a (signature without flavor)", () => {
    it("links when one side missing flavor", async () => {
        const { db, matcher } = setup();
        seedMaster(db, {
            canonical_name_normalized: "lindor 200g",
            brand_normalized: "lindt",
            unit: "g",
            unit_amount: 200,
            flavor_key: null,
        });
        const input = makeInput({
            nameNormalized: "lindor 200g",
            brandNormalized: "lindt",
            unit: "g",
            unitAmount: 200,
            flavorKey: "milk",
        });
        const result = await matcher.match(input);
        expect(result.kind).toBe("linked");
        if (result.kind === "linked") {
            expect(result.method).toBe("sig:no-flavor");
        }
        db.close();
    });
});

describe("Matcher Layer 2b (signature without size)", () => {
    it("links when one side missing size", async () => {
        const { db, matcher } = setup();
        seedMaster(db, {
            canonical_name_normalized: "lindor strawberry",
            brand_normalized: "lindt",
            unit: null,
            unit_amount: null,
            flavor_key: "strawberry",
        });
        const input = makeInput({
            nameNormalized: "lindor strawberry",
            brandNormalized: "lindt",
            unit: null,
            unitAmount: null,
            flavorKey: "strawberry",
        });
        const result = await matcher.match(input);
        expect(result.kind).toBe("linked");
        if (result.kind === "linked") {
            expect(result.method).toBe("sig:no-size");
        }
        db.close();
    });
});

describe("Matcher Layer 3 (brand only)", () => {
    it("auto-links when score ≥ 0.95", async () => {
        const { db, matcher } = setup();
        const masterId = seedMaster(db, {
            canonical_name_normalized: "ritter sport mlecna",
            brand_normalized: "ritter sport",
        });
        const input = makeInput({
            nameNormalized: "ritter sport mlecna",
            brandNormalized: "ritter sport",
        });
        const result = await matcher.match(input);
        expect(result.kind).toBe("linked");
        if (result.kind === "linked") {
            expect(result.layer).toBe(3);
            expect(result.method).toBe("fuzzy-brand-name");
            expect(result.masterProductId).toBe(masterId);
        }
        db.close();
    });
});

describe("Matcher fallthrough → seed", () => {
    it("seeds when no candidates at any layer", async () => {
        const { db, matcher } = setup();
        const input = makeInput({
            nameNormalized: "completely unique product",
            brandNormalized: "unknownbrand",
        });
        const result = await matcher.match(input);
        expect(result.kind).toBe("seed");
        db.close();
    });
});

function seedProduct(
    db: ShopsDatabase,
    opts: { masterId: number; shopOrigin: string; nameNormalized: string }
): number {
    const now = new Date().toISOString();
    db.raw().run(
        `INSERT INTO products (shop_origin, slug, url, name, name_normalized, master_product_id,
                               match_method, first_seen_at, last_updated_at, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 'auto-seed', ?, ?, 1)`,
        [
            opts.shopOrigin,
            `slug-${Math.random().toString(36).slice(2)}`,
            `https://${opts.shopOrigin}/x`,
            opts.nameNormalized,
            opts.nameNormalized,
            opts.masterId,
            now,
            now,
        ]
    );
    return db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()?.id ?? 0;
}

describe("Matcher same-shop guard", () => {
    it("does NOT link a rohlik product to a master that already has a rohlik product (Layer 3)", async () => {
        const { db, matcher } = setup();
        const masterId = seedMaster(db, {
            canonical_name_normalized: "7days croissant s kakaovou naplni",
            brand_normalized: "7days",
        });
        seedProduct(db, {
            masterId,
            shopOrigin: "rohlik.cz",
            nameNormalized: "7days croissant s kakaovou naplni",
        });

        const input = makeInput({
            productId: 999,
            shopOrigin: "rohlik.cz",
            nameNormalized: "7days croissant mini s kakaovou naplni",
            brandNormalized: "7days",
        });

        const result = await matcher.match(input);
        // Same-shop products should NOT auto-link to the same master.
        // They're already distinguishable by slug in the source shop.
        if (result.kind === "linked") {
            expect(result.masterProductId).not.toBe(masterId);
        } else {
            expect(["seed", "gray-zone"]).toContain(result.kind);
        }
        db.close();
    });

    it("DOES link a rohlik product to a master with only a kosik product (cross-shop)", async () => {
        const { db, matcher } = setup();
        db.raw().exec(
            `INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
             VALUES ('kosik.cz','Košík','CZK',1,1,1,1,1,'none')`
        );
        const masterId = seedMaster(db, {
            canonical_name_normalized: "ritter sport mlecna",
            brand_normalized: "ritter sport",
        });
        seedProduct(db, {
            masterId,
            shopOrigin: "kosik.cz",
            nameNormalized: "ritter sport mlecna",
        });

        const input = makeInput({
            productId: 999,
            shopOrigin: "rohlik.cz",
            nameNormalized: "ritter sport mlecna",
            brandNormalized: "ritter sport",
        });

        const result = await matcher.match(input);
        expect(result.kind).toBe("linked");
        if (result.kind === "linked") {
            expect(result.masterProductId).toBe(masterId);
        }
        db.close();
    });

    it("does NOT link via EAN to a master that already has same-shop product", async () => {
        const { db, matcher } = setup();
        const masterId = seedMaster(db, { ean: "1234567890123" });
        seedProduct(db, {
            masterId,
            shopOrigin: "rohlik.cz",
            nameNormalized: "existing rohlik product",
        });

        const input = makeInput({
            productId: 999,
            shopOrigin: "rohlik.cz",
            ean: "1234567890123",
        });

        const result = await matcher.match(input);
        if (result.kind === "linked") {
            expect(result.masterProductId).not.toBe(masterId);
        }
        db.close();
    });
});
