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
    /** A quota probe the probe budget refused. */
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
    /** ISO UTC. For a daily count row, the last probe of that day. */
    ts: string;
    provider: string;
    accountId: string | null;
    accountName: string | null;
    source: string;
    kind: UsageEventKind;
    retryAfterMs: number | null;
    model: string | null;
    detail: string | null;
    /** Local `YYYY-MM-DD` of a daily count row; null on a single event. */
    day: string | null;
    count: number;
}

interface EventSqlRow {
    id: number;
    ts: string;
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

function isMissingTable(err: unknown): boolean {
    return err instanceof Error && /no such table/.test(err.message);
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
        const result = this.db
            .prepare(
                `INSERT INTO usage_events (ts, provider, account_id, account_name, source, kind, retry_after_ms, model, detail)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                (event.at ?? new Date()).toISOString(),
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
     * Adds `by` to the daily count row of `(provider, account, kind, model, day)`, creating it on the first probe of
     * the day. Read and write run in one immediate transaction, so two processes probing at once never write two
     * rows for one day.
     */
    bumpDaily(event: UsageEventInput & { day: string; by?: number }): void {
        const at = (event.at ?? new Date()).toISOString();
        const by = event.by ?? 1;
        const bump = this.db.transaction(() => {
            const updated = this.db
                .prepare(
                    `UPDATE usage_events SET count = count + ?, ts = ?
                     WHERE day = ? AND provider = ? AND kind = ?
                       AND account_name IS ? AND model IS ?`
                )
                .run(by, at, event.day, event.provider, event.kind, event.accountName ?? null, event.model ?? null);

            if (updated.changes > 0) {
                return;
            }

            this.db
                .prepare(
                    `INSERT INTO usage_events (ts, provider, account_id, account_name, source, kind, model, day, count)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                    at,
                    event.provider,
                    event.accountId ?? null,
                    event.accountName ?? null,
                    event.source,
                    event.kind,
                    event.model ?? null,
                    event.day,
                    by
                );
        });

        bump.immediate();
    }

    /** Rows in the window, newest first. A store without the table answers no rows. */
    list(query: UsageEventQuery): UsageEventRow[] {
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
                    `SELECT id, ts, provider, account_id, account_name, source, kind, retry_after_ms, model, detail, day, count
                     FROM usage_events
                     WHERE ts >= ? AND ts <= ?${filters.join("")}
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

/** Counts per kind, a daily row counted by its `count`. */
export function countByKind(rows: readonly UsageEventRow[]): Partial<Record<UsageEventKind, number>> {
    const counts: Partial<Record<UsageEventKind, number>> = {};

    for (const row of rows) {
        counts[row.kind] = (counts[row.kind] ?? 0) + row.count;
    }

    return counts;
}
