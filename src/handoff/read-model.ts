import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { parseJsonlChunk } from "@genesiscz/utils/jsonl";
import { logger } from "@genesiscz/utils/logger";
import { applyHandoffEvent } from "./fold";
import { handoffLogDir } from "./log-store";
import type { FoldOutcome, Handoff, HandoffEvent, HandoffPublicEvent } from "./types";

const log = logger.child({ component: "handoff:read-model" });

/** Same db the /qa dashboard opens — handoffs ARE the QA family (spec §6.2). */
export function handoffDbPath(): string {
    return join(homedir(), ".genesis-tools", "question", "qa.db");
}

function ensureColumn(db: Database, table: string, column: string, ddl: string): void {
    const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];

    if (!cols.some((c) => c.name === column)) {
        db.exec(ddl);
    }
}

function tableExists(db: Database, name: string): boolean {
    const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as {
        name: string;
    } | null;
    return row != null;
}

/** Strip editId before any events read-model persistence or public return (G3). */
export function toPublicEvent(event: HandoffEvent): HandoffPublicEvent {
    const { editId: _editId, ...rest } = event;
    return rest;
}

function createTables(db: Database): { eventsTableCreated: boolean } {
    const hadEventsTable = tableExists(db, "handoff_events");

    db.exec(`CREATE TABLE IF NOT EXISTS handoffs (
        id                     TEXT PRIMARY KEY,
        title                  TEXT NOT NULL,
        description            TEXT,
        status                 TEXT NOT NULL DEFAULT 'open',
        tasks                  TEXT NOT NULL,
        target                 TEXT,
        refs                   TEXT,
        posted_by_context      TEXT NOT NULL,
        posted_by_session_id   TEXT,
        posted_by_session_name TEXT,
        project                TEXT,
        claimed_by             TEXT NOT NULL DEFAULT '[]',
        comments               TEXT NOT NULL DEFAULT '[]',
        edit_id                TEXT,
        created_ts             TEXT NOT NULL,
        updated_ts             TEXT NOT NULL,
        finished_ts            TEXT
    );`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_handoffs_status  ON handoffs(status);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_handoffs_updated ON handoffs(updated_ts);");
    db.exec(
        "CREATE TABLE IF NOT EXISTS handoff_ingest_offsets ( file TEXT PRIMARY KEY, byte_offset INTEGER NOT NULL );"
    );
    // Fold outcomes keyed by event uid: lets the appending process report truthful
    // per-action results even when a concurrent process folded its batch first
    // (§6.1 rules 2+4 — the CAS skip would otherwise lose the outcomes).
    db.exec(`CREATE TABLE IF NOT EXISTS handoff_event_results (
        uid        TEXT PRIMARY KEY,
        handoff_id TEXT,
        ev         TEXT,
        ok         INTEGER NOT NULL,
        error      TEXT,
        extra      TEXT,
        ts         TEXT
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS handoff_events (
        uid        TEXT PRIMARY KEY,
        handoff_id TEXT NOT NULL,
        ts         TEXT NOT NULL,
        ev         TEXT NOT NULL,
        payload    TEXT NOT NULL
    );`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_handoff_events_handoff ON handoff_events(handoff_id, ts);");
    ensureColumn(
        db,
        "handoffs",
        "attachments",
        "ALTER TABLE handoffs ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'"
    );
    // Who finished it — needed for the reopen-by-finisher credential (§2 reopen_handoff).
    ensureColumn(db, "handoffs", "finished_by", "ALTER TABLE handoffs ADD COLUMN finished_by TEXT");

    return { eventsTableCreated: !hadEventsTable && tableExists(db, "handoff_events") };
}

export function openHandoffModel(dbPath?: string): Database {
    const path = dbPath ?? handoffDbPath();
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    const { eventsTableCreated } = createTables(db);

    // One-time migration: table born under a non-empty handoffs → backfill via rebuild (G1).
    if (eventsTableCreated && tableExists(db, "handoffs")) {
        const count = (db.query("SELECT COUNT(*) AS n FROM handoffs").get() as { n: number }).n;

        if (count > 0) {
            log.info({ count }, "handoff_events table created under existing handoffs — rebuilding to backfill");
            rebuildHandoffModel(db);
        }
    }

    log.debug({ path }, "handoff read-model opened");
    return db;
}

interface HandoffRow {
    id: string;
    title: string;
    description: string | null;
    status: string;
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

function rowToHandoff(row: HandoffRow): Handoff {
    const postedByContext = SafeJSON.parse(row.posted_by_context, { strict: true }) as Handoff["postedByContext"];
    const claimedRaw = SafeJSON.parse(row.claimed_by, { strict: true }) as Array<{
        sessionId: string | null;
        sessionName: string | null;
        branch: string | null;
        cwd: string | null;
        claimedAt: string;
        via: Handoff["claimedBy"][number]["via"];
        repoRoot?: string | null;
        commitSha?: string | null;
        agent?: string;
    }>;
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
        status: row.status as Handoff["status"],
        tasks: SafeJSON.parse(row.tasks, { strict: true }) as Handoff["tasks"],
        postedBy: {
            sessionId: row.posted_by_session_id,
            sessionName: row.posted_by_session_name,
            agent: postedByContext.agent,
            ...(postedByContext.via !== undefined ? { via: postedByContext.via } : {}),
        },
        postedByContext,
        project: row.project,
        claimedBy,
        comments: SafeJSON.parse(row.comments, { strict: true }) as Handoff["comments"],
        attachments: SafeJSON.parse(row.attachments, { strict: true }) as Handoff["attachments"],
        editId: row.edit_id ?? "",
        createdTs: row.created_ts,
        updatedTs: row.updated_ts,
    };

    if (row.description !== null) {
        handoff.description = row.description;
    }

    if (row.target !== null) {
        handoff.target = SafeJSON.parse(row.target, { strict: true }) as Handoff["target"];
    }

    if (row.refs !== null) {
        handoff.refs = SafeJSON.parse(row.refs, { strict: true }) as string[];
    }

    if (row.finished_ts !== null) {
        handoff.finishedTs = row.finished_ts;
    }

    if (row.finished_by !== null) {
        handoff.finishedBy = SafeJSON.parse(row.finished_by, { strict: true }) as Handoff["finishedBy"];
    }

    return handoff;
}

const UPSERT_SQL = `INSERT OR REPLACE INTO handoffs
    (id, title, description, status, tasks, target, refs, posted_by_context, posted_by_session_id,
     posted_by_session_name, project, claimed_by, comments, edit_id, created_ts, updated_ts,
     finished_ts, attachments, finished_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

function upsertHandoff(db: Database, h: Handoff): void {
    db.prepare(UPSERT_SQL).run(
        h.id,
        h.title,
        h.description ?? null,
        h.status,
        SafeJSON.stringify(h.tasks, { strict: true }),
        h.target !== undefined ? SafeJSON.stringify(h.target, { strict: true }) : null,
        h.refs !== undefined ? SafeJSON.stringify(h.refs, { strict: true }) : null,
        SafeJSON.stringify(h.postedByContext, { strict: true }),
        h.postedBy.sessionId,
        h.postedBy.sessionName,
        h.project,
        SafeJSON.stringify(h.claimedBy, { strict: true }),
        SafeJSON.stringify(h.comments, { strict: true }),
        h.editId,
        h.createdTs,
        h.updatedTs,
        h.finishedTs ?? null,
        SafeJSON.stringify(h.attachments, { strict: true }),
        h.finishedBy !== undefined ? SafeJSON.stringify(h.finishedBy, { strict: true }) : null
    );
}

export function getHandoffById(db: Database, id: string): Handoff | null {
    const row = db.query("SELECT * FROM handoffs WHERE id = ?").get(id) as HandoffRow | null;
    return row ? rowToHandoff(row) : null;
}

export function listHandoffRows(db: Database, opts: { statuses?: string[]; project?: string } = {}): Handoff[] {
    const where: string[] = [];
    const params: string[] = [];

    if (opts.statuses !== undefined && opts.statuses.length > 0) {
        where.push(`status IN (${opts.statuses.map(() => "?").join(",")})`);
        params.push(...opts.statuses);
    }

    if (opts.project !== undefined) {
        where.push("project = ?");
        params.push(opts.project);
    }

    const sql = `SELECT * FROM handoffs${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_ts DESC`;
    return (db.query(sql).all(...params) as HandoffRow[]).map(rowToHandoff);
}

export function getEventOutcome(db: Database, uid: string): FoldOutcome | null {
    const row = db.query("SELECT ok, error, extra FROM handoff_event_results WHERE uid = ?").get(uid) as {
        ok: number;
        error: string | null;
        extra: string | null;
    } | null;

    if (!row) {
        return null;
    }

    const extra = row.extra !== null ? (SafeJSON.parse(row.extra, { strict: true }) as Partial<FoldOutcome>) : {};
    const outcome: FoldOutcome = { applied: row.ok === 1, ...extra };

    if (row.error !== null) {
        outcome.error = row.error;
    }

    return outcome;
}

export function listHandoffEvents({
    db,
    handoffId,
    limit = 200,
    before,
}: {
    db: Database;
    handoffId: string;
    limit?: number;
    before?: string;
}): { events: HandoffPublicEvent[]; total: number } {
    const clamped = Math.min(1000, Math.max(1, Math.floor(limit)));
    const total = (
        db.query("SELECT COUNT(*) AS n FROM handoff_events WHERE handoff_id = ?").get(handoffId) as { n: number }
    ).n;

    const rows =
        before !== undefined
            ? (db
                  .query(
                      `SELECT payload FROM handoff_events
                       WHERE handoff_id = ? AND ts < ?
                       ORDER BY ts DESC LIMIT ?`
                  )
                  .all(handoffId, before, clamped) as { payload: string }[])
            : (db
                  .query(
                      `SELECT payload FROM handoff_events
                       WHERE handoff_id = ?
                       ORDER BY ts DESC LIMIT ?`
                  )
                  .all(handoffId, clamped) as { payload: string }[]);

    const events = rows.map((row) => SafeJSON.parse(row.payload, { strict: true }) as HandoffPublicEvent);
    return { events, total };
}

/**
 * Lazily ingest JSONL bytes newer than the stored offsets and fold them into the
 * handoffs table. Deterministic order: files sorted by name (date), lines by
 * position (§6.1 rule 1). The ingest offset is re-read INSIDE the write
 * transaction (compare-and-set): if another process already advanced it past
 * this batch's start, the whole batch is skipped — delta events can never
 * double-apply (§6.1 rule 2; deliberate divergence from the question store's
 * read-offset-outside-tx idiom). A CAS skip only proves *some* batch reached
 * the offset it landed on, not that it reached THIS read's end, so each file
 * is retried from the freshly committed offset until it is fully caught up.
 */
export function catchUpHandoffs(db: Database, base?: string): void {
    const dir = handoffLogDir(base);

    if (!existsSync(dir)) {
        return;
    }

    const getOff = db.prepare("SELECT byte_offset FROM handoff_ingest_offsets WHERE file = ?");

    for (const name of readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()) {
        const file = join(dir, name);

        for (;;) {
            let size: number;

            try {
                size = statSync(file).size;
            } catch (err) {
                log.warn({ err, file }, "skipping handoff log file — stat failed (likely removed concurrently)");
                break;
            }

            const prev = (getOff.get(file) as { byte_offset: number } | null)?.byte_offset ?? 0;

            if (size <= prev) {
                break;
            }

            let buf: Buffer;

            try {
                buf = readSuffix(file, prev, size);
            } catch (err) {
                log.warn({ err, file }, "skipping handoff log file — read failed (likely removed concurrently)");
                break;
            }

            let events: HandoffEvent[];
            let remainder: Buffer;

            try {
                const parsed = parseJsonlChunk<HandoffEvent>(buf);
                events = parsed.values;
                remainder = parsed.remainder;
            } catch (err) {
                log.warn({ err, file }, "skipping unparseable handoff JSONL tail");
                break;
            }

            const consumed = buf.length - remainder.length;

            if (events.length === 0) {
                break;
            }

            const applied = applyHandoffBatch({ db, file, prevOffset: prev, events, consumed, base });

            if (applied) {
                break;
            }

            // CAS skip: another process advanced the offset concurrently — loop and
            // retry from wherever it landed instead of dropping the remainder.
        }
    }
}

/** Read only the unconsumed suffix of a file — avoids reloading the whole day-log on every fold. */
function readSuffix(file: string, start: number, size: number): Buffer {
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    const fd = openSync(file, "r");
    let total = 0;

    try {
        // readSync may return short; the file may also have been truncated/replaced
        // since statSync. Loop until the snapshot is filled or EOF (bytesRead 0).
        while (total < length) {
            const bytesRead = readSync(fd, buf, total, length - total, start + total);
            if (bytesRead === 0) {
                break;
            }

            total += bytesRead;
        }
    } finally {
        closeSync(fd);
    }

    return total === length ? buf : buf.subarray(0, total);
}

export interface ApplyBatchInput {
    db: Database;
    file: string;
    /** The offset read OUTSIDE the transaction — the CAS compare value. */
    prevOffset: number;
    events: HandoffEvent[];
    consumed: number;
    base?: string;
}

/**
 * One CAS-guarded fold batch (§6.1 rule 2). Returns false when skipped because
 * another process advanced the offset first — the batch then already folded
 * elsewhere and its outcomes are readable via getEventOutcome.
 */
export function applyHandoffBatch({ db, file, prevOffset, events, consumed, base }: ApplyBatchInput): boolean {
    const getOff = db.prepare("SELECT byte_offset FROM handoff_ingest_offsets WHERE file = ?");
    const setOff = db.prepare("INSERT OR REPLACE INTO handoff_ingest_offsets (file, byte_offset) VALUES (?, ?)");
    const putOutcome = db.prepare(
        "INSERT OR REPLACE INTO handoff_event_results (uid, handoff_id, ev, ok, error, extra, ts) VALUES (?,?,?,?,?,?,?)"
    );
    const putEvent = db.prepare(
        "INSERT OR IGNORE INTO handoff_events (uid, handoff_id, ts, ev, payload) VALUES (?,?,?,?,?)"
    );
    let applied = false;

    const tx = db.transaction(() => {
        // CAS: another fold may have raced us between the outside read and here.
        const current = (getOff.get(file) as { byte_offset: number } | null)?.byte_offset ?? 0;

        if (current !== prevOffset) {
            log.debug({ file, prevOffset, current }, "handoff fold batch skipped — offset advanced concurrently (CAS)");
            return;
        }

        const states = new Map<string, Handoff | null>();

        for (const event of events) {
            if (!states.has(event.id)) {
                states.set(event.id, getHandoffById(db, event.id));
            }

            const { state, outcome } = applyHandoffEvent(states.get(event.id) ?? null, event, { base });
            states.set(event.id, state);

            if (event.ev === "post" && !outcome.applied) {
                log.error({ id: event.id, file }, "duplicate handoff post id — first wins, event skipped");
            }

            const extra: Partial<FoldOutcome> = {};

            if (outcome.info !== undefined) {
                extra.info = outcome.info;
            }

            if (outcome.noop !== undefined) {
                extra.noop = outcome.noop;
            }

            if (outcome.assignedTaskIds !== undefined) {
                extra.assignedTaskIds = outcome.assignedTaskIds;
            }

            putOutcome.run(
                event.uid,
                event.id,
                event.ev,
                outcome.applied ? 1 : 0,
                outcome.error ?? null,
                Object.keys(extra).length > 0 ? SafeJSON.stringify(extra, { strict: true }) : null,
                event.ts
            );

            // editId stripped at insert — never stored in handoff_events (G3).
            putEvent.run(
                event.uid,
                event.id,
                event.ts,
                event.ev,
                SafeJSON.stringify(toPublicEvent(event), { strict: true })
            );
        }

        for (const state of states.values()) {
            if (state !== null) {
                upsertHandoff(db, state);
            }
        }

        setOff.run(file, prevOffset + consumed);
        applied = true;
    });
    tx();

    if (applied) {
        log.debug({ file, events: events.length, consumed }, "handoff fold batch applied");
    }

    return applied;
}

/** Drop + full re-fold (§6.1 rule 6). Also clears + refills handoff_events (G1). */
export function rebuildHandoffModel(db: Database, base?: string): void {
    db.exec("DROP TABLE IF EXISTS handoffs;");
    db.exec("DROP TABLE IF EXISTS handoff_ingest_offsets;");
    db.exec("DROP TABLE IF EXISTS handoff_event_results;");
    db.exec("DROP TABLE IF EXISTS handoff_events;");
    createTables(db);
    catchUpHandoffs(db, base);
    log.info("handoff read-model rebuilt from JSONL");
}
