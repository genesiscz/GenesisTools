import type { Migration } from "@app/utils/database/migrations";

const INITIAL_SCHEMA_SQL = `
            CREATE TABLE stashes (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                tags TEXT,
                description TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE versions (
                id TEXT PRIMARY KEY,
                stash_id TEXT NOT NULL REFERENCES stashes(id) ON DELETE CASCADE,
                version INTEGER NOT NULL,
                patch_ref TEXT NOT NULL,
                source_repo_path TEXT,
                source_origin TEXT,
                source_sha TEXT,
                region_count INTEGER NOT NULL,
                file_count INTEGER NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                UNIQUE(stash_id, version)
            );
            CREATE TABLE regions (
                id TEXT PRIMARY KEY,
                version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
                region_name TEXT,
                file_path TEXT NOT NULL,
                hunk_index INTEGER NOT NULL,
                start_marker_present INTEGER NOT NULL DEFAULT 0,
                line_count INTEGER NOT NULL
            );
            CREATE TABLE applications (
                id TEXT PRIMARY KEY,
                stash_id TEXT NOT NULL REFERENCES stashes(id) ON DELETE CASCADE,
                -- version_id is nullable with ON DELETE SET NULL so audit rows survive a version
                -- drop (drop --all-versions --orphan-active). The drop loop deletes versions while
                -- applications still reference them; without SET NULL the FK fires and the drop
                -- partially completes. The audit intent is preserved — application history sticks
                -- around — but the pointer is nulled rather than dangling.
                version_id TEXT REFERENCES versions(id) ON DELETE SET NULL,
                project_path TEXT NOT NULL,
                project_origin TEXT,
                project_sha_at_apply TEXT,
                applied_at TEXT NOT NULL,
                state TEXT NOT NULL,
                unapplied_at TEXT
            );
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                origin TEXT,
                tree_hash TEXT,
                last_seen TEXT NOT NULL
            );
            CREATE INDEX idx_versions_stash ON versions(stash_id);
            CREATE INDEX idx_applications_project ON applications(project_path);
            CREATE INDEX idx_applications_stash ON applications(stash_id);
            CREATE INDEX idx_regions_version ON regions(version_id);
            CREATE UNIQUE INDEX idx_applications_active
                ON applications(stash_id, project_path)
                WHERE state = 'active';
        `;

export const STASH_MIGRATIONS: Migration[] = [
    {
        id: "001-initial-schema",
        description: "Initial stash index schema (stashes, versions, regions, applications, projects).",
        apply(db) {
            db.exec(INITIAL_SCHEMA_SQL);
        },
    },
];
