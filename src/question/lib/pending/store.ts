import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Migration, runMigrations } from "@genesiscz/utils/database/migrations";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { AskAnswer, AskForm, AskFormStatus, AskItem } from "./types";

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
 */
export function expireDueForms(db: Database, now: number = Date.now()): AskForm[] {
    const rows = db
        .query(
            "SELECT * FROM qa_pending WHERE status = 'pending' AND timeout_ms IS NOT NULL AND created_at + timeout_ms <= ?"
        )
        .all(now) as PendingRow[];

    if (rows.length === 0) {
        return [];
    }

    const update = db.prepare(
        "UPDATE qa_pending SET status = 'timeout', resolved_at = ? WHERE id = ? AND status = 'pending'"
    );
    const expired: AskForm[] = [];
    const tx = db.transaction((pending: PendingRow[]) => {
        for (const row of pending) {
            if (update.run(now, row.id).changes > 0) {
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

/**
 * Move a pending form to `answered`. Returns null when the form is gone or already
 * resolved, so a double submit cannot overwrite a recorded answer.
 */
export function markAnswered(
    db: Database,
    id: string,
    answers: Record<string, AskAnswer>,
    entryId: string | null,
    now: number = Date.now()
): AskForm | null {
    const changes = db
        .query(
            "UPDATE qa_pending SET status = 'answered', answers_json = ?, entry_id = ?, resolved_at = ? WHERE id = ? AND status = 'pending'"
        )
        .run(SafeJSON.stringify(answers), entryId, now, id).changes;

    if (changes === 0) {
        return null;
    }

    return getForm(db, id);
}

export function markCancelled(db: Database, id: string, now: number = Date.now()): AskForm | null {
    const changes = db
        .query("UPDATE qa_pending SET status = 'cancelled', resolved_at = ? WHERE id = ? AND status = 'pending'")
        .run(now, id).changes;

    if (changes === 0) {
        return null;
    }

    return getForm(db, id);
}
