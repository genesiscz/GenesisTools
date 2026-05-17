import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { migration001 } from "@app/shops/db/migrations/001-initial";
import { migration002 } from "@app/shops/db/migrations/002-descriptions";
import { migration003 } from "@app/shops/db/migrations/003-providers";
import { migration004 } from "@app/shops/db/migrations/004-auth";
import { migration005 } from "@app/shops/db/migrations/005-favorites-unique";
import { runMigrations } from "@app/utils/database/migrations";

const ALL = [migration001, migration002, migration003, migration004, migration005];

function seedMaster(db: Database): void {
    db.exec(
        `INSERT INTO master_products (id, canonical_name, canonical_name_normalized, canonical_slug, created_at, updated_at)
         VALUES (1,'X','x','x', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    );
}

describe("migration005-favorites-unique", () => {
    it("creates the COALESCE-based UNIQUE INDEX on favorites", () => {
        const db = new Database(":memory:");
        runMigrations(db, ALL, { tableName: "shops" });
        const idx = db
            .query<{ name: string }, []>(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_favorites_user_master_shop_unique'"
            )
            .get();
        expect(idx?.name).toBe("idx_favorites_user_master_shop_unique");
        db.close();
    });

    it("rejects duplicate (user_id, master_product_id, NULL restricted_to_shop) at DB layer", () => {
        const db = new Database(":memory:");
        runMigrations(db, ALL, { tableName: "shops" });
        seedMaster(db);
        db.exec(
            `INSERT INTO favorites (master_product_id, cooldown_hours, user_id, created_at)
             VALUES (1, 24, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        );
        expect(() =>
            db.exec(
                `INSERT INTO favorites (master_product_id, cooldown_hours, user_id, created_at)
                 VALUES (1, 24, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
            )
        ).toThrow(/UNIQUE/);
        db.close();
    });

    it("permits the same (user, master) for two different users", () => {
        const db = new Database(":memory:");
        runMigrations(db, ALL, { tableName: "shops" });
        seedMaster(db);
        db.exec(
            `INSERT INTO users (email, display_name, created_at, updated_at)
             VALUES ('b@x','b', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        );
        db.exec(
            `INSERT INTO favorites (master_product_id, cooldown_hours, user_id, created_at)
             VALUES (1, 24, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        );
        db.exec(
            `INSERT INTO favorites (master_product_id, cooldown_hours, user_id, created_at)
             VALUES (1, 24, 2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        );
        const c = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM favorites").get();
        expect(c?.c).toBe(2);
        db.close();
    });
});
