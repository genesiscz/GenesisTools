import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runMigrations } from "@app/utils/database/migrations";
import { FILE_META_MIGRATION_CONTEXT, FILE_META_MIGRATIONS } from "./file-meta-migrations";

describe("file-meta-migrations", () => {
    it("creates file_meta table with required columns and STRICT typing", () => {
        const db = new Database(":memory:");
        runMigrations(db, FILE_META_MIGRATIONS, FILE_META_MIGRATION_CONTEXT);
        const cols = db.query<{ name: string }, []>("PRAGMA table_info(file_meta)").all();
        const names = cols.map((c) => c.name).sort();
        expect(names).toEqual(["clone_id", "last_seen_at", "mtime_ns", "path", "prefix_hash", "sha256", "size"]);

        // path is the PK — verify it's marked NOT NULL via PRAGMA.
        const pathCol = db
            .query<{ name: string; pk: number; notnull: number }, []>("PRAGMA table_info(file_meta)")
            .all()
            .find((c) => c.name === "path");
        expect(pathCol?.pk).toBe(1);
        expect(pathCol?.notnull).toBe(1);
    });

    it("creates idx_file_meta_last_seen index", () => {
        const db = new Database(":memory:");
        runMigrations(db, FILE_META_MIGRATIONS, FILE_META_MIGRATION_CONTEXT);
        const idx = db
            .query<{ name: string }, []>(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_file_meta_last_seen'"
            )
            .get();
        expect(idx?.name).toBe("idx_file_meta_last_seen");
    });

    it("is idempotent (re-run is a no-op)", () => {
        const db = new Database(":memory:");
        const r1 = runMigrations(db, FILE_META_MIGRATIONS, FILE_META_MIGRATION_CONTEXT);
        expect(r1.applied).toContain("2026-05-init-file-meta");
        const r2 = runMigrations(db, FILE_META_MIGRATIONS, FILE_META_MIGRATION_CONTEXT);
        expect(r2.applied).not.toContain("2026-05-init-file-meta");
        expect(r2.skipped).toContain("2026-05-init-file-meta");
    });

    it("STRICT mode rejects non-integer size", () => {
        const db = new Database(":memory:");
        runMigrations(db, FILE_META_MIGRATIONS, FILE_META_MIGRATION_CONTEXT);
        expect(() =>
            db.run(
                "INSERT INTO file_meta (path, size, mtime_ns, sha256, clone_id, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
                ["/a/b", "not-a-number", 1n, "x", "", 1n]
            )
        ).toThrow();
    });

    it("creates dir_meta table with required columns and STRICT typing", () => {
        const db = new Database(":memory:");
        runMigrations(db, FILE_META_MIGRATIONS, FILE_META_MIGRATION_CONTEXT);
        const cols = db.query<{ name: string; pk: number; notnull: number }, []>("PRAGMA table_info(dir_meta)").all();
        const names = cols.map((c) => c.name).sort();
        expect(names).toEqual(["child_names_json", "dir_mtime_ns", "ino", "last_seen_at", "path"]);
        const pathCol = cols.find((c) => c.name === "path");
        expect(pathCol?.pk).toBe(1);
        expect(pathCol?.notnull).toBe(1);
    });

    it("dir_meta migration is idempotent (re-run is a no-op)", () => {
        const db = new Database(":memory:");
        runMigrations(db, FILE_META_MIGRATIONS, FILE_META_MIGRATION_CONTEXT);
        const r2 = runMigrations(db, FILE_META_MIGRATIONS, FILE_META_MIGRATION_CONTEXT);
        expect(r2.applied).not.toContain("2026-05-init-dir-meta");
        expect(r2.skipped).toContain("2026-05-init-dir-meta");
    });

    it("preserves mtime_ns past Number.MAX_SAFE_INTEGER (safeIntegers prerequisite)", () => {
        // bun:sqlite exposes safeIntegers only as a constructor option, not a
        // runtime method. Verifies the schema-side prerequisite for the
        // FileMetaCache: when the driver returns bigints, the schema
        // round-trips them losslessly.
        const db = new Database(":memory:", { safeIntegers: true });
        runMigrations(db, FILE_META_MIGRATIONS, FILE_META_MIGRATION_CONTEXT);
        const giantMtime = 1779296558123456789n; // APFS-scale ns, > 2^53
        db.run(
            "INSERT INTO file_meta (path, size, mtime_ns, sha256, clone_id, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
            ["/giant", 1n, giantMtime, "x", "", 1n]
        );
        const row = db.query<{ mtime_ns: bigint }, []>("SELECT mtime_ns FROM file_meta WHERE path='/giant'").get();
        expect(row?.mtime_ns).toBe(giantMtime);
    });
});
