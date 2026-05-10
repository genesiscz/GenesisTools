import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { listResources, readResource } from "@app/shops/mcp/resources";

function setup(): { shopsDb: ShopsDatabase; masterId: number } {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-mcp-res-")), "test.db"));
    const now = new Date().toISOString();
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('rohlik.cz', 'Rohlík', 'CZK', 1, 1, 1, 1, 1, 'none')`);
    db.raw().run(
        `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug, total_offers, created_at, updated_at, verified_by)
         VALUES ('Ritter Sport', 'ritter sport', 'ritter-sport', 0, ?, ?, 'auto')`,
        [now, now]
    );
    const masterId = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
    db.raw().run(
        `INSERT INTO products (shop_origin, slug, url, name, name_normalized, master_product_id, match_method, first_seen_at, last_updated_at, is_active)
         VALUES ('rohlik.cz', '1419780', 'http://x', 'Ritter Sport', 'ritter sport', ?, 'fuzzy', ?, ?, 1)`,
        [masterId, now, now]
    );
    return { shopsDb: db, masterId };
}

describe("listResources", () => {
    it("returns the two URI templates", () => {
        const out = listResources();
        expect(out).toHaveLength(2);
        expect(out[0].uri).toBe("shops://product/{shop}/{slug}");
        expect(out[1].uri).toBe("shops://master/{id}");
    });
});

describe("readResource", () => {
    it("reads shops://product/<shop>/<slug>", async () => {
        const { shopsDb } = setup();
        const out = await readResource("shops://product/rohlik.cz/1419780", shopsDb);
        expect(out.mimeType).toBe("application/json");
        expect(out.text).toContain("Ritter Sport");
        shopsDb.close();
    });

    it("reads shops://master/<id>", async () => {
        const { shopsDb, masterId } = setup();
        const out = await readResource(`shops://master/${masterId}`, shopsDb);
        expect(out.mimeType).toBe("application/json");
        expect(out.text).toContain("Ritter Sport");
        shopsDb.close();
    });

    it("throws on unsupported URIs", async () => {
        const { shopsDb } = setup();
        await expect(readResource("shops://unknown/foo", shopsDb)).rejects.toThrow(/Unsupported/);
        shopsDb.close();
    });
});
