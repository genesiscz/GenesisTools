import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase, setShopsDatabaseSingletonForTest } from "../../../db/ShopsDatabase";
import * as watchlistRoute from "./watchlist";
import * as watchlistAddRoute from "./watchlist.add";

function tmpDb(): ShopsDatabase {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-api-")), "test.db"));
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`);
    return db;
}

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
        const res = await handler({ request: new Request("http://test/api/watchlist") });
        const body = await res.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body).toHaveLength(0);
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
                headers: { "Content-Type": "application/json" },
            }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain("url");
        setShopsDatabaseSingletonForTest(null);
        db.close();
    });
});
