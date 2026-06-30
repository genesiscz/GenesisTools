import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@app/utils/database/migrations";
import { runDoctor } from "./doctor";
import { STASH_MIGRATIONS } from "./stash-migrations";
import { StashStorage } from "./storage";
import { StoreRepo } from "./store-repo";

let work: string;
let origRoot: string | undefined;

beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "stash-doctor-test-"));
    origRoot = process.env.GENESIS_TOOLS_STASH_ROOT;
    process.env.GENESIS_TOOLS_STASH_ROOT = work;
});

afterEach(async () => {
    if (origRoot !== undefined) {
        process.env.GENESIS_TOOLS_STASH_ROOT = origRoot;
    } else {
        delete process.env.GENESIS_TOOLS_STASH_ROOT;
    }

    await rm(work, { recursive: true, force: true });
});

// Three-hunk patch used by multiple tests.
const FAKE_PATCH = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,1 +1,3 @@",
    " base",
    "+added1",
    "+added2",
    "@@ -10,1 +12,2 @@",
    " ctx",
    "+added3",
    "@@ -20,1 +23,2 @@",
    " ctx2",
    "+added4",
    "",
].join("\n");

function buildDb(): Database {
    const db = new Database(":memory:");
    runMigrations(
        db,
        STASH_MIGRATIONS.filter((m) => m.id === "001-initial-schema"),
        { tableName: "stash" }
    );
    return db;
}

describe("runDoctor", () => {
    test("clean DB with initialized store — no issues", async () => {
        const storage = new StashStorage();
        const repo = new StoreRepo(storage.storeRepoDir());
        await repo.init();

        const db = buildDb();
        const result = await runDoctor({ db, storage, rebuild: false });

        expect(result.issues).toHaveLength(0);
        expect(result.healed).toBe(0);
    });

    test("missing store ref — reports error on versions category", async () => {
        const storage = new StashStorage();
        const repo = new StoreRepo(storage.storeRepoDir());
        await repo.init();

        const db = buildDb();
        db.run(
            "INSERT INTO stashes (id, name, created_at, updated_at) VALUES ('s1', 'ghost', '2026-06-25', '2026-06-25')"
        );
        db.run(
            "INSERT INTO versions (id, stash_id, version, patch_ref, region_count, file_count, metadata_json, created_at) VALUES ('v1', 's1', 1, 'refs/stashes/s1/v1', 0, 0, '{}', '2026-06-25')"
        );

        const result = await runDoctor({ db, storage, rebuild: false });

        const versionErrors = result.issues.filter((i) => i.severity === "error" && i.category === "versions");
        expect(versionErrors).toHaveLength(1);
        expect(versionErrors[0]?.message).toContain("refs/stashes/s1/v1");
        expect(versionErrors[0]?.ref).toBe("v1");
    });

    test("orphan active application with null version_id — reports warn", async () => {
        const storage = new StashStorage();
        const repo = new StoreRepo(storage.storeRepoDir());
        await repo.init();

        const db = buildDb();
        db.run(
            "INSERT INTO stashes (id, name, created_at, updated_at) VALUES ('s1', 'orphaned', '2026-06-25', '2026-06-25')"
        );
        // Insert an application with null version_id (simulates what happens after drop --all-versions --orphan-active)
        db.run(
            "INSERT INTO applications (id, stash_id, version_id, project_path, applied_at, state) VALUES ('a1', 's1', NULL, '/some/project', '2026-06-25', 'active')"
        );

        const result = await runDoctor({ db, storage, rebuild: false });

        const warns = result.issues.filter((i) => i.severity === "warn" && i.category === "applications");
        expect(warns).toHaveLength(1);
        expect(warns[0]?.message).toContain("a1");
        expect(warns[0]?.ref).toBe("a1");
    });

    test("--rebuild populates regions from stored patches", async () => {
        const storage = new StashStorage();
        const repo = new StoreRepo(storage.storeRepoDir());
        await repo.init();

        const ref = "refs/stashes/s1/v1";
        await repo.writePatchCommit({ ref, files: { "PATCH.diff": FAKE_PATCH }, message: "test" });

        const db = buildDb();
        db.run(
            "INSERT INTO stashes (id, name, created_at, updated_at) VALUES ('s1', 'mypatch', '2026-06-25', '2026-06-25')"
        );
        db.run(
            "INSERT INTO versions (id, stash_id, version, patch_ref, region_count, file_count, metadata_json, created_at) VALUES ('v1', 's1', 1, ?, 0, 1, '{}', '2026-06-25')",
            [ref]
        );
        // Start with empty regions table
        expect(db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM regions").get()?.c).toBe(0);

        const result = await runDoctor({ db, storage, rebuild: true });

        expect(result.healed).toBeGreaterThan(0);
        const regionCount = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM regions").get()?.c;
        expect(regionCount).toBe(result.healed);
        // FAKE_PATCH has 3 hunks → 3 regions
        expect(result.healed).toBe(3);
    });
});
