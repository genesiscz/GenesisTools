import { runMigrations } from "@genesiscz/utils/database/migrations";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { sliceWhole } from "@genesiscz/utils/string";
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
    reply?: InboxReply;
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
    recentByKind?: { answer: number; message: number };
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

const UNSEEN = `unseen AS (
    SELECT id, COALESCE(NULLIF(session_id,''),id) AS sessionId,
        CASE WHEN agent IN ('claude','claude-code') THEN 'claude'
             WHEN agent IN ('codex','grok') THEN agent ELSE 'unknown' END AS provider,
        COALESCE(session_title,session_id,id) AS title, COALESCE(project,'') AS project,
        COALESCE(cwd,'') AS cwd, ts AS at, substr(question,1,400) AS itemTitle, tag AS itemTag, CASE WHEN tag = 'message' THEN 1 ELSE 0 END AS messageKind,
        CASE WHEN session_id='unknown' AND tag='message' THEN project END AS externalProject,
        CASE WHEN session_id='unknown' AND tag='message' THEN COALESCE(NULLIF(trim(agent_label),''),source) END AS externalSender
    FROM entries WHERE read_at IS NULL AND superseded_by IS NULL
        AND NOT EXISTS (SELECT 1 FROM qa_pending WHERE entry_id=entries.id)
)`;

export const MESSAGE_PREVIEW_CHARS = 800;
export const REPLY_QUESTION_CHARS = 1200;

export function cleanVisibleContext(text: string): string {
    return text.replace(/<from(?:Image|Video)>[\s\S]*?<\/from(?:Image|Video)>/g, "").trim();
}

interface InboxReply {
    question: string;
    text: string;
    more?: true;
}

function visibleReply(question: string, text: string): InboxReply {
    return {
        question: sliceWhole(question, REPLY_QUESTION_CHARS),
        text: sliceWhole(text, MESSAGE_PREVIEW_CHARS),
        ...(question.length > REPLY_QUESTION_CHARS || text.length > MESSAGE_PREVIEW_CHARS
            ? { more: true as const }
            : {}),
    };
}

export function inboxReply(question: string, answer: string): InboxReply {
    return visibleReply(cleanVisibleContext(question), cleanVisibleContext(answer));
}

// Keep the same whitespace as String.trim(). SQLite transfers only cap + 1 Unicode code points per field;
// the extra point lets visibleReply enforce the wire's UTF-16 limit and report a cut.
const PREVIEW_SPACE =
    "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";
const PREVIEW_PROJECTION = `
    preview_fields AS (
        SELECT id, 'question' AS field, question AS text, ${REPLY_QUESTION_CHARS + 1} AS cap FROM preview_source
        UNION ALL
        SELECT id, 'answer', answer, ${MESSAGE_PREVIEW_CHARS + 1} FROM preview_source
    ), markers AS (
        SELECT id,field,text,cap,'<fromImage>' AS image,'<fromVideo>' AS video FROM preview_fields
    ), visible(id,field,cap,prefix,tail,opening,closing,image,video) AS (
        SELECT id,field,cap,'',COALESCE(text,''),0,0,image,video FROM markers
        UNION ALL
        SELECT id,field,cap,
            CASE WHEN closing > 0 THEN prefix || substr(tail,1,opening-1) ELSE prefix END,
            CASE WHEN closing > 0 THEN substr(tail,closing+12) ELSE tail END,
            CASE WHEN opening=0 THEN
                coalesce(min(nullif(instr(tail,image),0),nullif(instr(tail,video),0)),
                         nullif(instr(tail,image),0),nullif(instr(tail,video),0),-1)
                WHEN closing=0 THEN opening ELSE 0 END,
            CASE WHEN opening>0 AND closing=0 THEN
                opening + 10 + coalesce(
                    min(nullif(instr(substr(tail,opening+11),'</fromImage>'),0),
                        nullif(instr(substr(tail,opening+11),'</fromVideo>'),0)),
                    nullif(instr(substr(tail,opening+11),'</fromImage>'),0),
                    nullif(instr(substr(tail,opening+11),'</fromVideo>'),0),-opening-11)
                ELSE 0 END,
            image,video
        FROM visible WHERE opening>=0 AND closing>=0
    ), previews AS (
        SELECT id,field,substr(trim(prefix || tail,${PREVIEW_SPACE}),1,cap) AS text
        FROM visible WHERE opening<0 OR closing<0
    )`;

export interface InboxGroupEntry {
    id: string;
    at: number;
    question: string;
    text: string;
    more?: true;
}

export function readInboxGroupEntries({
    id,
    limit,
    window,
    sessionIsFresh,
}: {
    id: string;
    limit: number;
    window: WidgetInboxWindow;
    sessionIsFresh?: (anchor: { sessionId: string; provider: string; cwd: string }) => boolean;
}): InboxGroupEntry[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
        throw new Error("Choose a group limit between 1 and 20.");
    }

    return readQuestionSnapshot({
        dbPath: toolDataDir("question", "qa.db"),
        read: (db) => {
            runMigrations(db, PENDING_MIGRATIONS, { tableName: "qa_pending" });
            const anchor = db
                .query<{ sessionId: string; provider: string; cwd: string }, [string, number]>(`
                WITH ${UNSEEN}
                SELECT sessionId,provider,cwd FROM unseen WHERE id=?1 AND at>?2 AND messageKind=0
            `)
                .get(id, window.clearedAt);

            if (!anchor) {
                return [];
            }

            const staleBefore = sessionIsFresh?.(anchor) ? 0 : window.staleBefore;
            const rows = db
                .query<{ id: string; at: number; question: string; answer: string }, [string, number, number, number]>(`
                WITH RECURSIVE ${UNSEEN}, earlier AS (
                    SELECT item.id,item.at FROM unseen anchor JOIN unseen item
                        ON item.sessionId=anchor.sessionId AND item.provider=anchor.provider
                    WHERE anchor.id=?1 AND item.messageKind=0 AND item.at>?2 AND item.at>=?3
                        AND (item.at,item.id)<(anchor.at,anchor.id)
                    ORDER BY item.at DESC,item.id DESC LIMIT ?4
                ), preview_source AS (
                    SELECT earlier.id,question,answer_md AS answer FROM earlier JOIN entries USING(id)
                ), ${PREVIEW_PROJECTION}
                SELECT earlier.id,earlier.at,q.text AS question,a.text AS answer FROM earlier
                    JOIN previews q ON q.id=earlier.id AND q.field='question'
                    JOIN previews a ON a.id=earlier.id AND a.field='answer'
                ORDER BY earlier.at DESC,earlier.id DESC
            `)
                .all(id, window.clearedAt, staleBefore, limit);
            return rows.map((row) => ({ id: row.id, at: row.at, ...visibleReply(row.question, row.answer) }));
        },
    });
}

export function readInboxData(window: WidgetInboxWindow): WidgetInboxData {
    const bounds: [number, number] = [window.clearedAt, window.staleBefore];
    return readQuestionSnapshot({
        dbPath: toolDataDir("question", "qa.db"),
        read: (db) => {
            runMigrations(db, PENDING_MIGRATIONS, { tableName: "qa_pending" });
            const answers = db
                .query<
                    WidgetInboxGroup & {
                        recentAnswers: number;
                        recentMessages: number;
                        questionText: string | null;
                        answerText: string | null;
                    },
                    [number, number]
                >(`
                WITH RECURSIVE ${UNSEEN}, ranked AS (
                    SELECT *, COUNT(*) OVER (${INBOX_GROUP}) AS count,
                        ${INBOX_WINDOW_COUNTS},
                        SUM(CASE WHEN at > ?1 AND at >= ?2 AND messageKind=0 THEN 1 ELSE 0 END) OVER () AS recentAnswers,
                        SUM(CASE WHEN at > ?1 AND at >= ?2 AND messageKind=1 THEN 1 ELSE 0 END) OVER () AS recentMessages,
                        ROW_NUMBER() OVER (${INBOX_GROUP} ORDER BY at DESC,id DESC) AS position
                    FROM unseen
                ), newest AS (
                    SELECT * FROM ranked WHERE position=1 ORDER BY at DESC,id DESC LIMIT 257
                ), preview_source AS (
                    SELECT newest.id,entries.question,entries.answer_md AS answer
                    FROM newest JOIN entries USING(id) WHERE newest.messageKind=0 AND entries.answer_md IS NOT NULL
                ), ${PREVIEW_PROJECTION}
                SELECT newest.id,sessionId,provider,title,newest.project,newest.cwd,at,count,itemTitle,itemTag,afterClear,recentAfterClear,
                    recentAfterClearTotal, recentAnswers, recentMessages,
                    q.text AS questionText, a.text AS answerText,
                    CASE WHEN messageKind=1 THEN substr(msg.answer_md,1,${MESSAGE_PREVIEW_CHARS + 1}) END AS messageText,
                    CASE WHEN messageKind=1 THEN COALESCE(NULLIF(trim(msg.agent_label),''),msg.source) END AS sender
                  FROM newest LEFT JOIN entries msg ON msg.id=newest.id
                    LEFT JOIN previews q ON q.id=newest.id AND q.field='question'
                    LEFT JOIN previews a ON a.id=newest.id AND a.field='answer'
                  ORDER BY at DESC,newest.id DESC
            `)
                .all(...bounds);
            return {
                answers: answers.slice(0, 256).map(({ questionText, answerText, ...row }) => ({
                    ...row,
                    ...(answerText != null ? { reply: visibleReply(questionText ?? "", answerText) } : {}),
                })),
                recentByKind: { answer: answers[0]?.recentAnswers ?? 0, message: answers[0]?.recentMessages ?? 0 },
                complete: true,
                truncated: answers.length > 256,
            };
        },
    });
}
