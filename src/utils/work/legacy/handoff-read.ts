import type { Database } from "bun:sqlite";
import { isJsonObject, SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { FoldOutcome, Handoff, HandoffClaim, HandoffPublicEvent } from "./handoff-types";

interface HandoffRow {
    id: string;
    title: string;
    name: string | null;
    description: string | null;
    status: Handoff["status"];
    tasks: string;
    target: string | null;
    refs: string | null;
    posted_by_context: string;
    posted_by_session_id: string | null;
    posted_by_session_name: string | null;
    project: string | null;
    claimed_by: string;
    comments: string;
    edit_id: string | null;
    created_ts: string;
    updated_ts: string;
    finished_ts: string | null;
    attachments: string;
    finished_by: string | null;
}

type StoredClaim = Omit<HandoffClaim, "repoRoot" | "commitSha" | "agent"> &
    Partial<Pick<HandoffClaim, "repoRoot" | "commitSha" | "agent">>;

function rowToHandoff(row: HandoffRow): Handoff {
    const postedByContext: Handoff["postedByContext"] = SafeJSON.parse(row.posted_by_context, { strict: true });
    const claimedRaw: StoredClaim[] = SafeJSON.parse(row.claimed_by, { strict: true });
    const claimedBy = claimedRaw.map((c) => ({
        sessionId: c.sessionId,
        sessionName: c.sessionName,
        branch: c.branch,
        cwd: c.cwd,
        claimedAt: c.claimedAt,
        via: c.via,
        repoRoot: c.repoRoot ?? null,
        commitSha: c.commitSha ?? null,
        agent: c.agent ?? "unknown",
    }));
    const handoff: Handoff = {
        id: row.id,
        title: row.title,
        status: row.status,
        tasks: SafeJSON.parse(row.tasks, { strict: true }),
        postedBy: {
            sessionId: row.posted_by_session_id,
            sessionName: row.posted_by_session_name,
            agent: postedByContext.agent,
            ...(postedByContext.via !== undefined ? { via: postedByContext.via } : {}),
        },
        postedByContext,
        project: row.project,
        claimedBy,
        comments: SafeJSON.parse(row.comments, { strict: true }),
        attachments: SafeJSON.parse(row.attachments, { strict: true }),
        editId: row.edit_id ?? "",
        createdTs: row.created_ts,
        updatedTs: row.updated_ts,
    };

    if (row.name !== null) {
        handoff.name = row.name;
    }

    if (row.description !== null) {
        handoff.description = row.description;
    }

    if (row.target !== null) {
        handoff.target = SafeJSON.parse(row.target, { strict: true });
    }

    if (row.refs !== null) {
        handoff.refs = SafeJSON.parse(row.refs, { strict: true });
    }

    if (row.finished_ts !== null) {
        handoff.finishedTs = row.finished_ts;
    }

    if (row.finished_by !== null) {
        handoff.finishedBy = SafeJSON.parse(row.finished_by, { strict: true });
    }

    return handoff;
}

interface HandoffListFilter {
    statuses?: string[];
    project?: string;
}

export interface HandoffEventPage {
    db: Database;
    handoffId: string;
    limit?: number;
    before?: string;
    beforeUid?: string;
}

function getHandoffById(db: Database, id: string): Handoff | null {
    const row = db.query<HandoffRow, [string]>("SELECT * FROM handoffs WHERE id = ?").get(id);
    return row === null ? null : rowToHandoff(row);
}

function findHandoffsByName(db: Database, name: string): Handoff[] {
    return db
        .query<HandoffRow, [string]>("SELECT * FROM handoffs WHERE name = ? ORDER BY updated_ts DESC")
        .all(name)
        .map(rowToHandoff);
}

function listHandoffRows(db: Database, { project, statuses }: HandoffListFilter = {}): Handoff[] {
    const filters: string[] = [];
    const params: string[] = [];

    if (statuses?.length) {
        filters.push(`status IN (${statuses.map(() => "?").join(",")})`);
        params.push(...statuses);
    }

    if (project !== undefined) {
        filters.push("project = ?");
        params.push(project);
    }

    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return db
        .query<HandoffRow, string[]>(`SELECT * FROM handoffs ${where} ORDER BY updated_ts DESC`)
        .all(...params)
        .map(rowToHandoff);
}

interface EventRow {
    payload: string;
    ok: number | null;
    error: string | null;
    extra: string | null;
}

function listHandoffEvents({ db, handoffId, limit = 200, before, beforeUid }: HandoffEventPage) {
    const size = Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.min(1000, Math.floor(limit))) : 200;
    const count = db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM handoff_events WHERE handoff_id = ?")
        .get(handoffId);
    const total = count?.n ?? 0;
    const params: (string | number)[] = [handoffId];
    let cursor = "";

    if (before !== undefined) {
        // Both columns are needed to resume in the middle of events with the same timestamp.
        cursor = beforeUid === undefined ? "AND e.ts < ?" : "AND (e.ts, e.uid) < (?, ?)";
        params.push(before);

        if (beforeUid !== undefined) {
            params.push(beforeUid);
        }
    }

    const rows = db
        .query<EventRow, (string | number)[]>(`
        SELECT e.payload, r.ok, r.error, r.extra
        FROM handoff_events e LEFT JOIN handoff_event_results r ON r.uid = e.uid
        WHERE e.handoff_id = ? ${cursor} ORDER BY e.ts DESC, e.uid DESC LIMIT ?
        `)
        .all(...params, size);
    const events = rows.map((row): HandoffPublicEvent => {
        const event: HandoffPublicEvent = SafeJSON.parse(row.payload, { strict: true });
        if (row.ok === null) {
            return event;
        }

        const extra: Partial<FoldOutcome> = row.extra === null ? {} : SafeJSON.parse(row.extra, { strict: true });
        const outcome: FoldOutcome = { applied: row.ok === 1, ...extra };

        if (row.error !== null) {
            outcome.error = row.error;
        }

        return { ...event, outcome };
    });

    return { events, total };
}

interface StoredAttachment {
    handoffId: string;
    attachmentId: string;
    filename: string;
    mime: string;
    missing: boolean;
}

export function findHandoffAttachment(db: Database, attachmentId: string): StoredAttachment | null {
    const rows = db
        .query<{ id: string; attachments: string }, [string]>(
            "SELECT id, attachments FROM handoffs WHERE attachments LIKE ?"
        )
        .all(`%${attachmentId}%`);

    for (const row of rows) {
        let attachments: unknown;
        try {
            attachments = SafeJSON.parse(row.attachments, { strict: true });
        } catch (err) {
            logger.warn({ err, handoffId: row.id }, "handoff.attachments column is not valid JSON — skipping");
            continue;
        }

        if (!Array.isArray(attachments)) {
            logger.warn({ handoffId: row.id }, "handoff.attachments column is not an array — skipping");
            continue;
        }

        const found: unknown = attachments.find(
            (entry: unknown) => isJsonObject(entry) && entry.attachmentId === attachmentId
        );
        if (!isJsonObject(found)) {
            continue;
        }

        if (typeof found.filename !== "string" || typeof found.mime !== "string") {
            logger.warn({ handoffId: row.id, attachmentId }, "attachment entry missing string filename/mime — skipping");
            continue;
        }

        return {
            handoffId: row.id,
            attachmentId,
            filename: found.filename,
            mime: found.mime,
            missing: found.missing === true,
        };
    }

    return null;
}

/** The handoff compatibility tables in work.db retain fields the item view cannot represent. */
export const handoffQueries = { getHandoffById, findHandoffsByName, listHandoffRows, listHandoffEvents };
