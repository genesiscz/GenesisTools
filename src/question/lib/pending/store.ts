import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Migration, runMigrations } from "@genesiscz/utils/database/migrations";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { ANSWER_CLAIM_TTL_MS, type AskAnswer, type AskForm, type AskFormStatus, type AskItem } from "./types";

const log = logger.child({ component: "question:pending-store" });

/**
 * The pending table lives in the SAME file as the Q→A read model, because pending forms
 * and answered history are one hub. It is additive: `qa.db` already holds real history and
 * is never dropped or rebuilt for this.
 */
export const PENDING_MIGRATIONS: Migration[] = [
    {
        id: "001-qa-pending",
        description: "interactive ask forms awaiting an answer",
        apply: (db) => {
            db.exec(`CREATE TABLE IF NOT EXISTS qa_pending (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                resolved_at INTEGER,
                status TEXT NOT NULL,
                source TEXT,
                session_hint TEXT,
                project_path TEXT NOT NULL,
                cwd TEXT NOT NULL,
                items_json TEXT NOT NULL,
                answers_json TEXT,
                timeout_ms INTEGER,
                entry_id TEXT
            );`);
            db.exec("CREATE INDEX IF NOT EXISTS idx_qa_pending_status ON qa_pending(status, created_at);");
        },
    },
    {
        id: "002-qa-pending-claim",
        description: "an answer lease, so only one submit may write the history entry",
        apply: (db) => {
            // Additive: ADD COLUMN touches the schema only, so every existing row keeps its
            // bytes and reads the new column as NULL (no claim). The existence check is for a
            // qa.db restored from a backup that carries the column without the bookkeeping row,
            // because a second ADD COLUMN is a hard `duplicate column name` on an ordinary open.
            const columns = db.query("PRAGMA table_info(qa_pending)").all() as { name: string }[];

            if (!columns.some((column) => column.name === "claimed_at")) {
                db.exec("ALTER TABLE qa_pending ADD COLUMN claimed_at INTEGER;");
            }
        },
    },
];

export function defaultPendingDbPath(): string {
    return join(env.tools.getHome(), ".genesis-tools", "question", "qa.db");
}

export function openPendingStore(dbPath: string = defaultPendingDbPath()): Database {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    runMigrations(db, PENDING_MIGRATIONS, { tableName: "qa_pending" });
    log.debug({ dbPath }, "opened the pending ask store");

    return db;
}

interface PendingRow {
    id: string;
    created_at: number;
    resolved_at: number | null;
    status: string;
    source: string | null;
    session_hint: string | null;
    project_path: string;
    cwd: string;
    items_json: string;
    answers_json: string | null;
    timeout_ms: number | null;
    entry_id: string | null;
    claimed_at: number | null;
}

function rowToForm(row: PendingRow): AskForm {
    return {
        id: row.id,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at ?? undefined,
        status: row.status as AskFormStatus,
        source: row.source ?? undefined,
        sessionHint: row.session_hint ?? undefined,
        projectPath: row.project_path,
        cwd: row.cwd,
        items: SafeJSON.parse(row.items_json, { strict: true }) as AskItem[],
        answers: row.answers_json
            ? (SafeJSON.parse(row.answers_json, { strict: true }) as Record<string, AskAnswer>)
            : undefined,
        timeoutMs: row.timeout_ms ?? undefined,
        entryId: row.entry_id ?? undefined,
    };
}

export function insertForm(db: Database, form: AskForm): AskForm {
    db.query(
        `INSERT INTO qa_pending
         (id, created_at, resolved_at, status, source, session_hint, project_path, cwd, items_json, answers_json, timeout_ms, entry_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        form.id,
        form.createdAt,
        form.resolvedAt ?? null,
        form.status,
        form.source ?? null,
        form.sessionHint ?? null,
        form.projectPath,
        form.cwd,
        SafeJSON.stringify(form.items),
        form.answers ? SafeJSON.stringify(form.answers) : null,
        form.timeoutMs ?? null,
        form.entryId ?? null
    );

    return form;
}

/**
 * Retire every form whose `timeoutMs` elapsed while nobody was looking.
 *
 * There is no daemon here, so expiry is evaluated lazily on read — the same shape the Q→A
 * read model uses for JSONL catch-up. Returns the forms that just flipped, so a caller can
 * publish their lifecycle events.
 *
 * A form whose answer holds the claim is left alone: that answer has already written its
 * history entry, and retiring the form under it would strand that entry against a form nobody
 * answered. The lease expires, so this delays an expiry rather than cancelling one.
 */
export function expireDueForms(
    db: Database,
    now: number = Date.now(),
    claimTtlMs: number = ANSWER_CLAIM_TTL_MS
): AskForm[] {
    const claimExpiry = now - claimTtlMs;
    const rows = db
        .query(
            `SELECT * FROM qa_pending
             WHERE status = 'pending' AND timeout_ms IS NOT NULL AND created_at + timeout_ms <= ?
               AND (claimed_at IS NULL OR claimed_at <= ?)`
        )
        .all(now, claimExpiry) as PendingRow[];

    if (rows.length === 0) {
        return [];
    }

    const update = db.prepare(
        `UPDATE qa_pending SET status = 'timeout', resolved_at = ?
         WHERE id = ? AND status = 'pending' AND (claimed_at IS NULL OR claimed_at <= ?)`
    );
    const expired: AskForm[] = [];
    const tx = db.transaction((pending: PendingRow[]) => {
        for (const row of pending) {
            if (update.run(now, row.id, claimExpiry).changes > 0) {
                expired.push({ ...rowToForm(row), status: "timeout", resolvedAt: now });
            }
        }
    });
    tx(rows);
    log.info({ count: expired.length }, "retired ask forms that passed their timeout");

    return expired;
}

export function getForm(db: Database, id: string): AskForm | null {
    const row = db.query("SELECT * FROM qa_pending WHERE id = ? LIMIT 1").get(id) as PendingRow | null;

    return row ? rowToForm(row) : null;
}

export interface ListFormsOpts {
    status?: AskFormStatus;
    limit?: number;
}

export function listForms(db: Database, opts: ListFormsOpts = {}): AskForm[] {
    const where = opts.status ? "WHERE status = ?" : "";
    const params: (string | number)[] = opts.status ? [opts.status] : [];
    params.push(opts.limit ?? 50);
    const rows = db
        .query(`SELECT * FROM qa_pending ${where} ORDER BY created_at DESC LIMIT ?`)
        .all(...params) as PendingRow[];

    return rows.map(rowToForm);
}

/** Batch status poll, mirroring the Genesis `?ids=a,b` shape. A miss maps to null. */
export function getForms(db: Database, ids: string[]): Record<string, AskForm | null> {
    const out: Record<string, AskForm | null> = {};

    for (const id of ids) {
        out[id] = getForm(db, id);
    }

    return out;
}

/** A pending form held by exactly one in-flight answer. `claimedAt` IS the lease it owns. */
export interface PendingClaim {
    form: AskForm;
    claimedAt: number;
}

/**
 * Take the answer lease on a pending form, or return null when someone else holds it.
 *
 * ONE conditional UPDATE both decides and reports: the WHERE re-checks `pending` and the lease
 * in the same statement that stamps the new one, so two answerers cannot both read "free" and
 * both proceed. That is what keeps the history write exclusive — the loser is turned away here,
 * before it writes a QaEntry no form would ever point at.
 *
 * A lease older than `claimTtlMs` belongs to a process that died mid-answer, and is stolen
 * rather than waited on, so an interrupted claim can never wedge a form permanently.
 */
export function claimForm(
    db: Database,
    id: string,
    now: number = Date.now(),
    claimTtlMs: number = ANSWER_CLAIM_TTL_MS
): PendingClaim | null {
    const row = db
        .query(
            `UPDATE qa_pending SET claimed_at = ?
             WHERE id = ? AND status = 'pending' AND (claimed_at IS NULL OR claimed_at <= ?)
             RETURNING *`
        )
        .get(now, id, now - claimTtlMs) as PendingRow | null;

    if (!row) {
        return null;
    }

    return { form: rowToForm(row), claimedAt: now };
}

/**
 * Hand a claimed form back, for an answer that failed before it could finalize. Without this
 * the form would sit unanswerable until the lease ran out, for a failure already known.
 */
export function releaseClaim(db: Database, id: string, claimedAt: number): boolean {
    const changes = db
        .query("UPDATE qa_pending SET claimed_at = NULL WHERE id = ? AND status = 'pending' AND claimed_at = ?")
        .run(id, claimedAt).changes;

    return changes > 0;
}

export interface MarkAnsweredInput {
    id: string;
    answers: Record<string, AskAnswer>;
    entryId: string | null;
    /** The lease `claimForm` handed out. An answer may only close the claim it owns. */
    claimedAt: number;
    now?: number;
}

/**
 * Move a claimed form to `answered`. Returns null when the claim is no longer ours — the form
 * was resolved by someone else, or this answer outlived its own lease — so a double submit
 * cannot overwrite a recorded answer.
 */
export function markAnswered(db: Database, input: MarkAnsweredInput): AskForm | null {
    const now = input.now ?? Date.now();
    const changes = db
        .query(
            `UPDATE qa_pending
             SET status = 'answered', answers_json = ?, entry_id = ?, resolved_at = ?, claimed_at = NULL
             WHERE id = ? AND status = 'pending' AND claimed_at = ?`
        )
        .run(SafeJSON.stringify(input.answers), input.entryId, now, input.id, input.claimedAt).changes;

    if (changes === 0) {
        return null;
    }

    return getForm(db, input.id);
}

/**
 * Withdraw a pending form. Refused while an answer holds the claim, because that answer has
 * already written its history entry and cancelling out from under it would strand that entry
 * against a form nobody answered. The lease expires, so a crashed answerer delays a cancel
 * rather than blocking it.
 */
export function markCancelled(
    db: Database,
    id: string,
    now: number = Date.now(),
    claimTtlMs: number = ANSWER_CLAIM_TTL_MS
): AskForm | null {
    const changes = db
        .query(
            `UPDATE qa_pending SET status = 'cancelled', resolved_at = ?, claimed_at = NULL
             WHERE id = ? AND status = 'pending' AND (claimed_at IS NULL OR claimed_at <= ?)`
        )
        .run(now, id, now - claimTtlMs).changes;

    if (changes === 0) {
        return null;
    }

    return getForm(db, id);
}
