import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync } from "node:fs";
import { type Migration, runMigrations } from "@genesiscz/utils/database/migrations";
import { logger } from "@genesiscz/utils/logger";

export const HISTORY_MIGRATIONS: Migration[] = [
    {
        id: "2026-09-history-bootstrap",
        description: "Serialize legacy history schema initialization without discarding existing data",
        apply(db) {
            db.exec(`
    -- Daily aggregated statistics
    CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '__all__',
      conversations INTEGER NOT NULL DEFAULT 0,
      messages INTEGER NOT NULL DEFAULT 0,
      subagent_sessions INTEGER NOT NULL DEFAULT 0,
      tool_counts TEXT, -- JSON object: {"Read": 50, "Bash": 30}
      hourly_activity TEXT, -- JSON object: {"0": 5, "1": 2, ...}
      token_usage TEXT, -- JSON object: {"inputTokens": 1000, "outputTokens": 500, ...}
      model_counts TEXT, -- JSON object: {"opus": 50, "sonnet": 30, "haiku": 10}
      branch_counts TEXT, -- JSON object: {"main": 100, "feat/xyz": 50}
      computed_at TEXT NOT NULL,
      PRIMARY KEY (date, project)
    );

    -- File index for incremental updates
    CREATE TABLE IF NOT EXISTS file_index (
      file_path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      first_date TEXT,
      last_date TEXT,
      project TEXT,
      is_subagent INTEGER NOT NULL DEFAULT 0,
      last_indexed TEXT NOT NULL
    );

    -- Cache metadata
    CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Quick totals cache (for instant loading)
    CREATE TABLE IF NOT EXISTS totals_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total_conversations INTEGER NOT NULL DEFAULT 0,
      total_messages INTEGER NOT NULL DEFAULT 0,
      total_subagents INTEGER NOT NULL DEFAULT 0,
      project_count INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL
    );

    -- Session metadata cache (for claude-resume fast lookup)
    CREATE TABLE IF NOT EXISTS session_metadata (
      file_path TEXT PRIMARY KEY,
      session_id TEXT,
      custom_title TEXT,
      summary TEXT,
      first_prompt TEXT,
      git_branch TEXT,
      project TEXT,
      cwd TEXT,
      mtime INTEGER NOT NULL,
      first_timestamp TEXT,
      is_subagent INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
    CREATE INDEX IF NOT EXISTS idx_file_index_mtime ON file_index(mtime);
    CREATE INDEX IF NOT EXISTS idx_file_index_project ON file_index(project);
    CREATE INDEX IF NOT EXISTS idx_session_metadata_session_id ON session_metadata(session_id);
  `);
            const additions = [
                ["daily_stats", "token_usage"],
                ["daily_stats", "model_counts"],
                ["daily_stats", "branch_counts"],
                ["session_metadata", "all_user_text"],
            ] as const;

            for (const [table, column] of additions) {
                const columns = db.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all();

                if (!columns.some((existing) => existing.name === column)) {
                    db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" TEXT`);
                }
            }
        },
    },
];

export function initializeHistorySchema(db: Database): void {
    runMigrations(db, HISTORY_MIGRATIONS, { tableName: "provider_history" });
}

interface LegacyColumn {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
    hidden: number;
}

function quotedIdentifier(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
}

function legacyColumnDefinition(column: LegacyColumn): string {
    if (column.hidden || !/^[a-zA-Z0-9_ (),]*$/.test(column.type)) {
        throw new Error(`Unsupported legacy history column definition: ${column.name}`);
    }

    return [
        quotedIdentifier(column.name),
        column.type,
        column.notnull ? "NOT NULL" : "",
        column.dflt_value === null ? "" : `DEFAULT ${column.dflt_value}`,
    ]
        .filter(Boolean)
        .join(" ");
}

type LegacyHistoryTable = "session_metadata" | "file_index" | "daily_stats" | "totals_cache";

/** Preserve known column data and explicit indexes; refuse unfamiliar constraints before changing anything. */
function rewriteHistoryTable(options: {
    db: Database;
    table: LegacyHistoryTable;
    legacyKey: string[];
    key: string[];
    additions: Array<{ name: string; definition: string; expression?: string }>;
    overrides?: Record<string, string>;
    check?: string;
}): void {
    const { db, table } = options;
    const schema = db
        .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
    const inspectedSql =
        table === "totals_cache" ? schema?.sql.replace(/CHECK\s*\(\s*id\s*=\s*1\s*\)/gi, "") : schema?.sql;

    if (!inspectedSql || /\b(CHECK|COLLATE|REFERENCES|GENERATED|WITHOUT\s+ROWID)\b/i.test(inspectedSql)) {
        throw new Error(`Cannot safely reconstruct unfamiliar history constraints in ${table}`);
    }

    const columns = db.query<LegacyColumn, []>(`PRAGMA table_xinfo(${quotedIdentifier(table)})`).all();
    const primary = columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name);

    if (primary.join("\0") !== options.legacyKey.join("\0")) {
        throw new Error(`Unexpected legacy primary key in ${table}`);
    }

    const implicitUnique = db
        .query<{ origin: string }, []>(`PRAGMA index_list(${quotedIdentifier(table)})`)
        .all()
        .some((index) => index.origin === "u");
    const triggers = db
        .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?")
        .all(table);

    if (implicitUnique || triggers.length) {
        throw new Error(`History key migration needs review of uniqueness constraints or triggers on ${table}`);
    }

    for (const other of db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all()) {
        const references = db
            .query<{ table: string }, []>(`PRAGMA foreign_key_list(${quotedIdentifier(other.name)})`)
            .all();

        if (references.some((reference) => reference.table === table)) {
            throw new Error(`History key migration needs review of references from ${other.name} to ${table}`);
        }
    }

    const existingNames = new Set(columns.map((column) => column.name));

    for (const addition of options.additions) {
        if (existingNames.has(addition.name)) {
            throw new Error(`Reserved provider-history column already exists: ${table}.${addition.name}`);
        }
    }

    const indexes = db
        .query<{ sql: string }, [string]>(
            "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL"
        )
        .all(table);
    const next = quotedIdentifier(`${table}_compact_next`);
    const definitions = [
        ...columns.map((column) => options.overrides?.[column.name] ?? legacyColumnDefinition(column)),
        ...options.additions.map((column) => `${quotedIdentifier(column.name)} ${column.definition}`),
        `PRIMARY KEY (${options.key.map(quotedIdentifier).join(", ")})`,
        ...(options.check ? [`CHECK (${options.check})`] : []),
    ];
    const extraValues = options.additions.filter((column) => column.expression !== undefined);
    const targetColumns = [
        ...columns.map((column) => quotedIdentifier(column.name)),
        ...extraValues.map((column) => quotedIdentifier(column.name)),
    ];
    const selectedColumns = [
        ...columns.map((column) => quotedIdentifier(column.name)),
        ...extraValues.map((column) => column.expression!),
    ];
    db.exec(`CREATE TABLE ${next} (${definitions.join(", ")})`);
    db.exec(
        `INSERT INTO ${next} (${targetColumns.join(", ")}) SELECT ${selectedColumns.join(", ")} FROM ${quotedIdentifier(table)}`
    );
    db.exec(`DROP TABLE ${quotedIdentifier(table)}`);
    db.exec(`ALTER TABLE ${next} RENAME TO ${quotedIdentifier(table)}`);

    for (const index of indexes) {
        db.exec(index.sql);
    }
}

function replaceLegacyPathKey(options: {
    db: Database;
    table: "session_metadata" | "file_index";
    additions: Array<{ name: string; definition: string }>;
}): void {
    rewriteHistoryTable({
        ...options,
        legacyKey: ["file_path"],
        key: ["source_key"],
        overrides: { file_path: '"file_path" TEXT NOT NULL' },
        additions: [
            {
                name: "source_key",
                definition: "TEXT NOT NULL",
                expression: "json_array('legacy', 'anthropic-sub', '', file_path)",
            },
            ...options.additions,
        ],
    });
    options.db.exec(
        `CREATE INDEX ${quotedIdentifier(`${options.table}_file_path`)} ON ${quotedIdentifier(options.table)} (file_path)`
    );
}

const COMPACT_HISTORY_MIGRATIONS: Migration[] = [
    {
        id: "2026-09-history-session-keys",
        description: "Keep legacy metadata while introducing provider-qualified logical source identity",
        apply(db) {
            replaceLegacyPathKey({
                db,
                table: "session_metadata",
                additions: [
                    { name: "provider", definition: "TEXT NOT NULL DEFAULT 'anthropic-sub'" },
                    { name: "source_home", definition: "TEXT" },
                    { name: "native_id", definition: "TEXT" },
                    { name: "parent_native_id", definition: "TEXT" },
                    { name: "project_directory", definition: "TEXT" },
                    { name: "last_timestamp", definition: "TEXT" },
                    { name: "archived", definition: "INTEGER NOT NULL DEFAULT 0" },
                    { name: "resume_mode", definition: "TEXT NOT NULL DEFAULT 'unsupported'" },
                    { name: "identity_status", definition: "TEXT NOT NULL DEFAULT 'legacy'" },
                    { name: "bounded_fields", definition: "TEXT NOT NULL DEFAULT '[]'" },
                ],
            });
            db.exec(
                "CREATE UNIQUE INDEX session_metadata_native_id ON session_metadata(provider, native_id, source_home)"
            );
        },
    },
    {
        id: "2026-09-history-source-freshness",
        description: "Separate metadata freshness from legacy transcript statistics",
        apply(db) {
            replaceLegacyPathKey({
                db,
                table: "file_index",
                additions: [
                    { name: "provider", definition: "TEXT NOT NULL DEFAULT 'anthropic-sub'" },
                    { name: "root", definition: "TEXT" },
                    { name: "metadata_revision", definition: "TEXT" },
                    { name: "metadata_parser_version", definition: "TEXT" },
                    { name: "stats_revision", definition: "TEXT" },
                    { name: "stats_parser_version", definition: "TEXT" },
                    { name: "statistics_status", definition: "TEXT NOT NULL DEFAULT 'unavailable'" },
                    { name: "generation", definition: "INTEGER NOT NULL DEFAULT 0" },
                ],
            });
            db.exec("UPDATE file_index SET statistics_status = 'legacy'");
            db.exec("CREATE INDEX file_index_provider_root ON file_index(provider, root)");
        },
    },
    {
        id: "2026-09-history-provider-aggregates",
        description: "Qualify existing statistics and quick totals by provider without rewriting observations",
        apply(db) {
            rewriteHistoryTable({
                db,
                table: "daily_stats",
                legacyKey: ["date", "project"],
                key: ["provider", "date", "project"],
                additions: [
                    { name: "provider", definition: "TEXT NOT NULL DEFAULT 'anthropic-sub'" },
                    { name: "coverage", definition: "TEXT NOT NULL DEFAULT 'legacy'" },
                ],
            });
            rewriteHistoryTable({
                db,
                table: "totals_cache",
                legacyKey: ["id"],
                key: ["provider", "scope"],
                overrides: { id: '"id" INTEGER NOT NULL DEFAULT 1' },
                check: "id = 1",
                additions: [
                    { name: "provider", definition: "TEXT NOT NULL DEFAULT 'anthropic-sub'" },
                    { name: "scope", definition: "TEXT NOT NULL DEFAULT '__all__'" },
                    { name: "coverage", definition: "TEXT NOT NULL DEFAULT 'legacy'" },
                ],
            });
            db.exec(`
                CREATE TABLE history_roots (
                    provider TEXT NOT NULL, root TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
                    completed_at TEXT, PRIMARY KEY(provider, root)
                );
                CREATE TABLE history_source_issues (
                    provider TEXT NOT NULL, path TEXT NOT NULL, code TEXT NOT NULL,
                    message TEXT NOT NULL, occurrences INTEGER NOT NULL DEFAULT 1,
                    PRIMARY KEY(provider, path, code)
                );
                CREATE TABLE file_daily_stats (
                    source_key TEXT NOT NULL, provider TEXT NOT NULL, date TEXT NOT NULL,
                    project TEXT NOT NULL, conversations INTEGER NOT NULL DEFAULT 0,
                    messages INTEGER NOT NULL DEFAULT 0, subagent_sessions INTEGER NOT NULL DEFAULT 0,
                    tool_counts TEXT, hourly_activity TEXT, token_usage TEXT, model_counts TEXT,
                    branch_counts TEXT, PRIMARY KEY(source_key, date, project)
                );
                CREATE INDEX file_daily_stats_scope ON file_daily_stats(provider, date, project);
            `);
        },
    },
    {
        id: "2026-09-history-statistics-inputs",
        description: "Track separate telemetry revisions without invalidating conversation metadata",
        apply(db) {
            const columns = db.query<{ name: string }, []>("PRAGMA table_info(file_index)").all();

            if (!columns.some((column) => column.name === "stats_inputs_revision")) {
                db.exec("ALTER TABLE file_index ADD COLUMN stats_inputs_revision TEXT");
            }
        },
    },
    {
        id: "2026-09-history-storage-cuts",
        description: "Distinguish storage cuts from intentional summary collection bounds",
        apply(db) {
            const columns = db.query<{ name: string }, []>("PRAGMA table_info(session_metadata)").all();
            if (!columns.some((column) => column.name === "storage_truncated_fields")) {
                db.exec("ALTER TABLE session_metadata ADD COLUMN storage_truncated_fields TEXT NOT NULL DEFAULT '[]'");
                db.exec("UPDATE session_metadata SET storage_truncated_fields=bounded_fields");
            }
        },
    },
];

export const PRE_COMPACT_BACKUP_SUFFIX = ".pre-compact.bak";

/**
 * Copy the database aside once, before the first provider-history migration rewrites it.
 *
 * The rewrite moves session_metadata and file_index off their file_path primary key, which the
 * previous release cannot write to, and it is the only shared store holding usage_snapshots and
 * spend_snapshots. One 85 MB copy is the whole rollback story.
 */
function backupBeforeCompactRewrite(db: Database): void {
    const path = db.filename;

    if (!path || path === ":memory:" || !existsSync(path)) {
        return;
    }

    const backup = `${path}${PRE_COMPACT_BACKUP_SUFFIX}`;

    if (existsSync(backup)) {
        return;
    }

    // Fold the WAL back in first, so the copy is a complete database on its own.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    copyFileSync(path, backup);
    logger.warn({ path, backup }, "Copied the history database aside before the provider-history rewrite");
}

/** Used by the compact repository only after its compatibility and size gates pass. */
export function initializeCompactHistorySchema(db: Database): void {
    initializeHistorySchema(db);
    const pending = COMPACT_HISTORY_MIGRATIONS.some(
        (migration) =>
            !db
                .query<{ id: string }, [string]>("SELECT id FROM _migrations WHERE id = ?")
                .get(`provider_history:${migration.id}`)
    );

    if (pending) {
        backupBeforeCompactRewrite(db);
    }

    runMigrations(db, COMPACT_HISTORY_MIGRATIONS, { tableName: "provider_history" });
}
