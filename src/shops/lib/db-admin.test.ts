import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { getDbInfo, listMigrations, vacuumDb } from "@app/shops/lib/db-admin";

function tmpDb(): ShopsDatabase {
    return new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-dbadmin-")), "test.db"));
}

describe("listMigrations", () => {
    it("returns at least the 001-initial migration on a fresh DB", () => {
        const db = tmpDb();
        try {
            const rows = listMigrations(db);
            expect(rows.length).toBeGreaterThan(0);
            expect(rows[0].id).toMatch(/initial/);
            expect(typeof rows[0].applied_at).toBe("number");
        } finally {
            db.close();
        }
    });
});

describe("getDbInfo", () => {
    it("returns DB path + table list with row counts", () => {
        const db = tmpDb();
        try {
            const info = getDbInfo(db);
            expect(info.path).toMatch(/test\.db$/);
            expect(info.tables.length).toBeGreaterThan(0);
            const productsTable = info.tables.find((t) => t.name === "products");
            expect(productsTable).toBeDefined();
            expect(productsTable?.rows).toBe(0);
        } finally {
            db.close();
        }
    });
});

describe("vacuumDb", () => {
    it("runs VACUUM without throwing", () => {
        const db = tmpDb();
        try {
            expect(() => vacuumDb(db)).not.toThrow();
        } finally {
            db.close();
        }
    });
});
