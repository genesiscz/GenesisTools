import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { assertSchemaCompatible } from "@app/shops/lib/schema-preflight";

function tmpDb(): ShopsDatabase {
    return new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-preflight-")), "test.db"));
}

describe("assertSchemaCompatible", () => {
    it("passes on a fresh Plan 01 schema", () => {
        const db = tmpDb();
        expect(() => assertSchemaCompatible(db)).not.toThrow();
        db.close();
    });

    it("throws when notifications.delivered_macos_at column is missing", () => {
        const db = tmpDb();
        db.raw().exec("ALTER TABLE notifications DROP COLUMN delivered_macos_at");
        expect(() => assertSchemaCompatible(db)).toThrow(/delivered_macos_at/);
        db.close();
    });

    it("throws when brand_aliases table is missing", () => {
        const db = tmpDb();
        db.raw().exec("DROP TABLE brand_aliases");
        expect(() => assertSchemaCompatible(db)).toThrow(/brand_aliases/);
        db.close();
    });

    it("throws when favorites.master_product_id is nullable", () => {
        const db = tmpDb();
        db.raw().exec("DROP TABLE favorites");
        db.raw().exec(`CREATE TABLE favorites (
            id INTEGER PRIMARY KEY,
            master_product_id INTEGER REFERENCES master_products(id),
            restricted_to_shop TEXT,
            created_at TEXT NOT NULL
        )`);
        expect(() => assertSchemaCompatible(db)).toThrow(/master_product_id.*NOT NULL/);
        db.close();
    });
});
