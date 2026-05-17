import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { buildRegistry, getAdvertisedTools } from "@app/shops/mcp/registry";

describe("MCP server tool registration shape", () => {
    it("read-only mode advertises 8 tools", () => {
        const advertised = getAdvertisedTools(buildRegistry(), false);
        expect(advertised).toHaveLength(8);
        expect(advertised.map((t) => t.name).sort()).toEqual(
            [
                "shops_compare_prices",
                "shops_coverage",
                "shops_get_product",
                "shops_list_categories",
                "shops_match_product",
                "shops_recent_notifications",
                "shops_search",
                "shops_watch_list",
            ].sort()
        );
    });

    it("allow-write mode advertises 13 tools", () => {
        const advertised = getAdvertisedTools(buildRegistry(), true);
        expect(advertised).toHaveLength(13);
        expect(advertised.map((t) => t.name)).toContain("shops_ingest");
        expect(advertised.map((t) => t.name)).toContain("shops_accept_match");
        expect(advertised.map((t) => t.name)).toContain("shops_watch_add");
        expect(advertised.map((t) => t.name)).toContain("shops_watch_remove");
        expect(advertised.map((t) => t.name)).toContain("shops_notify_ack");
    });
});

describe("end-to-end handler invocation", () => {
    it("dispatches shops_search via registry against a populated DB", async () => {
        const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-mcp-srv-")), "test.db"));
        const now = new Date().toISOString();
        db.raw().exec(
            `INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
             VALUES ('rohlik.cz', 'Rohlík', 'CZK', 1, 1, 1, 1, 1, 'none')`
        );
        db.raw().run(
            `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug, total_offers, created_at, updated_at, verified_by)
             VALUES ('Ritter Sport', 'ritter sport', 'ritter-sport', 0, ?, ?, 'auto')`,
            [now, now]
        );
        db.raw().run(
            `INSERT INTO products (shop_origin, slug, url, name, name_normalized, brand, brand_normalized, master_product_id, match_method, first_seen_at, last_updated_at, is_active)
             VALUES ('rohlik.cz', 'rs1', 'http://rs1', 'Ritter Sport', 'ritter sport', 'Ritter Sport', 'ritter sport', 1, 'fuzzy', ?, ?, 1)`,
            [now, now]
        );
        const reg = buildRegistry();
        const search = reg.find((t) => t.name === "shops_search");
        if (!search) {
            throw new Error("expected shops_search in registry");
        }

        const result = await search.handler({ query: "ritter" }, { shopsDb: db });
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain("Ritter Sport");
        db.close();
    });
});
