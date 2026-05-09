import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrandAliasesRepository } from "../db/BrandAliasesRepository";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { BrandResolver } from "./brand-resolver";
import { BulkMatcher } from "./bulk-matcher";
import { MatchExecutor } from "./match-executor";
import { Matcher } from "./matcher";

function setup() {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-bm-")), "test.db"));
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`);
    const repo = new BrandAliasesRepository(db);
    const resolver = new BrandResolver(repo);
    const matcher = new Matcher(db, resolver);
    const executor = new MatchExecutor({ matcher, shopsDb: db });
    const bulk = new BulkMatcher({ matcher, shopsDb: db, executor });
    db.raw().run(
        `INSERT INTO crawl_runs (shop_origin, strategy, started_at, status)
         VALUES ('rohlik.cz', 'test', ?, 'matching')`,
        [new Date().toISOString()]
    );
    const run = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get();
    if (!run) {
        throw new Error("crawl_run insert failed");
    }
    return { db, bulk, crawlRunId: run.id };
}

let counter = 0;
function insertPending(
    db: ShopsDatabase,
    fields: { ean?: string | null; nameNormalized: string; brandNormalized?: string | null }
): number {
    counter += 1;
    const now = new Date().toISOString();
    db.raw().run(
        `INSERT INTO products (shop_origin, slug, url, name, name_normalized, brand_normalized, ean,
                               match_method, first_seen_at, last_updated_at, is_active)
         VALUES ('rohlik.cz', ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1)`,
        [
            `bm-${counter}-${Math.random()}`,
            `https://rohlik.cz/p/${counter}`,
            fields.nameNormalized,
            fields.nameNormalized,
            fields.brandNormalized ?? null,
            fields.ean ?? null,
            now,
            now,
        ]
    );
    const row = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get();
    if (!row) {
        throw new Error("product insert failed");
    }
    return row.id;
}

describe("BulkMatcher.flush", () => {
    it("links pending products by EAN to existing masters", async () => {
        const { db, bulk, crawlRunId } = setup();
        const now = new Date().toISOString();
        db.raw().run(
            `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug, ean, total_offers, created_at, updated_at, verified_by)
             VALUES ('Cola', 'cola', 'cola-bm', '1234567890123', 0, ?, ?, 'auto')`,
            [now, now]
        );
        const _productId = insertPending(db, { ean: "1234567890123", nameNormalized: "cola" });

        const stats = await bulk.flush(crawlRunId);
        expect(stats.linked).toBeGreaterThanOrEqual(1);
        db.close();
    });

    it("auto-seeds when nothing matches", async () => {
        const { db, bulk, crawlRunId } = setup();
        insertPending(db, {
            nameNormalized: "completely fresh widget xyz",
            brandNormalized: "noobrand",
        });
        const stats = await bulk.flush(crawlRunId);
        expect(stats.seeded).toBeGreaterThanOrEqual(1);
        db.close();
    });

    it("does NOT collapse same-shop same-batch pending products without EAN", async () => {
        // With no EAN ground truth, two products from the same shop with
        // identical names are different SKUs by construction (different
        // sizes / variants / listing routes). The shop's own slug already
        // separates them, so we must not blindly collapse them.
        const { db, bulk, crawlRunId } = setup();
        insertPending(db, {
            nameNormalized: "samebatch widget",
            brandNormalized: "batchbrand",
        });
        insertPending(db, {
            nameNormalized: "samebatch widget",
            brandNormalized: "batchbrand",
        });
        await bulk.flush(crawlRunId);
        const masters = db
            .raw()
            .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM master_products WHERE brand_normalized = 'batchbrand'")
            .get();
        expect(masters?.n).toBe(2);
        db.close();
    });

    it("DOES collapse same-shop same-batch products that share an EAN", async () => {
        const { db, bulk, crawlRunId } = setup();
        insertPending(db, {
            nameNormalized: "samebatch widget",
            brandNormalized: "batchbrand",
            ean: "1111111111111",
        });
        insertPending(db, {
            nameNormalized: "samebatch widget",
            brandNormalized: "batchbrand",
            ean: "1111111111111",
        });
        await bulk.flush(crawlRunId);
        const masters = db
            .raw()
            .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM master_products WHERE brand_normalized = 'batchbrand'")
            .get();
        expect(masters?.n).toBe(1);
        db.close();
    });
});
