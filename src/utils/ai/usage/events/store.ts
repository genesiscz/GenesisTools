import type { Database } from "bun:sqlite";

/**
 * The `usage_events` store (design 2026-11-01, step U6): facts that used to exist only as day-log text. The table is
 * created by `USAGE_LIMITS_MIGRATIONS`; this class only reads and writes rows, so it works on a read-only
 * connection too (a reader of a store the migration has not reached gets no rows).
 */

/** What happened. A new kind is one entry here and in `USAGE_EVENT_KINDS`. */
export type UsageEventKind =
    /** The usage endpoint answered 429. */
    | "usage-429"
    /** A proxied request was answered 429. */
    | "rate-limited"
    /** The proxy took an account out of rotation for `retryAfterMs`. */
    | "cooldown"
    /** The poll gate paused an account for `retryAfterMs` after a failure. */
    | "poll-backoff"
    /** The provider refused the account at the organization level (a 403). */
    | "org-blocked"
    /** Quota probes the probe budget refused on one local day (a daily count row). */
    | "probe-refused"
    /** Quota probes sent on one local day (a daily count row). */
    | "probe";

export const USAGE_EVENT_KINDS: readonly UsageEventKind[] = [
    "usage-429",
    "rate-limited",
    "cooldown",
    "poll-backoff",
    "org-blocked",
    "probe-refused",
    "probe",
];

/** The kinds the rate-limited alert rule counts: an upstream said "too many requests". */
export const RATE_LIMIT_EVENT_KINDS: readonly UsageEventKind[] = ["usage-429", "rate-limited"];

export function isUsageEventKind(value: string): value is UsageEventKind {
    return (USAGE_EVENT_KINDS as readonly string[]).includes(value);
}

export interface UsageEventInput {
    /** Plugin id (`anthropic-sub`), never a proxy provider name: a caller maps its own names first. */
    provider: string;
    accountId?: string | null;
    accountName?: string | null;
    /** Who saw it: `usage-client`, `ai-proxy`, `poll-gate`, `probe-budget`, `poll`. */
    source: string;
    kind: UsageEventKind;
    retryAfterMs?: number | null;
    model?: string | null;
    /** Short free text (the reason a gate gave). */
    detail?: string | null;
    /** Defaults to now. */
    at?: Date;
}

export interface UsageEventRow {
    id: number;
    /** ISO UTC. For a count row, its last event. */
    ts: string;
    /** ISO UTC of a count row's first event; `ts` on a single event and on a count row from before the column. */
    firstTs: string;
    provider: string;
    accountId: string | null;
    accountName: string | null;
    source: string;
    kind: UsageEventKind;
    retryAfterMs: number | null;
    model: string | null;
    detail: string | null;
    /** Local `YYYY-MM-DD` of a count row (`probe`, `probe-refused`, one row per hour); null on a single event. */
    day: string | null;
    count: number;
}

interface EventSqlRow {
    id: number;
    ts: string;
    first_ts: string | null;
    provider: string;
    account_id: string | null;
    account_name: string | null;
    source: string;
    kind: string;
    retry_after_ms: number | null;
    model: string | null;
    detail: string | null;
    day: string | null;
    count: number;
}

export interface UsageEventQuery {
    from: Date;
    to: Date;
    providers?: readonly string[];
    /** Account ids or names; a row matches either. */
    accounts?: readonly string[];
    kinds?: readonly UsageEventKind[];
    /** Newest first, at most this many. */
    limit?: number;
}

const DETAIL_MAX = 300;
const HOUR_MS = 3_600_000;

function isMissingTable(err: unknown): boolean {
    return err instanceof Error && /no such table/.test(err.message);
}

function isMissingFirstTs(err: unknown): boolean {
    return err instanceof Error && /no such column: first_ts/.test(err.message);
}

function inList(column: string, values: readonly string[] | undefined, params: string[]): string {
    if (!values || values.length === 0) {
        return "";
    }

    params.push(...values);
    return ` AND ${column} IN (${values.map(() => "?").join(", ")})`;
}

export class UsageEventsStore {
    constructor(private readonly db: Database) {}

    /** One event row. Returns its id. */
    insert(event: UsageEventInput): number {
        const at = (event.at ?? new Date()).toISOString();
        const result = this.db
            .prepare(
                `INSERT INTO usage_events (ts, first_ts, provider, account_id, account_name, source, kind, retry_after_ms, model, detail)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                at,
                at,
                event.provider,
                event.accountId ?? null,
                event.accountName ?? null,
                event.source,
                event.kind,
                event.retryAfterMs ?? null,
                event.model ?? null,
                event.detail?.slice(0, DETAIL_MAX) ?? null
            );

        return Number(result.lastInsertRowid);
    }

    /**
     * Adds `by` to the count row of `(provider, account, kind, model, local day)` for the UTC hour of `at`, creating
     * it on the hour's first event. The row spans its first to its last event (`first_ts` to `ts`), at most one hour,
     * so a window over part of a day counts what it holds (`countByKind` with the window) and at most a few events
     * of a crossing row are uncertain (`partialCountByKind`). A given `detail` replaces the row's; an omitted one
     * keeps it. Read and write run in one immediate transaction, so two processes at once never write two rows.
     */
    bumpHourly(event: UsageEventInput & { day: string; by?: number }): void {
        const atMs = (event.at ?? new Date()).getTime();
        const at = new Date(atMs).toISOString();
        const hourStart = new Date(Math.floor(atMs / HOUR_MS) * HOUR_MS);
        const hourEnd = new Date(hourStart.getTime() + HOUR_MS);
        const by = event.by ?? 1;
        const detail = event.detail?.slice(0, DETAIL_MAX) ?? null;
        const bump = this.db.transaction(() => {
            const updated = this.db
                .prepare(
                    `UPDATE usage_events
                     SET count = count + ?, ts = MAX(ts, ?), first_ts = MIN(first_ts, ?), detail = COALESCE(?, detail)
                     WHERE day = ? AND provider = ? AND kind = ?
                       AND account_name IS ? AND model IS ?
                       AND first_ts >= ? AND first_ts < ?`
                )
                .run(
                    by,
                    at,
                    at,
                    detail,
                    event.day,
                    event.provider,
                    event.kind,
                    event.accountName ?? null,
                    event.model ?? null,
                    hourStart.toISOString(),
                    hourEnd.toISOString()
                );

            if (updated.changes > 0) {
                return;
            }

            this.db
                .prepare(
                    `INSERT INTO usage_events (ts, first_ts, provider, account_id, account_name, source, kind, model, detail, day, count)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                    at,
                    at,
                    event.provider,
                    event.accountId ?? null,
                    event.accountName ?? null,
                    event.source,
                    event.kind,
                    event.model ?? null,
                    detail,
                    event.day,
                    by
                );
        });

        bump.immediate();
    }

    /**
     * Rows whose span touches the window, newest first: a count row that crosses an edge is listed too, and the
     * counting functions decide what of it the window may claim. A store without the table answers no rows; one
     * without `first_ts` (not migrated yet) reads every row at its `ts`.
     */
    list(query: UsageEventQuery): UsageEventRow[] {
        try {
            return this.listWith(query, "first_ts");
        } catch (err) {
            if (isMissingFirstTs(err)) {
                return this.listWith(query, "NULL");
            }

            throw err;
        }
    }

    private listWith(query: UsageEventQuery, firstTs: "first_ts" | "NULL"): UsageEventRow[] {
        const params: string[] = [query.from.toISOString(), query.to.toISOString()];
        const filters: string[] = [];
        filters.push(inList("provider", query.providers, params));

        if (query.accounts && query.accounts.length > 0) {
            const marks = query.accounts.map(() => "?").join(", ");
            filters.push(` AND (account_id IN (${marks}) OR account_name IN (${marks}))`);
            params.push(...query.accounts, ...query.accounts);
        }

        filters.push(inList("kind", query.kinds, params));
        const limit = query.limit === undefined ? "" : ` LIMIT ${Math.max(1, Math.floor(query.limit))}`;

        try {
            const rows = this.db
                .prepare(
                    `SELECT id, ts, ${firstTs} AS first_ts, provider, account_id, account_name, source, kind, retry_after_ms,
                            model, detail, day, count
                     FROM usage_events
                     WHERE ts >= ? AND COALESCE(${firstTs}, ts) <= ?${filters.join("")}
                     ORDER BY ts DESC, id DESC${limit}`
                )
                .all(...params) as EventSqlRow[];

            return rows.flatMap((row) => {
                const mapped = mapRow(row);
                return mapped ? [mapped] : [];
            });
        } catch (err) {
            if (isMissingTable(err)) {
                return [];
            }

            throw err;
        }
    }
}

function mapRow(row: EventSqlRow): UsageEventRow | null {
    // A kind this build does not know came from a newer build; it is skipped, never mislabelled.
    if (!isUsageEventKind(row.kind)) {
        return null;
    }

    return {
        id: row.id,
        ts: row.ts,
        firstTs: row.first_ts ?? row.ts,
        provider: row.provider,
        accountId: row.account_id,
        accountName: row.account_name,
        source: row.source,
        kind: row.kind,
        retryAfterMs: row.retry_after_ms,
        model: row.model,
        detail: row.detail,
        day: row.day,
        count: row.count,
    };
}

interface EventWindow {
    from: Date;
    to: Date;
}

/** Whether the window holds the row's whole span, so it may claim the row's whole count. */
function insideWindow(row: UsageEventRow, window: EventWindow): boolean {
    return Date.parse(row.firstTs) >= window.from.getTime() && Date.parse(row.ts) <= window.to.getTime();
}

function sumByKind(rows: readonly UsageEventRow[]): Partial<Record<UsageEventKind, number>> {
    const counts: Partial<Record<UsageEventKind, number>> = {};

    for (const row of rows) {
        counts[row.kind] = (counts[row.kind] ?? 0) + row.count;
    }

    return counts;
}

/**
 * Counts per kind, a count row counted by its `count`. With a window, only the rows whose whole span lies inside it:
 * a row that crosses an edge may hold events outside, so it goes to `partialCountByKind` and is never claimed whole.
 */
export function countByKind(
    rows: readonly UsageEventRow[],
    window?: EventWindow
): Partial<Record<UsageEventKind, number>> {
    return sumByKind(window ? rows.filter((row) => insideWindow(row, window)) : rows);
}

/** Per kind, the counts of the rows that cross the window's edge: some of their events are inside, some may not be. */
export function partialCountByKind(
    rows: readonly UsageEventRow[],
    window: EventWindow
): Partial<Record<UsageEventKind, number>> {
    return sumByKind(rows.filter((row) => !insideWindow(row, window)));
}
