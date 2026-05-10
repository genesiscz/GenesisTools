import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setShopsDatabaseSingletonForTest, ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { authedApiHandler, clearSessionCookie, setSessionCookie } from "@app/shops/ui/server/auth-handler";
import { nowUtcIso } from "@app/utils/sql-time";

function fixture(): ShopsDatabase {
    const dir = mkdtempSync(join(tmpdir(), "shops-auth-h-"));
    const db = new ShopsDatabase(join(dir, "test.db"));
    setShopsDatabaseSingletonForTest(db);
    db.raw().exec(
        `INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at)
         VALUES ('good-tok', 1, '${nowUtcIso()}', datetime('now','+7 days'), '${nowUtcIso()}')`
    );
    return db;
}

afterEach(() => {
    setShopsDatabaseSingletonForTest(null);
});

describe("authedApiHandler", () => {
    it("returns 401 when no cookie", async () => {
        fixture();
        const handler = authedApiHandler(async () => Response.json({ ok: true }));
        const res = await handler({ request: new Request("http://x/api/foo") });
        expect(res.status).toBe(401);
    });

    it("invokes inner handler with userId on valid cookie", async () => {
        fixture();
        let seenUserId = 0;
        const handler = authedApiHandler(async (_req, userId) => {
            seenUserId = userId;
            return Response.json({ ok: true });
        });
        const res = await handler({
            request: new Request("http://x/api/foo", { headers: { Cookie: "shops_session=good-tok" } }),
        });
        expect(res.status).toBe(200);
        expect(seenUserId).toBe(1);
    });

    it("returns 401 on unknown token", async () => {
        fixture();
        const handler = authedApiHandler(async () => Response.json({ ok: true }));
        const res = await handler({
            request: new Request("http://x/api/foo", { headers: { Cookie: "shops_session=does-not-exist" } }),
        });
        expect(res.status).toBe(401);
    });

    it("forwards 500 from inner errors", async () => {
        fixture();
        const handler = authedApiHandler(async () => {
            throw new Error("boom");
        });
        const res = await handler({
            request: new Request("http://x/api/foo", { headers: { Cookie: "shops_session=good-tok" } }),
        });
        expect(res.status).toBe(500);
    });
});

describe("setSessionCookie / clearSessionCookie", () => {
    it("setSessionCookie sets the httpOnly cookie with path, samesite, max-age", () => {
        const headers = new Headers();
        setSessionCookie(headers, "tok-1", 7);
        const sc = headers.get("Set-Cookie");
        expect(sc).toContain("shops_session=tok-1");
        expect(sc).toContain("HttpOnly");
        expect(sc).toContain("SameSite=Lax");
        expect(sc).toContain("Path=/");
        expect(sc).toMatch(/Max-Age=\d+/);
    });

    it("clearSessionCookie sets Max-Age=0", () => {
        const headers = new Headers();
        clearSessionCookie(headers);
        const sc = headers.get("Set-Cookie");
        expect(sc).toContain("shops_session=");
        expect(sc).toContain("Max-Age=0");
    });
});
