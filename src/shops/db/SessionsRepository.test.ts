import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionsRepository } from "@app/shops/db/SessionsRepository";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";

function fresh(): { db: ShopsDatabase; repo: SessionsRepository } {
    const dir = mkdtempSync(join(tmpdir(), "shops-sessions-"));
    const db = new ShopsDatabase(join(dir, "test.db"));
    return { db, repo: new SessionsRepository(db) };
}

describe("SessionsRepository", () => {
    it("create returns the inserted token + ttl in the future", async () => {
        const { db, repo } = fresh();
        const session = await repo.create({ userId: 1, ttlDays: 7 });
        expect(session.token.length).toBeGreaterThan(20);
        expect(new Date(session.expires_at).getTime()).toBeGreaterThan(Date.now());
        db.close();
    });

    it("findByToken returns session, undefined after delete", async () => {
        const { db, repo } = fresh();
        const s = await repo.create({ userId: 1, ttlDays: 7 });
        const found = await repo.findByToken(s.token);
        expect(found?.user_id).toBe(1);
        await repo.delete(s.token);
        expect(await repo.findByToken(s.token)).toBeUndefined();
        db.close();
    });

    it("deleteExpired prunes only past-expiry tokens", async () => {
        const { db, repo } = fresh();
        const live = await repo.create({ userId: 1, ttlDays: 7 });
        db.raw().exec(
            `INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at)
             VALUES ('dead', 1, datetime('now','-30 days'), datetime('now','-1 day'), datetime('now','-30 days'))`
        );
        const removed = await repo.deleteExpired();
        expect(removed).toBe(1);
        expect(await repo.findByToken(live.token)).toBeDefined();
        expect(await repo.findByToken("dead")).toBeUndefined();
        db.close();
    });
});
