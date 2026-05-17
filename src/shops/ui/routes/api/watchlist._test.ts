import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase, setShopsDatabaseSingletonForTest } from "@app/shops/db/ShopsDatabase";
import * as watchlistRoute from "@app/shops/ui/routes/api/watchlist";
import * as watchlistAddRoute from "@app/shops/ui/routes/api/watchlist.add";
import { nowUtcIso } from "@app/utils/sql-time";

function tmpDb(): ShopsDatabase {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-api-")), "test.db"));
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`);
    db.raw().exec(
        `INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at)
         VALUES ('test-session', 1, '${nowUtcIso()}', datetime('now','+7 days'), '${nowUtcIso()}')`
    );
    return db;
}

const AUTH_COOKIE = "shops_session=test-session";

interface RouteWithHandlers {
    options: {
        server?: {
            handlers?: {
                GET?: (ctx: { request: Request }) => Promise<Response>;
                POST?: (ctx: { request: Request }) => Promise<Response>;
            };
        };
    };
}

function getGetHandler(route: { Route: unknown }): (ctx: { request: Request }) => Promise<Response> {
    const r = route.Route as RouteWithHandlers;
    const handler = r.options.server?.handlers?.GET;
    if (!handler) {
        throw new Error("Route has no GET handler");
    }

    return handler;
}

function getPostHandler(route: { Route: unknown }): (ctx: { request: Request }) => Promise<Response> {
    const r = route.Route as RouteWithHandlers;
    const handler = r.options.server?.handlers?.POST;
    if (!handler) {
        throw new Error("Route has no POST handler");
    }

    return handler;
}

describe("GET /api/watchlist returns rows", () => {
    it("yields an empty array when no favorites", async () => {
        const db = tmpDb();
        setShopsDatabaseSingletonForTest(db);
        const handler = getGetHandler(watchlistRoute);
        const res = await handler({
            request: new Request("http://test/api/watchlist", { headers: { Cookie: AUTH_COOKIE } }),
        });
        const body = await res.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body).toHaveLength(0);
        setShopsDatabaseSingletonForTest(null);
        db.close();
    });

    it("returns 401 without session cookie", async () => {
        const db = tmpDb();
        setShopsDatabaseSingletonForTest(db);
        const handler = getGetHandler(watchlistRoute);
        const res = await handler({ request: new Request("http://test/api/watchlist") });
        expect(res.status).toBe(401);
        setShopsDatabaseSingletonForTest(null);
        db.close();
    });
});

describe("POST /api/watchlist/add validates required url", () => {
    it("returns 400 when url is missing", async () => {
        const db = tmpDb();
        setShopsDatabaseSingletonForTest(db);
        const handler = getPostHandler(watchlistAddRoute);
        const res = await handler({
            request: new Request("http://test/api/watchlist/add", {
                method: "POST",
                body: '{"foo":"bar"}',
                headers: { "Content-Type": "application/json", Cookie: AUTH_COOKIE },
            }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain("url");
        setShopsDatabaseSingletonForTest(null);
        db.close();
    });
});
