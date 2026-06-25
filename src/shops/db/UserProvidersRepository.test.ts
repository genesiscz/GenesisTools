import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UserProvidersRepository } from "@app/shops/db/UserProvidersRepository";
import { resetCryptoForTest } from "@app/shops/lib/crypto";
import { env } from "@app/utils/env";

function fresh(): UserProvidersRepository {
    const dir = mkdtempSync(join(tmpdir(), "shops-up-"));
    env.testing.set("SHOPS_SECRET_KEY_PATH", join(dir, ".secret-key"));
    resetCryptoForTest();
    const db = new ShopsDatabase(join(dir, "test.db"));
    db.raw().exec(
        `INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
         VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`
    );
    db.raw().exec(
        `INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
         VALUES ('kosik.cz','Košík.cz','CZK',1,1,1,1,0,'soft')`
    );
    return new UserProvidersRepository(db);
}

describe("UserProvidersRepository", () => {
    it("connect inserts a row and encrypts credentials at rest", async () => {
        const repo = fresh();
        const id = await repo.connect({
            user_id: 1,
            shop_origin: "rohlik.cz",
            credentials: { type: "email-password", email: "a@b", password: "secret" },
            external_user_email: "a@b",
        });
        expect(id).toBeGreaterThan(0);
        const row = await repo.getByShop(1, "rohlik.cz");
        expect(row?.status).toBe("connected");
        expect(row?.credentials_blob).not.toContain("secret");
        const creds = await repo.getCredentials(id);
        expect(creds).toEqual({ type: "email-password", email: "a@b", password: "secret" });
    });

    it("re-connecting same shop UPDATEs in place", async () => {
        const repo = fresh();
        const id1 = await repo.connect({
            user_id: 1,
            shop_origin: "rohlik.cz",
            credentials: { type: "email-password", email: "a@b", password: "x" },
            external_user_email: "a@b",
        });
        const id2 = await repo.connect({
            user_id: 1,
            shop_origin: "rohlik.cz",
            credentials: { type: "email-password", email: "a@b", password: "y" },
            external_user_email: "a@b",
        });
        expect(id2).toBe(id1);
        const creds = await repo.getCredentials(id1);
        expect((creds as { password: string }).password).toBe("y");
    });

    it("disconnect clears the credentials blob", async () => {
        const repo = fresh();
        const id = await repo.connect({
            user_id: 1,
            shop_origin: "rohlik.cz",
            credentials: { type: "email-password", email: "a@b", password: "x" },
            external_user_email: "a@b",
        });
        await repo.disconnect(id);
        const row = await repo.getByShop(1, "rohlik.cz");
        expect(row?.status).toBe("disconnected");
        expect(row?.credentials_blob).toBeNull();
    });

    it("listForUser returns rows joined with shops display_name", async () => {
        const repo = fresh();
        await repo.connect({
            user_id: 1,
            shop_origin: "rohlik.cz",
            credentials: { type: "email-password", email: "a@b", password: "x" },
            external_user_email: "a@b",
        });
        const list = await repo.listForUser(1);
        expect(list.find((r) => r.shop_origin === "rohlik.cz")?.display_name).toBe("Rohlík.cz");
    });

    it("setStatus + setLastSync round-trip", async () => {
        const repo = fresh();
        const id = await repo.connect({
            user_id: 1,
            shop_origin: "rohlik.cz",
            credentials: { type: "email-password", email: "a@b", password: "x" },
            external_user_email: "a@b",
        });
        await repo.setStatus(id, "expired", "session-401");
        await repo.setLastSync(id, "2026-05-10T12:00:00Z");
        const row = await repo.getByShop(1, "rohlik.cz");
        expect(row?.status).toBe("expired");
        // setLastSync clears last_sync_error per spec; status was set before
        expect(row?.last_sync_at).toBe("2026-05-10T12:00:00Z");
    });
});
