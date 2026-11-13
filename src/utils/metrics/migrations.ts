import type { Migration } from "@genesiscz/utils/database/migrations";

/** The scope of the metrics store's ids in `_migrations`. */
export const METRICS_MIGRATION_SCOPE = "metrics";

/**
 * The metrics store (`<genesis-tools>/metrics/metrics.db`). Events are the source of truth; statistics are queries
 * over them. A declared dim's partial expression index is not here: `define` creates it, one per metric and dim.
 */
export const METRICS_MIGRATIONS: Migration[] = [
    {
        id: "2026-11-metrics-initial",
        description: "projects, metrics, events and the spool read offsets",
        apply(db) {
            db.run(`CREATE TABLE projects (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                description TEXT,
                created_at INTEGER NOT NULL
            )`);
            db.run(`CREATE TABLE metrics (
                id INTEGER PRIMARY KEY,
                project_id INTEGER NOT NULL REFERENCES projects(id),
                name TEXT NOT NULL,
                unit TEXT,
                description TEXT,
                dims_json TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL,
                UNIQUE(project_id, name)
            )`);
            db.run(`CREATE TABLE events (
                id INTEGER PRIMARY KEY,
                metric_id INTEGER NOT NULL,
                at INTEGER NOT NULL,
                value REAL NOT NULL,
                dims TEXT NOT NULL DEFAULT '{}',
                context TEXT
            )`);
            // `value` makes a time-bucketed sum read the index alone.
            db.run("CREATE INDEX events_metric_at ON events(metric_id, at, value)");
            // `lines` counts the whole lines read, so a bad line is logged with its line number.
            db.run(`CREATE TABLE spool_files (
                path TEXT PRIMARY KEY,
                offset INTEGER NOT NULL,
                lines INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            )`);
        },
    },
    {
        id: "2026-11-metrics-checkpoints",
        description: "checkpoints: named points in a project's time to group and compare its metrics by",
        apply(db) {
            // `commit` is an SQL keyword, so the SHA is `commit_sha`.
            db.run(`CREATE TABLE checkpoints (
                id INTEGER PRIMARY KEY,
                project_id INTEGER NOT NULL REFERENCES projects(id),
                name TEXT NOT NULL,
                at INTEGER NOT NULL,
                commit_sha TEXT,
                repo TEXT,
                note TEXT,
                data TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(project_id, name)
            )`);
            db.run("CREATE INDEX checkpoints_project_at ON checkpoints(project_id, at)");
        },
    },
];
