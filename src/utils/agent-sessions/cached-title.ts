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
