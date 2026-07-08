import { join } from "node:path";
import { getDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { createKyselyClient, type DatabaseClient } from "@app/utils/database/client";
import { env } from "@app/utils/env";
import type { BoardsDb } from "./db-types";

export const BOOTSTRAP_DDL: string[] = [
    `CREATE TABLE IF NOT EXISTS sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        branch_slug TEXT NOT NULL,
        branch_raw TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL,
        key TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'screenshots',
        title TEXT NOT NULL DEFAULT '',
        commit_sha TEXT NOT NULL DEFAULT '',
        repo TEXT NOT NULL DEFAULT '',
        source_ref TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        journey TEXT NOT NULL DEFAULT '',
        file_count INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project, branch_slug, version),
        UNIQUE (project, branch_slug, key)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_sets_name ON sets (project, branch_slug, name) WHERE name != ''`,
    `CREATE TABLE IF NOT EXISTS set_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        set_id INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        mime TEXT NOT NULL DEFAULT '',
        bytes INTEGER NOT NULL DEFAULT 0,
        blob_key TEXT NOT NULL,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        meta TEXT NOT NULL DEFAULT '',
        UNIQUE (set_id, path)
    )`,
    `CREATE TABLE IF NOT EXISTS boards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        project TEXT NOT NULL DEFAULT '',
        board_type TEXT NOT NULL DEFAULT 'board',
        elem_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS board_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0,
        w REAL NOT NULL DEFAULT 320, h REAL NOT NULL DEFAULT 240,
        z INTEGER NOT NULL DEFAULT 0,
        set_ref TEXT NOT NULL DEFAULT '',
        set_version INTEGER NOT NULL DEFAULT 0,
        file_path TEXT NOT NULL DEFAULT '',
        blob_key TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL DEFAULT '',
        elem_no INTEGER NOT NULL DEFAULT 0,
        current_version INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_cards_board ON board_cards (board_id, deleted_at)`,
    `CREATE TABLE IF NOT EXISTS card_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id INTEGER NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        set_ref TEXT NOT NULL DEFAULT '',
        set_version INTEGER NOT NULL DEFAULT 0,
        file_path TEXT NOT NULL DEFAULT '',
        blob_key TEXT NOT NULL DEFAULT '',
        attempt_id INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE (card_id, version)
    )`,
    `CREATE TABLE IF NOT EXISTS board_strokes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        card_id INTEGER NOT NULL DEFAULT 0,
        path TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#e33',
        width REAL NOT NULL DEFAULT 3,
        created_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS board_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        from_card INTEGER NOT NULL,
        to_card INTEGER NOT NULL DEFAULT 0,
        to_x REAL NOT NULL DEFAULT 0, to_y REAL NOT NULL DEFAULT 0,
        label TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        card_id INTEGER NOT NULL,
        region TEXT NOT NULL,
        intent TEXT NOT NULL DEFAULT 'fix',
        intent_other TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'staged',
        assignee TEXT NOT NULL DEFAULT 'claude',
        created_by TEXT NOT NULL DEFAULT '',
        card_version INTEGER NOT NULL DEFAULT 1,
        claimed_by TEXT NOT NULL DEFAULT '',
        claimed_listener INTEGER NOT NULL DEFAULT 0,
        claimed_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ann_status ON annotations (status, board_id)`,
    `CREATE TABLE IF NOT EXISTS annotation_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        annotation_id INTEGER NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS annotation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        annotation_id INTEGER NOT NULL DEFAULT 0,
        board_id INTEGER NOT NULL DEFAULT 0,
        author TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS annotation_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        annotation_id INTEGER NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
        revision_id INTEGER NOT NULL DEFAULT 0,
        after_set_ref TEXT NOT NULL DEFAULT '',
        after_version INTEGER NOT NULL DEFAULT 0,
        after_file TEXT NOT NULL DEFAULT '',
        after_blob_key TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT 'claude',
        commit_ref TEXT NOT NULL DEFAULT '',
        verdict TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS listeners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_kind TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        branch TEXT NOT NULL DEFAULT '',
        actor TEXT NOT NULL DEFAULT '',
        session TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
    )`,
    // 'all' leases are deliberately per-session duplicates (every concurrent "all" listener keeps
    // its own row); the WHERE excludes them so only "board"/"project" scopes get a single holder.
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_listeners_scope ON listeners(scope_kind, scope, branch) WHERE scope_kind != 'all'`,
    `CREATE TABLE IF NOT EXISTS board_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        card_id INTEGER NOT NULL DEFAULT 0,
        prompt TEXT NOT NULL,
        options TEXT NOT NULL DEFAULT '[]',
        answer TEXT NOT NULL DEFAULT '',
        answered_by TEXT NOT NULL DEFAULT '',
        delivered INTEGER NOT NULL DEFAULT 0,
        staged INTEGER NOT NULL DEFAULT 1,
        multi INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        answered_at TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

let client: DatabaseClient<BoardsDb> | null = null;

export function boardsDbPath(): string {
    const override = env.boards.getDbPath();
    if (override) {
        return override;
    }

    return join(getDevDashboardStorage().getBaseDir(), "boards.db");
}

export function getBoardsDb(): DatabaseClient<BoardsDb> {
    client ??= createKyselyClient<BoardsDb>({
        path: boardsDbPath(),
        bootstrap: BOOTSTRAP_DDL,
        migrationContext: { tableName: "dev-dashboard-boards" },
        // The DDL above declares `ON DELETE CASCADE` on several FKs (set_files, board_cards,
        // card_versions, annotation_revisions, annotation_attempts, board_questions, ...) —
        // SQLite silently ignores those actions unless foreign key enforcement is on.
        pragmas: { foreignKeys: true },
    });
    return client;
}

/** Test-only: close + drop the singleton so the next call re-reads env. */
export function resetBoardsDb(): void {
    client?.close();
    client = null;
}
