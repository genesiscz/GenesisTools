import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openStashDb } from "./stash-db";

describe("openStashDb", () => {
    test("creates all tables on first open", () => {
        const db = new Database(":memory:");
        openStashDb(db);
        const tables = db
            .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all()
            .map((r) => r.name);
        expect(tables).toContain("stashes");
        expect(tables).toContain("versions");
        expect(tables).toContain("regions");
        expect(tables).toContain("applications");
        expect(tables).toContain("projects");
        expect(tables).toContain("_migrations");
    });

    test("idempotent — second open does not error", () => {
        const db = new Database(":memory:");
        openStashDb(db);
        openStashDb(db);
        const count = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM _migrations").get();
        expect(count?.c).toBeGreaterThan(0);
    });

    test("unique active application constraint", () => {
        const db = new Database(":memory:");
        openStashDb(db);
        db.run(
            "INSERT INTO stashes (id, name, created_at, updated_at) VALUES ('s1', 'foo', '2026-01-01', '2026-01-01')"
        );
        db.run(
            "INSERT INTO versions (id, stash_id, version, patch_ref, region_count, file_count, created_at) VALUES ('v1', 's1', 1, 'refs/stashes/s1/v1', 1, 1, '2026-01-01')"
        );
        db.run(
            "INSERT INTO applications (id, stash_id, version_id, project_path, applied_at, state) VALUES ('a1', 's1', 'v1', '/p', '2026-01-01', 'active')"
        );
        expect(() =>
            db.run(
                "INSERT INTO applications (id, stash_id, version_id, project_path, applied_at, state) VALUES ('a2', 's1', 'v1', '/p', '2026-01-01', 'active')"
            )
        ).toThrow();
    });
});
