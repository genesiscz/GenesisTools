import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { getPendingMigrations, type Migration, runMigrations } from "./migrations";

const noopMigration: Migration = {
    id: "noop",
    description: "no-op for tests",
    apply: () => {},
};

describe("runMigrations", () => {
    it("returns empty applied/skipped on empty list", () => {
        const db = new Database(":memory:");
        const r = runMigrations(db, [], { tableName: "t" });
        expect(r.applied).toEqual([]);
        expect(r.skipped).toEqual([]);
        db.close();
    });

    it("applies migrations once and skips on second run (default isApplied)", () => {
        const db = new Database(":memory:");
        const m: Migration = {
            id: "create-foo",
            description: "create foo table",
            apply(db) {
                db.run("CREATE TABLE foo (x INTEGER)");
            },
        };
        const r1 = runMigrations(db, [m], { tableName: "t" });
        expect(r1.applied).toEqual(["create-foo"]);
        expect(r1.skipped).toEqual([]);

        const r2 = runMigrations(db, [m], { tableName: "t" });
        expect(r2.applied).toEqual([]);
        expect(r2.skipped).toEqual(["create-foo"]);
        db.close();
    });

    it("uses custom isApplied when provided", () => {
        const db = new Database(":memory:");
        let applyCalls = 0;
        const m: Migration = {
            id: "custom-check",
            description: "...",
            isApplied(db) {
                const exists = db.query("SELECT name FROM sqlite_master WHERE name='bar'").get();
                return exists !== null;
            },
            apply(db) {
                applyCalls++;
                db.run("CREATE TABLE bar (x INTEGER)");
            },
        };

        runMigrations(db, [m], { tableName: "t" });
        runMigrations(db, [m], { tableName: "t" });
        expect(applyCalls).toBe(1);
        db.close();
    });

    it("scopes the default isApplied check by tableName", () => {
        const db = new Database(":memory:");
        const m: Migration = { id: "shared", description: "shared", apply: () => {} };

        runMigrations(db, [m], { tableName: "indexA" });
        const r2 = runMigrations(db, [m], { tableName: "indexB" });
        // Same migration id but different table: should apply for indexB.
        expect(r2.applied).toEqual(["shared"]);
        db.close();
    });

    it("creates _migrations table on first call", () => {
        const db = new Database(":memory:");
        runMigrations(db, [noopMigration], { tableName: "t" });
        const exists = db.query("SELECT name FROM sqlite_master WHERE name='_migrations'").get();
        expect(exists).not.toBeNull();
        db.close();
    });

    it("records applied_at + ms in journal row", () => {
        const db = new Database(":memory:");
        const m: Migration = {
            id: "slow",
            description: "...",
            apply: () => {
                // Tiny but non-zero
            },
        };
        const before = Date.now();
        runMigrations(db, [m], { tableName: "t" });
        const after = Date.now();

        const row = db.query("SELECT id, applied_at, ms FROM _migrations").get() as {
            id: string;
            applied_at: number;
            ms: number;
        };
        expect(row.id).toBe("t:slow");
        expect(row.applied_at).toBeGreaterThanOrEqual(before);
        expect(row.applied_at).toBeLessThanOrEqual(after);
        expect(typeof row.ms).toBe("number");
        db.close();
    });

    it("rolls back migration DDL when apply throws", () => {
        const db = new Database(":memory:");
        const m: Migration = {
            id: "half-applied",
            description: "create then fail",
            apply(db) {
                db.run("CREATE TABLE half_applied (x INTEGER)");
                throw new Error("boom after ddl");
            },
        };

        expect(() => runMigrations(db, [m], { tableName: "t" })).toThrow("boom after ddl");

        const table = db.query("SELECT name FROM sqlite_master WHERE name = 'half_applied'").get();
        const row = db.query("SELECT id FROM _migrations WHERE id = 't:half-applied'").get();
        expect(table).toBeNull();
        expect(row).toBeNull();
        db.close();
    });
});

describe("getPendingMigrations", () => {
    it("returns full list when nothing applied", () => {
        const db = new Database(":memory:");
        const ms: Migration[] = [
            { id: "a", description: "", apply: () => {} },
            { id: "b", description: "", apply: () => {} },
        ];
        const pending = getPendingMigrations(db, ms, { tableName: "t" });
        expect(pending.map((m) => m.id)).toEqual(["a", "b"]);
        db.close();
    });

    it("returns only unapplied migrations", () => {
        const db = new Database(":memory:");
        const ms: Migration[] = [
            { id: "a", description: "", apply: () => {} },
            { id: "b", description: "", apply: () => {} },
        ];
        runMigrations(db, [ms[0]], { tableName: "t" });
        const pending = getPendingMigrations(db, ms, { tableName: "t" });
        expect(pending.map((m) => m.id)).toEqual(["b"]);
        db.close();
    });
});
