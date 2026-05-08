import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase, setShopsDatabaseSingletonForTest } from "@app/shops/db/ShopsDatabase";
import * as masterRoute from "./master";

function tmpDb(): ShopsDatabase {
    const path = join(mkdtempSync(join(tmpdir(), "shops-master-")), "test.db");
    const db = new ShopsDatabase(path);
    db.raw().exec(`
        INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
        VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none');

        INSERT INTO master_products (id, canonical_name, canonical_name_normalized, canonical_slug, brand, brand_normalized, total_offers, best_price, best_price_shop, best_price_at, created_at, updated_at)
        VALUES
          (1,'Ritter Sport mléčná 100g','ritter sport mlecna 100g','ritter-sport-mlecna-100g','Ritter Sport','ritter sport',2,49.9,'rohlik.cz','2026-05-08T10:00:00Z','2026-05-08T10:00:00Z','2026-05-08T10:00:00Z'),
          (2,'Coca-Cola 1.5L','coca cola 1500ml','coca-cola-1-5l','Coca-Cola','coca cola',5,29.9,'rohlik.cz','2026-05-08T10:00:00Z','2026-05-08T10:00:00Z','2026-05-08T10:00:00Z');
    `);
    return db;
}

interface RouteWithHandlers {
    options: {
        server?: {
            handlers?: {
                GET?: (ctx: { request: Request }) => Promise<Response>;
            };
        };
    };
}

function getHandler(route: { Route: unknown }): (ctx: { request: Request }) => Promise<Response> {
    const r = route.Route as RouteWithHandlers;
    const handler = r.options.server?.handlers?.GET;
    if (!handler) {
        throw new Error("Route has no GET handler");
    }

    return handler;
}

describe("GET /api/master", () => {
    it("returns all masters paginated", async () => {
        setShopsDatabaseSingletonForTest(tmpDb());
        const handler = getHandler(masterRoute);
        const res = await handler({ request: new Request("http://test/api/master?limit=10") });
        const body = await res.json();
        expect(body.total).toBe(2);
        expect(body.items.length).toBe(2);
        expect(body.items[0].canonical_name).toBeDefined();
        setShopsDatabaseSingletonForTest(null);
    });

    it("filters by brand", async () => {
        setShopsDatabaseSingletonForTest(tmpDb());
        const handler = getHandler(masterRoute);
        const res = await handler({
            request: new Request("http://test/api/master?brand=Ritter%20Sport"),
        });
        const body = await res.json();
        expect(body.total).toBe(1);
        expect(body.items[0].brand).toBe("Ritter Sport");
        setShopsDatabaseSingletonForTest(null);
    });

    it("rejects invalid limit", async () => {
        setShopsDatabaseSingletonForTest(tmpDb());
        const handler = getHandler(masterRoute);
        const res = await handler({ request: new Request("http://test/api/master?limit=abc") });
        expect(res.status).toBe(400);
        setShopsDatabaseSingletonForTest(null);
    });
});
