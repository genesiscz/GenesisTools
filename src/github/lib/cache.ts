// SQLite cache manager for GitHub data (using bun:sqlite)

import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import type {
    RepoRecord,
    IssueRecord,
    CommentRecord,
    TimelineEventRecord,
    FetchMetadataRecord,
} from "@app/github/types";
import logger from "@app/logger";

const DEFAULT_CACHE_DIR = join(homedir(), ".genesis-tools", "github");
const DB_NAME = "cache.db";

let _db: Database | null = null;

/**
 * Get or create the database connection
 */
export function getDatabase(cacheDir: string = DEFAULT_CACHE_DIR): Database {
    if (_db) {
        return _db;
    }

    // Ensure directory exists
    if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true });
    }

    const dbPath = join(cacheDir, DB_NAME);
    logger.debug(`Opening database at ${dbPath}`);

    _db = new Database(dbPath);
    _db.exec("PRAGMA journal_mode = WAL");

    // Initialize schema
    initSchema(_db);

    return _db;
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
    if (_db) {
        _db.close();
        _db = null;
    }
}

/**
 * Initialize database schema
 */
function initSchema(db: Database): void {
    db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      UNIQUE(owner, name)
    );

    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER REFERENCES repos(id),
      number INTEGER NOT NULL,
      type TEXT CHECK(type IN ('issue', 'pr')),
      title TEXT,
      body TEXT,
      state TEXT,
      author TEXT,
      created_at TEXT,
      updated_at TEXT,
      closed_at TEXT,
      last_fetched TEXT,
      last_comment_cursor TEXT,
      UNIQUE(repo_id, number)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      issue_id INTEGER REFERENCES issues(id),
      author TEXT,
      body TEXT,
      created_at TEXT,
      updated_at TEXT,
      reaction_count INTEGER DEFAULT 0,
      reactions_json TEXT,
      is_bot INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS timeline_events (
      id TEXT PRIMARY KEY,
      issue_id INTEGER REFERENCES issues(id),
      event_type TEXT,
      actor TEXT,
      created_at TEXT,
      data_json TEXT
    );

    CREATE TABLE IF NOT EXISTS fetch_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER UNIQUE REFERENCES issues(id),
      last_full_fetch TEXT,
      last_incremental_fetch TEXT,
      total_comments INTEGER DEFAULT 0,
      last_comment_date TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo_id);
    CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);
    CREATE INDEX IF NOT EXISTS idx_comments_date ON comments(created_at);
    CREATE INDEX IF NOT EXISTS idx_events_issue ON timeline_events(issue_id);
  `);
}

// Repository operations

export function getOrCreateRepo(owner: string, name: string): RepoRecord {
    const db = getDatabase();

    // Try to get existing
    const existing = db.query("SELECT * FROM repos WHERE owner = ? AND name = ?").get(owner, name) as RepoRecord | null;
    if (existing) {
        return existing;
    }

    // Create new
    const stmt = db.query("INSERT INTO repos (owner, name) VALUES (?, ?) RETURNING id");
    const result = stmt.get(owner, name) as { id: number };
    return {
        id: result.id,
        owner,
        name,
    };
}

// Issue operations

export function getIssue(repoId: number, number: number): IssueRecord | null {
    const db = getDatabase();
    return db.query("SELECT * FROM issues WHERE repo_id = ? AND number = ?").get(repoId, number) as IssueRecord | null;
}

export function upsertIssue(data: Omit<IssueRecord, "id">): IssueRecord {
    const db = getDatabase();

    const existing = getIssue(data.repo_id, data.number);
    if (existing) {
        db.query(`
      UPDATE issues SET
        type = ?, title = ?, body = ?, state = ?, author = ?,
        created_at = ?, updated_at = ?, closed_at = ?,
        last_fetched = ?, last_comment_cursor = ?
      WHERE id = ?
    `).run(
            data.type,
            data.title,
            data.body,
            data.state,
            data.author,
            data.created_at,
            data.updated_at,
            data.closed_at,
            data.last_fetched,
            data.last_comment_cursor,
            existing.id
        );
        return { ...existing, ...data };
    }

    const stmt = db.query(`
    INSERT INTO issues (
      repo_id, number, type, title, body, state, author,
      created_at, updated_at, closed_at, last_fetched, last_comment_cursor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
  `);
    const result = stmt.get(
        data.repo_id,
        data.number,
        data.type,
        data.title,
        data.body,
        data.state,
        data.author,
        data.created_at,
        data.updated_at,
        data.closed_at,
        data.last_fetched,
        data.last_comment_cursor
    ) as { id: number };

    return { id: result.id, ...data };
}

// Comment operations

export function getComments(
    issueId: number,
    options: {
        limit?: number;
        offset?: number;
        since?: string;
        before?: string;
        after?: string;
        minReactions?: number;
        author?: string;
        excludeBots?: boolean;
    } = {}
): CommentRecord[] {
    const db = getDatabase();

    let sql = "SELECT * FROM comments WHERE issue_id = ?";
    const params: (string | number)[] = [issueId];

    if (options.since) {
        sql += " AND CAST(id AS INTEGER) > CAST(? AS INTEGER)";
        params.push(options.since);
    }

    if (options.after) {
        sql += " AND created_at > ?";
        params.push(options.after);
    }

    if (options.before) {
        sql += " AND created_at < ?";
        params.push(options.before);
    }

    if (options.minReactions !== undefined) {
        sql += " AND reaction_count >= ?";
        params.push(options.minReactions);
    }

    if (options.author) {
        sql += " AND author = ?";
        params.push(options.author);
    }

    if (options.excludeBots) {
        sql += " AND is_bot = 0";
    }

    sql += " ORDER BY created_at ASC";

    if (options.limit) {
        sql += " LIMIT ?";
        params.push(options.limit);

        if (options.offset) {
            sql += " OFFSET ?";
            params.push(options.offset);
        }
    }

    return db.query(sql).all(...params) as CommentRecord[];
}

export function getLastNComments(
    issueId: number,
    n: number,
    options: {
        excludeBots?: boolean;
        minReactions?: number;
        author?: string;
    } = {}
): CommentRecord[] {
    const db = getDatabase();

    let sql = "SELECT * FROM comments WHERE issue_id = ?";
    const params: (string | number)[] = [issueId];

    if (options.excludeBots) {
        sql += " AND is_bot = 0";
    }

    if (options.minReactions !== undefined) {
        sql += " AND reaction_count >= ?";
        params.push(options.minReactions);
    }

    if (options.author) {
        sql += " AND author = ?";
        params.push(options.author);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(n);

    const comments = db.query(sql).all(...params) as CommentRecord[];
    return comments.reverse(); // Return in chronological order
}

export function upsertComment(data: CommentRecord): void {
    const db = getDatabase();

    db.query(`
    INSERT OR REPLACE INTO comments (
      id, issue_id, author, body, created_at, updated_at,
      reaction_count, reactions_json, is_bot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
        data.id,
        data.issue_id,
        data.author,
        data.body,
        data.created_at,
        data.updated_at,
        data.reaction_count,
        data.reactions_json,
        data.is_bot
    );
}

export function upsertComments(comments: CommentRecord[]): void {
    const db = getDatabase();

    const stmt = db.query(`
    INSERT OR REPLACE INTO comments (
      id, issue_id, author, body, created_at, updated_at,
      reaction_count, reactions_json, is_bot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

    const transaction = db.transaction((items: CommentRecord[]) => {
        for (const c of items) {
            stmt.run(
                c.id,
                c.issue_id,
                c.author,
                c.body,
                c.created_at,
                c.updated_at,
                c.reaction_count,
                c.reactions_json,
                c.is_bot
            );
        }
    });

    transaction(comments);
}

export function getCommentCount(issueId: number, excludeBots: boolean = false): number {
    const db = getDatabase();

    let sql = "SELECT COUNT(*) as count FROM comments WHERE issue_id = ?";
    if (excludeBots) {
        sql += " AND is_bot = 0";
    }

    const result = db.query(sql).get(issueId) as { count: number };
    return result.count;
}

// Timeline event operations

export function getTimelineEvents(issueId: number): TimelineEventRecord[] {
    const db = getDatabase();
    return db
        .query("SELECT * FROM timeline_events WHERE issue_id = ? ORDER BY created_at ASC")
        .all(issueId) as TimelineEventRecord[];
}

export function upsertTimelineEvents(events: TimelineEventRecord[]): void {
    const db = getDatabase();

    const stmt = db.query(`
    INSERT OR REPLACE INTO timeline_events (
      id, issue_id, event_type, actor, created_at, data_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

    const transaction = db.transaction((items: TimelineEventRecord[]) => {
        for (const e of items) {
            stmt.run(e.id, e.issue_id, e.event_type, e.actor, e.created_at, e.data_json);
        }
    });

    transaction(events);
}

// Fetch metadata operations

export function getFetchMetadata(issueId: number): FetchMetadataRecord | null {
    const db = getDatabase();
    return db.query("SELECT * FROM fetch_metadata WHERE issue_id = ?").get(issueId) as FetchMetadataRecord | null;
}

export function updateFetchMetadata(issueId: number, data: Partial<FetchMetadataRecord>): void {
    const db = getDatabase();

    const existing = getFetchMetadata(issueId);
    if (existing) {
        const updates: string[] = [];
        const params: (string | number | null)[] = [];

        if (data.last_full_fetch !== undefined) {
            updates.push("last_full_fetch = ?");
            params.push(data.last_full_fetch);
        }
        if (data.last_incremental_fetch !== undefined) {
            updates.push("last_incremental_fetch = ?");
            params.push(data.last_incremental_fetch);
        }
        if (data.total_comments !== undefined) {
            updates.push("total_comments = ?");
            params.push(data.total_comments);
        }
        if (data.last_comment_date !== undefined) {
            updates.push("last_comment_date = ?");
            params.push(data.last_comment_date);
        }

        if (updates.length > 0) {
            params.push(issueId);
            db.query(`UPDATE fetch_metadata SET ${updates.join(", ")} WHERE issue_id = ?`).run(...params);
        }
    } else {
        db.query(`
      INSERT INTO fetch_metadata (
        issue_id, last_full_fetch, last_incremental_fetch, total_comments, last_comment_date
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
            issueId,
            data.last_full_fetch ?? null,
            data.last_incremental_fetch ?? null,
            data.total_comments ?? 0,
            data.last_comment_date ?? null
        );
    }
}

// Utility functions

export function clearCache(): void {
    const db = getDatabase();
    db.exec(`
    DELETE FROM comments;
    DELETE FROM timeline_events;
    DELETE FROM fetch_metadata;
    DELETE FROM issues;
    DELETE FROM repos;
  `);
}

export function getCacheStats(): {
    repos: number;
    issues: number;
    comments: number;
    events: number;
} {
    const db = getDatabase();
    const repos = (db.query("SELECT COUNT(*) as count FROM repos").get() as { count: number }).count;
    const issues = (db.query("SELECT COUNT(*) as count FROM issues").get() as { count: number }).count;
    const comments = (db.query("SELECT COUNT(*) as count FROM comments").get() as { count: number }).count;
    const events = (db.query("SELECT COUNT(*) as count FROM timeline_events").get() as { count: number }).count;

    return { repos, issues, comments, events };
}
