import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Migration, runMigrations } from "@genesiscz/utils/database/migrations";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { AncestryFrame, CallerContext } from "./caller";
import { getSayStorage } from "./storage";

const { log } = logger.scoped("say:calls");

/**
 * `started` is written by the foreground process; the speaker (detached child, or
 * the same process with `--wait` / `--output`) replaces it with the outcome. A row
 * still `started` after {@link NO_OUTCOME_AFTER_MS} means the speaker never
 * reported: it crashed, or was killed mid-playback.
 */
export type SayCallStatus = "started" | "muted" | "spoken" | "written" | "failed";

export const NO_OUTCOME_AFTER_MS = 120_000;

/** Calls whose text carries the "Attention please!!" marker from the end-of-round convention. */
const ATTENTION_PATTERN = /attention/i;

export const CALLS_MIGRATIONS: Migration[] = [
    {
        id: "001-say-calls",
        description: "one row per tools say invocation: the caller, the request and the outcome",
        apply: (db) => {
            db.exec(`CREATE TABLE IF NOT EXISTS calls (
                id TEXT PRIMARY KEY,
                ts INTEGER NOT NULL,
                text TEXT NOT NULL,
                argv TEXT NOT NULL,
                app TEXT,
                attention INTEGER NOT NULL DEFAULT 0,
                agent TEXT NOT NULL,
                session_id TEXT,
                ai_agent TEXT,
                account TEXT,
                surface_id TEXT,
                workspace_id TEXT,
                tab_id TEXT,
                tmux_pane TEXT,
                term_program TEXT,
                cwd TEXT NOT NULL,
                caller_pid INTEGER NOT NULL,
                ancestry TEXT NOT NULL,
                pid INTEGER NOT NULL,
                speaker_pid INTEGER,
                status TEXT NOT NULL,
                provider TEXT,
                voice TEXT,
                cache_hit INTEGER,
                fallback_from TEXT,
                error TEXT,
                finished_at INTEGER
            );`);
            db.exec("CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts);");
            db.exec("CREATE INDEX IF NOT EXISTS idx_calls_attention ON calls(attention, ts);");
        },
    },
];

/** `~/.genesis-tools/say/calls.db`: one database per machine, every `tools say` call ever made. */
export function callsDbPath(): string {
    return join(getSayStorage().getBaseDir(), "calls.db");
}

export function openCallsDb(dbPath: string = callsDbPath()): Database {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    runMigrations(db, CALLS_MIGRATIONS, { tableName: "say_calls" });

    return db;
}

export function newCallId(): string {
    return crypto.randomUUID();
}

export function isAttentionText(text: string): boolean {
    return ATTENTION_PATTERN.test(text);
}

/** What was asked of `tools say`. Both the foreground and the speaker know it from their own argv. */
export interface SayCallRequest {
    id: string;
    ts: number;
    text: string;
    argv: string[];
    app: string | null;
    /** The process writing the row. The foreground's pid wins once its upsert lands. */
    pid: number;
}

export interface SayCallOutcome {
    status: "spoken" | "written" | "failed";
    /** The process that synthesized and played: the detached child, or the foreground with `--wait`. */
    speakerPid: number;
    provider?: string | null;
    voice?: string | null;
    cacheHit?: boolean | null;
    fallbackFrom?: string | null;
    error?: string | null;
    finishedAt?: number;
}

export interface SayCallRecord {
    id: string;
    ts: number;
    text: string;
    argv: string[];
    app: string | null;
    attention: boolean;
    caller: CallerContext;
    pid: number;
    speakerPid: number | null;
    status: SayCallStatus;
    provider: string | null;
    voice: string | null;
    cacheHit: boolean | null;
    fallbackFrom: string | null;
    error: string | null;
    finishedAt: number | null;
}

interface CallRow {
    id: string;
    ts: number;
    text: string;
    argv: string;
    app: string | null;
    attention: number;
    agent: string;
    session_id: string | null;
    ai_agent: string | null;
    account: string | null;
    surface_id: string | null;
    workspace_id: string | null;
    tab_id: string | null;
    tmux_pane: string | null;
    term_program: string | null;
    cwd: string;
    caller_pid: number;
    ancestry: string;
    pid: number;
    speaker_pid: number | null;
    status: SayCallStatus;
    provider: string | null;
    voice: string | null;
    cache_hit: number | null;
    fallback_from: string | null;
    error: string | null;
    finished_at: number | null;
}

function parseArgv(text: string): string[] {
    return SafeJSON.parse(text, { strict: true });
}

function parseAncestry(text: string): AncestryFrame[] {
    return SafeJSON.parse(text, { strict: true });
}

function rowToRecord(row: CallRow): SayCallRecord {
    return {
        id: row.id,
        ts: row.ts,
        text: row.text,
        argv: parseArgv(row.argv),
        app: row.app,
        attention: row.attention === 1,
        caller: {
            agent: row.agent,
            sessionId: row.session_id,
            aiAgent: row.ai_agent,
            account: row.account,
            surfaceId: row.surface_id,
            workspaceId: row.workspace_id,
            tabId: row.tab_id,
            tmuxPane: row.tmux_pane,
            termProgram: row.term_program,
            cwd: row.cwd,
            callerPid: row.caller_pid,
            ancestry: parseAncestry(row.ancestry),
        },
        pid: row.pid,
        speakerPid: row.speaker_pid,
        status: row.status,
        provider: row.provider,
        voice: row.voice,
        cacheHit: row.cache_hit === null ? null : row.cache_hit === 1,
        fallbackFrom: row.fallback_from,
        error: row.error,
        finishedAt: row.finished_at,
    };
}

/**
 * The foreground's write: the request plus who made it. An upsert, because the
 * detached speaker may finish (and insert its half) before this lands; in that
 * case the caller columns are filled in and the speaker's status is kept.
 */
export function recordCall(
    db: Database,
    request: SayCallRequest,
    caller: CallerContext,
    status: "started" | "muted"
): void {
    db.query(
        `INSERT INTO calls (
            id, ts, text, argv, app, attention,
            agent, session_id, ai_agent, account,
            surface_id, workspace_id, tab_id, tmux_pane, term_program,
            cwd, caller_pid, ancestry, pid, status
        ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
            ts = excluded.ts, text = excluded.text, argv = excluded.argv, app = excluded.app,
            attention = excluded.attention, agent = excluded.agent, session_id = excluded.session_id,
            ai_agent = excluded.ai_agent, account = excluded.account, surface_id = excluded.surface_id,
            workspace_id = excluded.workspace_id, tab_id = excluded.tab_id, tmux_pane = excluded.tmux_pane,
            term_program = excluded.term_program, cwd = excluded.cwd, caller_pid = excluded.caller_pid,
            ancestry = excluded.ancestry, pid = excluded.pid`
    ).run(
        request.id,
        request.ts,
        request.text,
        SafeJSON.stringify(request.argv),
        request.app,
        isAttentionText(request.text) ? 1 : 0,
        caller.agent,
        caller.sessionId,
        caller.aiAgent,
        caller.account,
        caller.surfaceId,
        caller.workspaceId,
        caller.tabId,
        caller.tmuxPane,
        caller.termProgram,
        caller.cwd,
        caller.callerPid,
        SafeJSON.stringify(caller.ancestry),
        request.pid,
        status
    );
}

/**
 * The speaker's write: the outcome. Also an upsert, so a speaker that beats the
 * foreground still leaves a row (with no caller yet) for the foreground to complete.
 */
export function finishCall(db: Database, request: SayCallRequest, outcome: SayCallOutcome): void {
    db.query(
        `INSERT INTO calls (
            id, ts, text, argv, app, attention, agent, cwd, caller_pid, ancestry, pid,
            status, speaker_pid, provider, voice, cache_hit, fallback_from, error, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            status = excluded.status, speaker_pid = excluded.speaker_pid, provider = excluded.provider,
            voice = excluded.voice, cache_hit = excluded.cache_hit, fallback_from = excluded.fallback_from,
            error = excluded.error, finished_at = excluded.finished_at`
    ).run(
        request.id,
        request.ts,
        request.text,
        SafeJSON.stringify(request.argv),
        request.app,
        isAttentionText(request.text) ? 1 : 0,
        process.cwd(),
        process.ppid,
        request.pid,
        outcome.status,
        outcome.speakerPid,
        outcome.provider ?? null,
        outcome.voice ?? null,
        outcome.cacheHit == null ? null : outcome.cacheHit ? 1 : 0,
        outcome.fallbackFrom ?? null,
        outcome.error ?? null,
        outcome.finishedAt ?? Date.now()
    );
}

/** Write the call row. Never throws: a broken call log must not silence a notification. */
export function tryRecordCall(request: SayCallRequest, caller: CallerContext, status: "started" | "muted"): void {
    try {
        const db = openCallsDb();

        try {
            recordCall(db, request, caller, status);
        } finally {
            db.close();
        }
    } catch (err) {
        log.warn({ err, id: request.id }, "call log write failed; speaking anyway");
    }
}

/** Write the outcome onto the call row. Never throws. */
export function tryFinishCall(request: SayCallRequest, outcome: SayCallOutcome): void {
    try {
        const db = openCallsDb();

        try {
            finishCall(db, request, outcome);
        } finally {
            db.close();
        }
    } catch (err) {
        log.warn({ err, id: request.id }, "call log outcome write failed");
    }
}

export interface ListCallsOptions {
    limit: number;
    attention?: boolean;
    /** Case-insensitive substring of the spoken text. */
    grep?: string;
    sinceMs?: number;
}

interface Filter {
    where: string;
    params: (string | number)[];
}

function buildFilter(opts: { attention?: boolean; grep?: string; sinceMs?: number }, extra: string[] = []): Filter {
    const clauses = [...extra];
    const params: (string | number)[] = [];

    if (opts.sinceMs !== undefined) {
        clauses.push("ts >= ?");
        params.push(opts.sinceMs);
    }

    if (opts.attention) {
        clauses.push("attention = 1");
    }

    if (opts.grep) {
        clauses.push("instr(lower(text), lower(?)) > 0");
        params.push(opts.grep);
    }

    return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** The newest `limit` matching calls, returned oldest first so the newest sits at the bottom. */
export function listCalls(db: Database, opts: ListCallsOptions): SayCallRecord[] {
    const filter = buildFilter(opts);
    const rows = db
        .query(`SELECT * FROM calls ${filter.where} ORDER BY ts DESC LIMIT ?`)
        .all(...filter.params, opts.limit) as CallRow[];

    return rows.map(rowToRecord).reverse();
}

export interface KeyCount {
    key: string;
    count: number;
}

export interface SayCallStats {
    sinceMs: number | null;
    total: number;
    firstTs: number | null;
    lastTs: number | null;
    attention: number;
    /** `started` rows older than {@link NO_OUTCOME_AFTER_MS}: the speaker never reported back. */
    noOutcome: number;
    byStatus: KeyCount[];
    byAgent: (KeyCount & { attention: number })[];
    byApp: KeyCount[];
    byProvider: { key: string; count: number; cacheHits: number; fallbacks: number }[];
    /** Oldest first, local calendar days, at most `days` entries. */
    byDay: { day: string; count: number; attention: number }[];
    /** 24 buckets, local hour of day. */
    byHour: number[];
    topSessions: { sessionId: string; agent: string; workspaceId: string | null; count: number; lastTs: number }[];
    topTexts: { text: string; count: number }[];
    /** Call to outcome, for spoken and written calls. Null when none finished. */
    latency: { count: number; medianMs: number; p90Ms: number; maxMs: number } | null;
}

export interface StatsOptions {
    sinceMs?: number;
    now?: number;
    /** How many calendar days `byDay` covers. Default 14. */
    days?: number;
    /** Size of the top-N lists. Default 10. */
    top?: number;
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) {
        return 0;
    }

    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));

    return sorted[index];
}

export function computeStats(db: Database, opts: StatsOptions = {}): SayCallStats {
    const now = opts.now ?? Date.now();
    const days = opts.days ?? 14;
    const top = opts.top ?? 10;
    const base = buildFilter({ sinceMs: opts.sinceMs });

    const totals = db
        .query(
            `SELECT COUNT(*) AS total, MIN(ts) AS firstTs, MAX(ts) AS lastTs, COALESCE(SUM(attention), 0) AS attention
             FROM calls ${base.where}`
        )
        .get(...base.params) as { total: number; firstTs: number | null; lastTs: number | null; attention: number };

    const stale = buildFilter({ sinceMs: opts.sinceMs }, ["status = 'started'", "ts < ?"]);
    const noOutcome = db
        .query(`SELECT COUNT(*) AS count FROM calls ${stale.where}`)
        .get(now - NO_OUTCOME_AFTER_MS, ...stale.params) as { count: number };

    const byStatus = db
        .query(`SELECT status AS key, COUNT(*) AS count FROM calls ${base.where} GROUP BY status ORDER BY count DESC`)
        .all(...base.params) as KeyCount[];

    const byAgent = db
        .query(
            `SELECT agent AS key, COUNT(*) AS count, COALESCE(SUM(attention), 0) AS attention
             FROM calls ${base.where} GROUP BY agent ORDER BY count DESC`
        )
        .all(...base.params) as (KeyCount & { attention: number })[];

    const byApp = db
        .query(
            `SELECT COALESCE(app, '') AS key, COUNT(*) AS count FROM calls ${base.where}
             GROUP BY COALESCE(app, '') ORDER BY count DESC`
        )
        .all(...base.params) as KeyCount[];

    const finished = buildFilter({ sinceMs: opts.sinceMs }, ["status IN ('spoken', 'written')"]);
    const byProvider = db
        .query(
            `SELECT COALESCE(provider, '') AS key, COUNT(*) AS count,
                    COALESCE(SUM(cache_hit), 0) AS cacheHits,
                    COALESCE(SUM(fallback_from IS NOT NULL), 0) AS fallbacks
             FROM calls ${finished.where} GROUP BY COALESCE(provider, '') ORDER BY count DESC`
        )
        .all(...finished.params) as SayCallStats["byProvider"];

    const byDay = (
        db
            .query(
                `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS count,
                        COALESCE(SUM(attention), 0) AS attention
                 FROM calls ${base.where} GROUP BY day ORDER BY day DESC LIMIT ?`
            )
            .all(...base.params, days) as SayCallStats["byDay"]
    ).reverse();

    const byHour = new Array<number>(24).fill(0);
    const hourRows = db
        .query(
            `SELECT CAST(strftime('%H', ts / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour, COUNT(*) AS count
             FROM calls ${base.where} GROUP BY hour`
        )
        .all(...base.params) as { hour: number; count: number }[];

    for (const row of hourRows) {
        byHour[row.hour] = row.count;
    }

    const withSession = buildFilter({ sinceMs: opts.sinceMs }, ["session_id IS NOT NULL"]);
    // One aggregate MAX(ts) makes the bare `agent` / `workspace_id` columns come from
    // the newest row of each group (documented SQLite behaviour for a lone min/max).
    const topSessions = db
        .query(
            `SELECT session_id AS sessionId, agent, workspace_id AS workspaceId, COUNT(*) AS count, MAX(ts) AS lastTs
             FROM calls ${withSession.where} GROUP BY session_id ORDER BY count DESC, lastTs DESC LIMIT ?`
        )
        .all(...withSession.params, top) as SayCallStats["topSessions"];

    const topTexts = db
        .query(
            `SELECT text, COUNT(*) AS count FROM calls ${base.where}
             GROUP BY text ORDER BY count DESC, MAX(ts) DESC LIMIT ?`
        )
        .all(...base.params, top) as SayCallStats["topTexts"];

    const latencies = (
        db
            .query(`SELECT finished_at - ts AS ms FROM calls ${finished.where} AND finished_at IS NOT NULL ORDER BY ms`)
            .all(...finished.params) as { ms: number }[]
    ).map((row) => row.ms);

    return {
        sinceMs: opts.sinceMs ?? null,
        total: totals.total,
        firstTs: totals.firstTs,
        lastTs: totals.lastTs,
        attention: totals.attention,
        noOutcome: noOutcome.count,
        byStatus,
        byAgent,
        byApp,
        byProvider,
        byDay,
        byHour,
        topSessions,
        topTexts,
        latency:
            latencies.length === 0
                ? null
                : {
                      count: latencies.length,
                      medianMs: percentile(latencies, 0.5),
                      p90Ms: percentile(latencies, 0.9),
                      maxMs: latencies[latencies.length - 1],
                  },
    };
}
