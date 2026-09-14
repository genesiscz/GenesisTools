import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

/**
 * Migration 0001 adds the unique index on `subscriptions.account_id`. Its whole premise is that
 * duplicates can ALREADY exist — `ensureSubscription` was a check-then-insert with nothing behind
 * it — so the migration has to collapse them first or it simply fails on any database that has
 * them. This applies the real SQL to a database seeded with duplicates and checks which row lives.
 */

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

function applyMigration(db: Database.Database, tag: string): void {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, `${tag}.sql`), "utf8");

    for (const statement of sql.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();

        if (trimmed.length > 0) {
            db.exec(trimmed);
        }
    }
}

function seeded(): Database.Database {
    const db = new Database(":memory:");
    applyMigration(db, "0000_true_energizer");
    db.exec("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('u1','u','u@example.com',0,0,0)");
    return db;
}

function insertSubscription(
    db: Database.Database,
    row: { id: string; tier: string; stripeSubscriptionId?: string; stripeCustomerId?: string; createdAt: string }
): void {
    db.prepare(
        `INSERT INTO subscriptions (id, account_id, tier, status, stripe_customer_id, stripe_subscription_id, current_period_end, created_at)
         VALUES (?, 'u1', ?, 'active', ?, ?, NULL, ?)`
    ).run(row.id, row.tier, row.stripeCustomerId ?? null, row.stripeSubscriptionId ?? null, row.createdAt);
}

function survivors(db: Database.Database): { id: string; tier: string }[] {
    return db.prepare("SELECT id, tier FROM subscriptions WHERE account_id = 'u1'").all() as {
        id: string;
        tier: string;
    }[];
}

describe("migration 0001 — unique subscriptions.account_id", () => {
    it("applies cleanly to a database with no duplicates", () => {
        const db = seeded();
        insertSubscription(db, { id: "only", tier: "free", createdAt: "2026-01-01" });

        expect(() => applyMigration(db, "0001_nervous_maggott")).not.toThrow();
        expect(survivors(db).map((r) => r.id)).toEqual(["only"]);
        db.close();
    });

    it("collapses duplicates instead of failing on the index", () => {
        const db = seeded();
        insertSubscription(db, { id: "a", tier: "free", createdAt: "2026-01-01" });
        insertSubscription(db, { id: "b", tier: "free", createdAt: "2026-01-02" });
        insertSubscription(db, { id: "c", tier: "free", createdAt: "2026-01-03" });

        expect(() => applyMigration(db, "0001_nervous_maggott")).not.toThrow();
        // Oldest wins when nothing else distinguishes them.
        expect(survivors(db).map((r) => r.id)).toEqual(["a"]);
        db.close();
    });

    it("keeps the row a Stripe webhook can still address", () => {
        const db = seeded();
        insertSubscription(db, { id: "older-plain", tier: "free", createdAt: "2026-01-01" });
        insertSubscription(db, { id: "stripe", tier: "pro", stripeSubscriptionId: "sub_1", createdAt: "2026-01-05" });

        applyMigration(db, "0001_nervous_maggott");

        expect(survivors(db).map((r) => r.id)).toEqual(["stripe"]);
        db.close();
    });

    it("never promotes a free row over a paid one", () => {
        const db = seeded();
        insertSubscription(db, { id: "free-older", tier: "free", createdAt: "2026-01-01" });
        insertSubscription(db, { id: "paid", tier: "pro", createdAt: "2026-01-09" });

        applyMigration(db, "0001_nervous_maggott");

        expect(survivors(db)).toEqual([{ id: "paid", tier: "pro" }]);
        db.close();
    });

    it("leaves separate accounts alone", () => {
        const db = seeded();
        db.exec("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('u2','v','v@example.com',0,0,0)");
        insertSubscription(db, { id: "a", tier: "free", createdAt: "2026-01-01" });
        db.prepare(
            `INSERT INTO subscriptions (id, account_id, tier, status, stripe_customer_id, stripe_subscription_id, current_period_end, created_at)
             VALUES ('other', 'u2', 'free', 'active', NULL, NULL, NULL, '2026-01-01')`
        ).run();

        applyMigration(db, "0001_nervous_maggott");

        const all = db.prepare("SELECT id FROM subscriptions ORDER BY id").all() as { id: string }[];
        expect(all.map((r) => r.id)).toEqual(["a", "other"]);
        db.close();
    });
});
