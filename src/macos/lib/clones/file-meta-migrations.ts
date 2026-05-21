import type { Migration } from "@app/utils/database/migrations";

/** Pinned migration-context tableName. The default deriveScope is path-based,
 *  so a worktree-relative DB path would invalidate history on move. Always
 *  pass this via createKyselyClient({ migrationContext: FILE_META_MIGRATION_CONTEXT }). */
export const FILE_META_MIGRATION_CONTEXT = { tableName: "macos_clones_file_meta" } as const;

const initFileMeta: Migration = {
    id: "2026-05-init-file-meta",
    description: "Per-file metadata cache for `tools macos clones duplicates` re-scans",
    isApplied(db) {
        const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='file_meta'").get() as {
            name: string;
        } | null;
        return row !== null;
    },
    apply(db) {
        // STRICT: column-type enforcement at insert (mtime_ns must be INTEGER).
        // path is PRIMARY KEY → btree → prefix-range bulk-load is O(log n + matches).
        // No size index — bucketing by size happens in memory after the load.
        db.run(`
            CREATE TABLE IF NOT EXISTS file_meta (
                path TEXT PRIMARY KEY NOT NULL,
                size INTEGER NOT NULL,
                mtime_ns INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                clone_id TEXT NOT NULL DEFAULT '',
                last_seen_at INTEGER NOT NULL
            ) STRICT
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_file_meta_last_seen ON file_meta(last_seen_at)`);
    },
};

const initDirMeta: Migration = {
    id: "2026-05-init-dir-meta",
    description: "Per-directory mtime+ino cache for walk skip (Phase 10)",
    isApplied(db) {
        const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='dir_meta'").get() as {
            name: string;
        } | null;
        return row !== null;
    },
    apply(db) {
        // path PK = btree → prefix-range bulk-load O(log n + matches), same
        // shape as file_meta. STRICT enforces INTEGER on dir_mtime_ns / ino.
        // child_names_json is a TEXT blob; STRICT does not validate it as
        // JSON, the application layer parses with SafeJSON.
        db.run(`
            CREATE TABLE IF NOT EXISTS dir_meta (
                path TEXT PRIMARY KEY NOT NULL,
                dir_mtime_ns INTEGER NOT NULL,
                ino INTEGER NOT NULL,
                child_names_json TEXT NOT NULL,
                last_seen_at INTEGER NOT NULL
            ) STRICT
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_dir_meta_last_seen ON dir_meta(last_seen_at)`);
    },
};

export const FILE_META_MIGRATIONS: Migration[] = [initFileMeta, initDirMeta];
