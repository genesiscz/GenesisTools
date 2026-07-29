import type { Database } from "bun:sqlite";
import { Migrator } from "@genesiscz/utils/database/migrations";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { nowUtcIso, parseSqliteOrIsoDate } from "@genesiscz/utils/sql-time";
import type { MessageRecord, MessageRole, NewMessage, NewSession, SessionBackend, SessionRecord } from "../types";

/**
 * A `{sessions, messages}` table pair, either created here or adopted.
 *
 * Two modes, and the second is the interesting one. With `manageSchema` (the
 * default) this owns a generic pair and migrates it through the repo's Migrator.
 * With `manageSchema: false` it drives tables someone else defined — youtube's
 * `ask_sessions` / `ask_session_messages`, which predate this library, carry
 * INTEGER primary keys, ISO-text timestamps and five domain columns
 * (`scope_kind`, `video_ids_json`, `citations_json`, …) that a generic `meta`
 * blob would orphan.
 *
 * `metaColumns` is what makes that work: each entry promotes one `meta` key to
 * one real column, so `meta.citations` is still `citations_json` on disk and a
 * session written before this phase reads back with its citations intact. Meta
 * keys with neither a promotion nor a blob column to fall into are dropped, and
 * say so in the log rather than silently.
 */

const VALID_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SessionColumnMap {
    id?: string;
    owner?: string;
    title?: string;
    createdAt?: string;
    updatedAt?: string;
    /** Catch-all JSON column for meta keys with no promotion. Absent = no catch-all. */
    meta?: string;
}

export interface MessageColumnMap {
    id?: string;
    sessionId?: string;
    role?: string;
    content?: string;
    at?: string;
    meta?: string;
}

/** One `meta` key stored in its own column instead of the blob. */
export interface MetaColumn {
    column: string;
    key: string;
    /** Defaults to `json` for `*_json` columns, `text` otherwise. */
    encoding?: "json" | "text" | "integer";
}

export interface SqliteBackendOptions {
    db: Database;
    sessionsTable?: string;
    messagesTable?: string;
    columns?: { session?: SessionColumnMap; message?: MessageColumnMap };
    metaColumns?: { session?: MetaColumn[]; message?: MetaColumn[] };
    /** `epoch` = INTEGER ms (generic default); `iso` = TEXT, as youtube stores. */
    timestamps?: "epoch" | "iso";
    /** youtube's `user_id` is INTEGER; owner strings are cast at the boundary. */
    ownerType?: "text" | "integer";
    /** Create + migrate the generic tables. Pass `false` to adopt an existing schema. */
    manageSchema?: boolean;
}

type Row = Record<string, unknown>;

export function createSqliteSessionBackend(options: SqliteBackendOptions): SessionBackend {
    const { log } = logger.scoped("ai-session");
    const db = options.db;
    const sessionsTable = identifier(options.sessionsTable ?? "ai_sessions");
    const messagesTable = identifier(options.messagesTable ?? "ai_session_messages");
    const timestamps = options.timestamps ?? "epoch";
    const ownerType = options.ownerType ?? "text";
    const sessionMeta = options.metaColumns?.session ?? [];
    const messageMeta = options.metaColumns?.message ?? [];

    const sc = {
        id: identifier(options.columns?.session?.id ?? "id"),
        owner: identifier(options.columns?.session?.owner ?? "owner"),
        title: identifier(options.columns?.session?.title ?? "title"),
        createdAt: identifier(options.columns?.session?.createdAt ?? "created_at"),
        updatedAt: identifier(options.columns?.session?.updatedAt ?? "updated_at"),
        meta: optionalIdentifier(
            options.columns?.session?.meta ?? (options.manageSchema === false ? undefined : "meta_json")
        ),
    };
    const mc = {
        id: identifier(options.columns?.message?.id ?? "id"),
        sessionId: identifier(options.columns?.message?.sessionId ?? "session_id"),
        role: identifier(options.columns?.message?.role ?? "role"),
        content: identifier(options.columns?.message?.content ?? "content"),
        at: identifier(options.columns?.message?.at ?? "created_at"),
        meta: optionalIdentifier(
            options.columns?.message?.meta ?? (options.manageSchema === false ? undefined : "meta_json")
        ),
    };

    for (const column of [...sessionMeta, ...messageMeta]) {
        identifier(column.column);
    }

    if (options.manageSchema !== false) {
        new Migrator(
            db,
            [
                {
                    id: "create-session-tables",
                    description: "generic session + message table pair",
                    apply: (target) => {
                        target.exec(`
                            CREATE TABLE IF NOT EXISTS ${sessionsTable} (
                                ${sc.id} INTEGER PRIMARY KEY AUTOINCREMENT,
                                ${sc.owner} TEXT NOT NULL,
                                ${sc.title} TEXT NOT NULL,
                                ${sc.meta ?? "meta_json"} TEXT,
                                ${sc.createdAt} ${timestamps === "iso" ? "TEXT" : "INTEGER"} NOT NULL,
                                ${sc.updatedAt} ${timestamps === "iso" ? "TEXT" : "INTEGER"} NOT NULL
                            );
                            CREATE INDEX IF NOT EXISTS idx_${sessionsTable}_owner
                                ON ${sessionsTable}(${sc.owner}, ${sc.updatedAt} DESC);

                            CREATE TABLE IF NOT EXISTS ${messagesTable} (
                                ${mc.id} INTEGER PRIMARY KEY AUTOINCREMENT,
                                ${mc.sessionId} INTEGER NOT NULL,
                                ${mc.role} TEXT NOT NULL,
                                ${mc.content} TEXT NOT NULL,
                                ${mc.meta ?? "meta_json"} TEXT,
                                ${mc.at} ${timestamps === "iso" ? "TEXT" : "INTEGER"} NOT NULL
                            );
                            CREATE INDEX IF NOT EXISTS idx_${messagesTable}_session
                                ON ${messagesTable}(${mc.sessionId}, ${mc.id} ASC);
                        `);
                    },
                },
            ],
            { tableName: sessionsTable }
        ).run();
    }

    function now(): string | number {
        return timestamps === "iso" ? nowUtcIso() : Date.now();
    }

    function readTime(value: unknown): number {
        if (typeof value === "number") {
            return value;
        }

        const parsed = parseSqliteOrIsoDate(typeof value === "string" ? value : null);

        return parsed ? parsed.getTime() : 0;
    }

    function ownerValue(owner: string): string | number {
        return ownerType === "integer" ? Number(owner) : owner;
    }

    /** Splits `meta` into promoted column values plus whatever is left over for the blob. */
    function splitMeta(
        meta: Record<string, unknown> | undefined,
        promoted: MetaColumn[],
        blob: string | undefined,
        what: string
    ): { columns: string[]; values: Array<string | number | null> } {
        const columns: string[] = [];
        const values: Array<string | number | null> = [];
        const rest: Record<string, unknown> = { ...(meta ?? {}) };

        for (const column of promoted) {
            const value = rest[column.key];
            delete rest[column.key];

            if (value === undefined) {
                continue;
            }

            columns.push(column.column);
            values.push(encodeMeta(column, value));
        }

        const leftover = Object.keys(rest);

        if (blob) {
            if (leftover.length > 0) {
                columns.push(blob);
                values.push(SafeJSON.stringify(rest, { strict: true }));
            }
        } else if (leftover.length > 0) {
            log.warn({ keys: leftover, what }, "no column for these meta keys — dropped");
        }

        return { columns, values };
    }

    function readMeta(row: Row, promoted: MetaColumn[], blob: string | undefined): Record<string, unknown> | undefined {
        const meta: Record<string, unknown> = {};

        if (blob && typeof row[blob] === "string" && row[blob]) {
            const parsed = SafeJSON.parse(String(row[blob]), { strict: true, unbox: true });

            if (parsed && typeof parsed === "object") {
                Object.assign(meta, parsed);
            }
        }

        for (const column of promoted) {
            const raw = row[column.column];

            if (raw === undefined || raw === null) {
                continue;
            }

            meta[column.key] = decodeMeta(column, raw);
        }

        return Object.keys(meta).length > 0 ? meta : undefined;
    }

    function toSession(row: Row): SessionRecord {
        return {
            id: String(row[sc.id]),
            owner: String(row[sc.owner]),
            title: String(row[sc.title]),
            createdAt: readTime(row[sc.createdAt]),
            updatedAt: readTime(row[sc.updatedAt]),
            meta: readMeta(row, sessionMeta, sc.meta),
        };
    }

    function toMessage(row: Row): MessageRecord {
        return {
            id: String(row[mc.id]),
            sessionId: String(row[mc.sessionId]),
            role: String(row[mc.role]) as MessageRole,
            content: String(row[mc.content]),
            at: readTime(row[mc.at]),
            meta: readMeta(row, messageMeta, mc.meta),
        };
    }

    return {
        async create(session: NewSession): Promise<SessionRecord> {
            const stamp = now();
            const extra = splitMeta(session.meta, sessionMeta, sc.meta, `${sessionsTable} session meta`);
            const columns = [sc.owner, sc.title, sc.createdAt, sc.updatedAt, ...extra.columns];
            const values: Array<string | number | null> = [
                ownerValue(session.owner),
                session.title,
                stamp,
                stamp,
                ...extra.values,
            ];
            const row = db
                .query<Row, Array<string | number | null>>(
                    `INSERT INTO ${sessionsTable} (${columns.join(", ")})
                     VALUES (${columns.map(() => "?").join(", ")}) RETURNING *`
                )
                .get(...values);

            if (!row) {
                throw new Error(`createSession: insert into ${sessionsTable} returned no row`);
            }

            return toSession(row);
        },

        async byTitle(owner: string, title: string): Promise<SessionRecord | undefined> {
            const row = db
                .query<Row, [string | number, string]>(
                    `SELECT * FROM ${sessionsTable} WHERE ${sc.owner} = ? AND ${sc.title} = ?
                     ORDER BY ${sc.id} DESC LIMIT 1`
                )
                .get(ownerValue(owner), title);

            return row ? toSession(row) : undefined;
        },

        async byId(id: string): Promise<SessionRecord | undefined> {
            const row = db
                .query<Row, [string | number]>(`SELECT * FROM ${sessionsTable} WHERE ${sc.id} = ?`)
                .get(idValue(id));

            return row ? toSession(row) : undefined;
        },

        async list(owner: string): Promise<SessionRecord[]> {
            const rows = db
                .query<Row, [string | number]>(
                    `SELECT * FROM ${sessionsTable} WHERE ${sc.owner} = ?
                     ORDER BY ${sc.updatedAt} DESC, ${sc.id} DESC`
                )
                .all(ownerValue(owner));

            return rows.map(toSession);
        },

        async append(message: NewMessage): Promise<MessageRecord> {
            const extra = splitMeta(message.meta, messageMeta, mc.meta, `${messagesTable} message meta`);
            const columns = [mc.sessionId, mc.role, mc.content, mc.at, ...extra.columns];
            const values: Array<string | number | null> = [
                idValue(message.sessionId),
                message.role,
                message.content,
                now(),
                ...extra.values,
            ];
            const row = db
                .query<Row, Array<string | number | null>>(
                    `INSERT INTO ${messagesTable} (${columns.join(", ")})
                     VALUES (${columns.map(() => "?").join(", ")}) RETURNING *`
                )
                .get(...values);

            if (!row) {
                throw new Error(`appendMessage: insert into ${messagesTable} returned no row`);
            }

            return toMessage(row);
        },

        async messages(id: string): Promise<MessageRecord[]> {
            const rows = db
                .query<Row, [string | number]>(
                    `SELECT * FROM ${messagesTable} WHERE ${mc.sessionId} = ? ORDER BY ${mc.id} ASC`
                )
                .all(idValue(id));

            return rows.map(toMessage);
        },

        async touch(id: string): Promise<void> {
            db.run(`UPDATE ${sessionsTable} SET ${sc.updatedAt} = ? WHERE ${sc.id} = ?`, [now(), idValue(id)]);
        },
    };
}

/** SessionIds are strings; an INTEGER PRIMARY KEY only matches when bound as a number. */
function idValue(id: string): string | number {
    return /^\d+$/.test(id) ? Number(id) : id;
}

function encodeMeta(column: MetaColumn, value: unknown): string | number | null {
    const encoding = column.encoding ?? (column.column.endsWith("_json") ? "json" : "text");

    if (encoding === "json") {
        return SafeJSON.stringify(value, { strict: true });
    }

    if (encoding === "integer") {
        return typeof value === "number" ? value : Number(value);
    }

    return typeof value === "string" ? value : SafeJSON.stringify(value, { strict: true });
}

function decodeMeta(column: MetaColumn, raw: unknown): unknown {
    const encoding = column.encoding ?? (column.column.endsWith("_json") ? "json" : "text");

    if (encoding !== "json") {
        return raw;
    }

    try {
        return SafeJSON.parse(String(raw), { strict: true, unbox: true });
    } catch (error) {
        logger.warn({ column: column.column, err: error }, "session meta column holds unreadable JSON");

        return undefined;
    }
}

function identifier(name: string): string {
    if (!VALID_IDENTIFIER.test(name)) {
        throw new Error(`Invalid SQL identifier: ${name}`);
    }

    return name;
}

function optionalIdentifier(name: string | undefined): string | undefined {
    return name === undefined ? undefined : identifier(name);
}
