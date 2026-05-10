import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { migration001 } from "@app/shops/db/migrations/001-initial";
import { migration002 } from "@app/shops/db/migrations/002-descriptions";
import { migration003 } from "@app/shops/db/migrations/003-providers";
import { migration004 } from "@app/shops/db/migrations/004-auth";
import { runMigrations } from "@app/utils/database/migrations";

const ALL = [migration001, migration002, migration003, migration004];

describe("migration004-auth", () => {
    it("creates sessions table + adds user_id columns + backfills existing rows", () => {
        const db = new Database(":memory:");
        runMigrations(db, [migration001, migration002, migration003], { tableName: "shops" });
        db.exec(
            `INSERT INTO master_products (id, canonical_name, canonical_name_normalized, canonical_slug, created_at, updated_at)
             VALUES (1,'X','x','x', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        );
        db.exec(
            `INSERT INTO favorites (master_product_id, cooldown_hours, created_at)
             VALUES (1, 24, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        );
        runMigrations(db, [migration004], { tableName: "shops" });

        const tables = db
            .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
            .all()
            .map((r) => r.name);
        expect(tables).toContain("sessions");

        const favRow = db
            .query<{ user_id: number }, []>("SELECT user_id FROM favorites WHERE master_product_id = 1")
            .get();
        expect(favRow?.user_id).toBe(1);

        const colInfo = db
            .query<{ name: string; dflt_value: string | null; notnull: number }, []>("PRAGMA table_info(notifications)")
            .all();
        const userIdCol = colInfo.find((c) => c.name === "user_id");
        expect(userIdCol).toBeDefined();
        expect(userIdCol?.notnull).toBe(1);
        db.close();
    });

    it("sessions FK on user_id cascades on user delete", () => {
        const db = new Database(":memory:");
        runMigrations(db, ALL, { tableName: "shops" });
        db.exec("PRAGMA foreign_keys = ON;");
        db.exec(
            `INSERT INTO users (email, display_name, created_at, updated_at)
             VALUES ('a@b','A', datetime('now'), datetime('now'))`
        );
        const userRow = db.query<{ id: number }, []>("SELECT id FROM users WHERE email = 'a@b'").get();
        const userId = userRow?.id ?? 0;
        db.exec(
            `INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at)
             VALUES ('tok-x', ${userId}, datetime('now'), datetime('now','+7 days'), datetime('now'))`
        );
        db.exec(`DELETE FROM users WHERE id = ${userId}`);
        const remaining = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sessions WHERE token='tok-x'").get();
        expect(remaining?.c).toBe(0);
        db.close();
    });
});
