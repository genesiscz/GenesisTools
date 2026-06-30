import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@app/utils/database/migrations";
import { STASH_MIGRATIONS } from "./stash-migrations";
import { StashStorage } from "./storage";
import { StoreRepo } from "./store-repo";

let work: string;
let origRoot: string | undefined;

beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "stash-migration-test-"));
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

// Three-hunk patch so the backfill produces exactly 3 region rows.
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

async function setupStoreWithPatch(ref: string, patch: string): Promise<void> {
    const storage = new StashStorage();
    const repo = new StoreRepo(storage.storeRepoDir());
    await repo.init();
    await repo.writePatchCommit({ ref, files: { "PATCH.diff": patch }, message: "test" });
}

function buildDbWithVersion(patchRef: string): Database {
    const db = new Database(":memory:");
    runMigrations(
        db,
        STASH_MIGRATIONS.filter((m) => m.id === "001-initial-schema"),
        { tableName: "stash" }
    );
    db.run("INSERT INTO stashes (id, name, created_at, updated_at) VALUES ('s1', 'test', '2026-06-25', '2026-06-25')");
    db.run(
        "INSERT INTO versions (id, stash_id, version, patch_ref, region_count, file_count, metadata_json, created_at) VALUES (?, 's1', 1, ?, 0, 1, '{}', '2026-06-25')",
        ["v1", patchRef]
    );
    return db;
}

describe("002-populate-regions-table", () => {
    test("backfills 3 region rows from a 3-hunk patch", async () => {
        const ref = "refs/stashes/s1/v1";
        await setupStoreWithPatch(ref, FAKE_PATCH);
        const db = buildDbWithVersion(ref);
        const migration = STASH_MIGRATIONS.find((m) => m.id === "002-populate-regions-table")!;
        migration.apply(db, { tableName: "stash" });
        const count = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM regions WHERE version_id = 'v1'").get();
        expect(count?.c).toBe(3);
    });

    test("idempotent — calling apply twice keeps count at 3", async () => {
        const ref = "refs/stashes/s1/v1";
        await setupStoreWithPatch(ref, FAKE_PATCH);
        const db = buildDbWithVersion(ref);
        const migration = STASH_MIGRATIONS.find((m) => m.id === "002-populate-regions-table")!;
        // First apply: inserts 3 rows
        migration.apply(db, { tableName: "stash" });
        // Second apply: COUNT(*) > 0, so it skips without double-inserting
        migration.apply(db, { tableName: "stash" });
        const count = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM regions").get();
        expect(count?.c).toBe(3);
    });
});
