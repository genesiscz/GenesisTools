import { openHistoryReadOnly } from "./database";

export interface CachedHistoryTitle {
    customTitle: string | null;
    summary: string | null;
}

/** Runtime enrichment needs neither plugin loading nor schema initialization. */
export function readCachedHistoryTitle(options: {
    providerId: string;
    sessionId: string;
    path?: string;
}): CachedHistoryTitle | null {
    const db = openHistoryReadOnly({ path: options.path });

    if (!db) {
        return null;
    }

    try {
        const columns = new Set(
            db
                .query<{ name: string }, []>("PRAGMA table_info(session_metadata)")
                .all()
                .map((column) => column.name)
        );

        if (!columns.has("custom_title") || !columns.has("session_id")) {
            return null;
        }

        if (columns.has("provider")) {
            return db
                .query<CachedHistoryTitle, [string, string, string, string]>(`
                SELECT custom_title AS customTitle, summary FROM session_metadata
                WHERE provider=? AND (native_id=? OR session_id=?)
                ORDER BY (native_id=?) DESC, is_subagent ASC, mtime DESC, file_path LIMIT 1
            `)
                .get(options.providerId, options.sessionId, options.sessionId, options.sessionId);
        }

        if (options.providerId !== "anthropic-sub") {
            return null;
        }

        const suffix = `/${options.sessionId}.jsonl`;
        return db
            .query<CachedHistoryTitle, [string, number, string]>(`
            SELECT custom_title AS customTitle, summary FROM session_metadata
            WHERE session_id=? OR substr(file_path,-?)=? ORDER BY is_subagent ASC,mtime DESC,file_path LIMIT 1
        `)
            .get(options.sessionId, suffix.length, suffix);
    } finally {
        db.close();
    }
}

/** Every name is a column of `session_metadata`. No table reads as no columns, so the answer is false. */
function hasColumns(columns: Set<string>, names: readonly string[]): boolean {
    return names.every((name) => columns.has(name));
}

export interface CachedSessionMatch {
    sessionId: string;
    providerId: string | null;
    title: string | null;
    mtime: number;
}

export type SessionIdResolution =
    /** The id names a session as given, or the index is not there to say otherwise. */
    | { kind: "exact" | "unavailable"; sessionId: string }
    | { kind: "unique"; sessionId: string; match: CachedSessionMatch }
    | { kind: "ambiguous"; candidates: CachedSessionMatch[] }
    | { kind: "none" };

/**
 * A session id or a leading part of one, looked up in the history index (no schema work, no file
 * walk). Main sessions only, newest first, so a prefix never resolves to a subagent's row.
 */
export function resolveCachedSessionId(options: { id: string; path?: string }): SessionIdResolution {
    const db = openHistoryReadOnly({ path: options.path });

    if (!db) {
        return { kind: "unavailable", sessionId: options.id };
    }

    try {
        const columns = new Set(
            db
                .query<{ name: string }, []>("PRAGMA table_info(session_metadata)")
                .all()
                .map((column) => column.name)
        );

        // An index without the table, or from a schema before these columns, cannot answer.
        if (!hasColumns(columns, ["session_id", "mtime", "custom_title", "summary"])) {
            return { kind: "unavailable", sessionId: options.id };
        }

        const provider = columns.has("provider") ? "provider" : "NULL";
        const mainOnly = columns.has("is_subagent") ? "AND COALESCE(is_subagent, 0) = 0" : "";
        // A range on session_id uses its index; LIKE would not (it folds case).
        const rows = db
            .query<CachedSessionMatch, [string, string]>(`
                SELECT session_id AS sessionId, ${provider} AS providerId,
                       COALESCE(custom_title, summary) AS title, MAX(mtime) AS mtime
                FROM session_metadata
                WHERE session_id >= ? AND session_id < ? ${mainOnly}
                GROUP BY session_id, ${provider}
                ORDER BY mtime DESC
                LIMIT 20
            `)
            .all(options.id, `${options.id}￿`);

        if (rows.some((row) => row.sessionId === options.id)) {
            return { kind: "exact", sessionId: options.id };
        }

        const ids = new Set(rows.map((row) => row.sessionId));

        if (ids.size === 0) {
            return { kind: "none" };
        }

        const [first] = rows;
        return ids.size === 1 && first
            ? { kind: "unique", sessionId: first.sessionId, match: first }
            : { kind: "ambiguous", candidates: rows };
    } finally {
        db.close();
    }
}

export interface RecentCachedSession {
    sessionId: string;
    title: string | null;
    project: string | null;
    mtime: number;
}

/** The newest main sessions of one provider from the history index, for a picker. Empty without an index. */
export function listRecentCachedSessions(options: {
    providerId: string;
    limit: number;
    path?: string;
}): RecentCachedSession[] {
    const db = openHistoryReadOnly({ path: options.path });

    if (!db) {
        return [];
    }

    try {
        const columns = new Set(
            db
                .query<{ name: string }, []>("PRAGMA table_info(session_metadata)")
                .all()
                .map((column) => column.name)
        );

        const needed = [
            "provider",
            "is_subagent",
            "session_id",
            "mtime",
            "custom_title",
            "summary",
            "first_prompt",
            "project",
        ];
        if (!hasColumns(columns, needed)) {
            return [];
        }

        return db
            .query<RecentCachedSession, [string, number]>(`
                SELECT session_id AS sessionId, COALESCE(custom_title, summary, substr(first_prompt, 1, 80)) AS title,
                       project, MAX(mtime) AS mtime
                FROM session_metadata
                WHERE provider = ? AND COALESCE(is_subagent, 0) = 0 AND session_id IS NOT NULL
                GROUP BY session_id
                ORDER BY mtime DESC
                LIMIT ?
            `)
            .all(options.providerId, options.limit);
    } finally {
        db.close();
    }
}

/**
 * The working folder of a session named by its id or a leading part of it, from the history index
 * (no schema work, no file walk). An exact id wins, then a main session over a subagent, then the
 * newest. Null when the index cannot answer, so the caller can fall back to a refreshed listing.
 */
export function readCachedSessionCwd(options: { sessionId: string; path?: string }): string | null {
    const db = openHistoryReadOnly({ path: options.path });

    if (!db) {
        return null;
    }

    try {
        const columns = new Set(
            db
                .query<{ name: string }, []>("PRAGMA table_info(session_metadata)")
                .all()
                .map((column) => column.name)
        );

        if (!hasColumns(columns, ["session_id", "cwd", "mtime", "is_subagent"])) {
            return null;
        }

        // A range on session_id uses its index; LIKE would not (it folds case).
        const row = db
            .query<{ cwd: string }, [string, string, string]>(`
                SELECT cwd FROM session_metadata
                WHERE session_id >= ? AND session_id < ? AND cwd IS NOT NULL AND cwd <> ''
                ORDER BY (session_id = ?3) DESC, COALESCE(is_subagent, 0) ASC, mtime DESC
                LIMIT 1
            `)
            .get(options.sessionId, `${options.sessionId}￿`, options.sessionId);

        return row?.cwd ?? null;
    } finally {
        db.close();
    }
}
