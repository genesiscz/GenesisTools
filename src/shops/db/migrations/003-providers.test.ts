import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { migration001 } from "@app/shops/db/migrations/001-initial";
import { migration002 } from "@app/shops/db/migrations/002-descriptions";
import { migration003 } from "@app/shops/db/migrations/003-providers";
import { runMigrations } from "@app/utils/database/migrations";

describe("migration003-providers", () => {
    it("creates users, user_providers, user_orders, user_order_items + seeds default user", () => {
        const db = new Database(":memory:");
        runMigrations(db, [migration001, migration002, migration003], { tableName: "shops" });

        const tables = db
            .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all()
            .map((r) => r.name);
        expect(tables).toContain("users");
        expect(tables).toContain("user_providers");
        expect(tables).toContain("user_orders");
        expect(tables).toContain("user_order_items");

        const local = db.query<{ id: number; email: string }, []>("SELECT id, email FROM users WHERE id = 1").get();
        expect(local).toEqual({ id: 1, email: "local@local" });
        db.close();
    });

    it("user_providers UNIQUE(user_id, shop_origin) is enforced", () => {
        const db = new Database(":memory:");
        runMigrations(db, [migration001, migration002, migration003], { tableName: "shops" });
        db.exec(
            `INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
             VALUES ('rohlik.cz','R','CZK',1,1,1,1,1,'none')`
        );
        db.exec(
            `INSERT INTO user_providers (user_id, shop_origin, status, created_at, updated_at)
             VALUES (1,'rohlik.cz','connected', datetime('now'), datetime('now'))`
        );
        expect(() =>
            db.exec(
                `INSERT INTO user_providers (user_id, shop_origin, status, created_at, updated_at)
                 VALUES (1,'rohlik.cz','connected', datetime('now'), datetime('now'))`
            )
        ).toThrow(/UNIQUE/);
        db.close();
    });
});
