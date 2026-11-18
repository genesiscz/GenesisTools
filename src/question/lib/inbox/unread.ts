import { runMigrations } from "@genesiscz/utils/database/migrations";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { PENDING_MIGRATIONS } from "../pending/store";
import { readQuestionSnapshot } from "../read-model";

/** The cut-offs the badges count against, applied to every item before it is grouped. */
export interface WidgetInboxWindow {
    /** The last "Mark all read": only items after it count. */
    clearedAt: number;
    /** A quiet session's items count only from here on (`INBOX_STALE_MS` before now). */
    staleBefore: number;
}
export interface WidgetInboxGroup {
    id: string;
    sessionId: string;
    provider: string;
    title: string;
    project: string;
    cwd: string;
    /** The group's newest item. */
    at: number;
    count: number;
    /** The newest item's own title: an answer's question. */
    itemTitle?: string | null;
    /** The newest answer's Q→A tag: `message` for an agent message (inbox_send, a tools rm request notice). */
    itemTag?: string | null;
    /** A `message` item's stored markdown, cut to `MESSAGE_PREVIEW_CHARS` + 1 so the reader can tell it was cut. */
    messageText?: string | null;
    /** A `message` item's sender label, else its source (`cli`). */
    sender?: string | null;
    /** Items after the window's `clearedAt`. */
    afterClear: number;
    /** Of those, the ones at or after `staleBefore`: what a quiet session counts. */
    recentAfterClear: number;
    /**
     * `recentAfterClear` summed over EVERY group, the ones past the row limit too, on every row. The groups the
     * snapshot never sees are counted by this session-blind rule; the listed ones by their session's freshness.
     */
    recentAfterClearTotal: number;
}

/**
 * The unread answers the badges count. The waiting items (decisions, forms, dialogs) are not here: the waiting set
 * (`waitingSet`) counts them from the rows the snapshot already read.
 */
export interface WidgetInboxData {
    answers: WidgetInboxGroup[];
    complete: boolean;
    truncated: boolean;
}
/**
 * Per session and provider, each group's newest item and its counts. `afterClear` and `recentAfterClear` count the
 * group's ITEMS against the window (?1 = clearedAt, ?2 = staleBefore), so a new item in a session never brings back
 * the older items "Mark all read" cleared or the stale ones beside it.
 */
const INBOX_GROUP = "PARTITION BY sessionId,provider,messageKind,externalProject,externalSender";
const INBOX_WINDOW_COUNTS = `SUM(CASE WHEN at > ?1 THEN 1 ELSE 0 END) OVER (${INBOX_GROUP}) AS afterClear,
                        SUM(CASE WHEN at > ?1 AND at >= ?2 THEN 1 ELSE 0 END) OVER (${INBOX_GROUP}) AS recentAfterClear,
                        SUM(CASE WHEN at > ?1 AND at >= ?2 THEN 1 ELSE 0 END) OVER (PARTITION BY messageKind) AS recentAfterClearTotal`;

export const MESSAGE_PREVIEW_CHARS = 800;

export function readInboxData(window: WidgetInboxWindow): WidgetInboxData {
    const bounds: [number, number] = [window.clearedAt, window.staleBefore];
    return readQuestionSnapshot({
        dbPath: toolDataDir("question", "qa.db"),
        read: (db) => {
            runMigrations(db, PENDING_MIGRATIONS, { tableName: "qa_pending" });
            const answers = db
                .query<WidgetInboxGroup, [number, number]>(`
                WITH unseen AS (
                    SELECT id, COALESCE(NULLIF(session_id,''),id) AS sessionId,
                        CASE WHEN agent IN ('claude','claude-code') THEN 'claude'
                             WHEN agent IN ('codex','grok') THEN agent ELSE 'unknown' END AS provider,
                        COALESCE(session_title,session_id,id) AS title, COALESCE(project,'') AS project,
                        COALESCE(cwd,'') AS cwd, ts AS at, substr(question,1,400) AS itemTitle, tag AS itemTag, CASE WHEN tag = 'message' THEN 1 ELSE 0 END AS messageKind,
                        CASE WHEN session_id='unknown' AND tag='message' THEN project END AS externalProject,
                        CASE WHEN session_id='unknown' AND tag='message' THEN COALESCE(NULLIF(trim(agent_label),''),source) END AS externalSender
                    FROM entries WHERE read_at IS NULL AND superseded_by IS NULL
                        AND NOT EXISTS (SELECT 1 FROM qa_pending WHERE entry_id=entries.id)
                ), ranked AS (
                    SELECT *, COUNT(*) OVER (${INBOX_GROUP}) AS count,
                        ${INBOX_WINDOW_COUNTS},
                        ROW_NUMBER() OVER (${INBOX_GROUP} ORDER BY at DESC,id DESC) AS position
                    FROM unseen
                ), newest AS (
                    SELECT * FROM ranked WHERE position=1 ORDER BY at DESC,id DESC LIMIT 257
                ) SELECT newest.id,sessionId,provider,title,newest.project,newest.cwd,at,count,itemTitle,itemTag,afterClear,recentAfterClear,
                    recentAfterClearTotal, substr(msg.answer_md,1,${MESSAGE_PREVIEW_CHARS + 1}) AS messageText,
                    COALESCE(NULLIF(trim(msg.agent_label),''),msg.source) AS sender
                  FROM newest LEFT JOIN entries msg ON itemTag='message' AND msg.id=newest.id ORDER BY at DESC,newest.id DESC
            `)
                .all(...bounds);
            return {
                answers: answers.slice(0, 256),
                complete: true,
                truncated: answers.length > 256,
            };
        },
    });
}
