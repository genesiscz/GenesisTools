import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HlidacGetByUrlResult } from "../api/HlidacShopuClient.types";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { ingestUrl } from "./ingest-api";

class FakeHlidac {
    constructor(private fixture: HlidacGetByUrlResult) {}
    async getByUrl(_url: string): Promise<HlidacGetByUrlResult> {
        return this.fixture;
    }
}

function setup(): { shopsDb: ShopsDatabase; hlidac: FakeHlidac } {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-ingest-api-")), "test.db"));
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('rohlik.cz', 'Rohlík', 'CZK', 1, 1, 1, 1, 1, 'none')`);
    const hlidac = new FakeHlidac({
        source: "s3",
        parsed: {
            origin: "rohlik.cz",
            itemId: "1419780",
            itemUrl: "https://www.rohlik.cz/1419780-ritter-sport",
        },
        history: {
            commonPrice: 49.9,
            minPrice: 45.9,
            entries: [
                { d: "2026-05-01", c: 49.9, o: 59.9 },
                { d: "2026-05-08", c: 45.9, o: 59.9 },
            ],
        },
        meta: {
            itemId: "1419780",
            itemName: "Ritter Sport",
        },
    });
    return { shopsDb: db, hlidac };
}

describe("ingestUrl", () => {
    it("ingests a brand-new URL: writes product, prices, marks auto-seeded", async () => {
        const { shopsDb, hlidac } = setup();
        const result = await ingestUrl(
            { url: "https://www.rohlik.cz/1419780-ritter-sport" },
            { shopsDb, hlidac }
        );
        expect(result.shop_origin).toBe("rohlik.cz");
        expect(result.slug).toBe("1419780");
        expect(result.prices_recorded).toBe(2);
        expect(result.auto_seeded_master).toBe(true);
        expect(result.master_product_id).toBeGreaterThan(0);
        const product = shopsDb
            .raw()
            .query<{ id: number }, []>("SELECT id FROM products WHERE slug='1419780'")
            .get();
        expect(product).not.toBeNull();
        shopsDb.close();
    });

    it("is idempotent: second call updates existing rows, does not re-seed", async () => {
        const { shopsDb, hlidac } = setup();
        const first = await ingestUrl(
            { url: "https://www.rohlik.cz/1419780-ritter-sport" },
            { shopsDb, hlidac }
        );
        const second = await ingestUrl(
            { url: "https://www.rohlik.cz/1419780-ritter-sport" },
            { shopsDb, hlidac }
        );
        expect(second.product_id).toBe(first.product_id);
        expect(second.master_product_id).toBe(first.master_product_id);
        expect(second.auto_seeded_master).toBe(false);
        const productCount =
            shopsDb
                .raw()
                .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM products")
                .get()?.n ?? 0;
        expect(productCount).toBe(1);
        shopsDb.close();
    });

    it("propagates a fetcher error on unknown URL", async () => {
        const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-ingest-err-")), "test.db"));
        const fetcher = {
            getByUrl: async () => {
                throw new Error("hlidac: unknown shop");
            },
        };
        await expect(
            ingestUrl({ url: "https://www.rohlik.cz/9999-foo" }, { shopsDb: db, hlidac: fetcher })
        ).rejects.toThrow(/unknown shop/i);
        db.close();
    });
});
