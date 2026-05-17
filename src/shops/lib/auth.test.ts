import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { getSessionUser, parseCookies, randomToken, SESSION_COOKIE_NAME } from "@app/shops/lib/auth";
import { nowUtcIso } from "@app/utils/sql-time";

function freshDb(): ShopsDatabase {
    const dir = mkdtempSync(join(tmpdir(), "shops-auth-"));
    return new ShopsDatabase(join(dir, "test.db"));
}

describe("randomToken", () => {
    it("returns a base64url string with at least 40 chars", () => {
        const t = randomToken();
        expect(t.length).toBeGreaterThanOrEqual(40);
        expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("is unique across calls", () => {
        expect(randomToken()).not.toBe(randomToken());
    });
});

describe("parseCookies", () => {
    it("returns empty object on null/empty header", () => {
        expect(parseCookies(null)).toEqual({});
        expect(parseCookies("")).toEqual({});
    });

    it("parses single + multiple cookies", () => {
        expect(parseCookies("a=1")).toEqual({ a: "1" });
        expect(parseCookies("a=1; b=2; c=hello")).toEqual({ a: "1", b: "2", c: "hello" });
    });

    it("URL-decodes values", () => {
        expect(parseCookies("a=%2Fpath%3D")).toEqual({ a: "/path=" });
    });
});

describe("getSessionUser", () => {
    it("returns null when no Cookie header", async () => {
        const db = freshDb();
        const req = new Request("http://x/api/foo");
        expect(await getSessionUser(req, db)).toBeNull();
        db.close();
    });

    it("returns null when shops_session cookie missing", async () => {
        const db = freshDb();
        const req = new Request("http://x/api/foo", { headers: { Cookie: "other=1" } });
        expect(await getSessionUser(req, db)).toBeNull();
        db.close();
    });

    it("returns user on valid + unexpired token; touches last_seen_at", async () => {
        const db = freshDb();
        const tok = randomToken();
        db.raw().exec(
            `INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at)
             VALUES ('${tok}', 1, '${nowUtcIso()}', datetime('now','+7 days'), '2020-01-01T00:00:00Z')`
        );
        const req = new Request("http://x/api/foo", { headers: { Cookie: `${SESSION_COOKIE_NAME}=${tok}` } });
        const u = await getSessionUser(req, db);
        expect(u?.id).toBe(1);
        expect(u?.email).toBe("local@local");
        const seen = db
            .raw()
            .query<{ last_seen_at: string }, []>(`SELECT last_seen_at FROM sessions WHERE token = '${tok}'`)
            .get();
        expect(seen?.last_seen_at).not.toBe("2020-01-01T00:00:00Z");
        db.close();
    });

    it("returns null when token expired", async () => {
        const db = freshDb();
        const tok = randomToken();
        db.raw().exec(
            `INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at)
             VALUES ('${tok}', 1, '${nowUtcIso()}', datetime('now','-1 day'), '${nowUtcIso()}')`
        );
        const req = new Request("http://x/api/foo", { headers: { Cookie: `${SESSION_COOKIE_NAME}=${tok}` } });
        expect(await getSessionUser(req, db)).toBeNull();
        db.close();
    });

    it("returns null on unknown token", async () => {
        const db = freshDb();
        const req = new Request("http://x/api/foo", { headers: { Cookie: `${SESSION_COOKIE_NAME}=does-not-exist` } });
        expect(await getSessionUser(req, db)).toBeNull();
        db.close();
    });
});
