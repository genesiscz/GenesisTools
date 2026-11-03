import type { Database } from "bun:sqlite";
import { parseWhen } from "@genesiscz/utils/ai/usage/contract/window";
import { type PollRun, PollRunsStore } from "@genesiscz/utils/ai/usage/poll-runs/store";
import { zonedDay } from "@genesiscz/utils/ai/usage/spend/reports/dates";
import type { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import type { SeriesEntry } from "@genesiscz/utils/ai/usage-poll/series-rows";

/**
 * The daily rollup (design 2026-11-01, step U10, proposal 16): one row per account, window and local day in
 * `usage_daily`, built from the raw readings of `usage_snapshots`. It outlives the 30-day prune of the readings, so a
 * digest or a trend past a month still has the days. The table comes from `USAGE_LIMITS_MIGRATIONS`.
 */
export interface DailyRow {
    provider: string;
    accountId: string | null;
    accountName: string;
    bucket: string;
    kind: string | null;
    /** `YYYY-MM-DD` in `tz`. */
    day: string;
    tz: string;
    startPct: number;
    endPct: number;
    peakPct: number;
    resets: number;
    /** Reset cycles of the day whose highest reading reached 90 %. */
    cyclesOver90: number;
    readings: number;
    /** Minutes of the day the poller measured this account; null when no run says. */
    minutesMeasured: number | null;
    /** The window's state at the day's last reading. */
    availability: "limited" | "absent" | "unknown";
}

interface DailySqlRow {
    provider: string;
    account_id: string | null;
    account_name: string;
    bucket: string;
    kind: string | null;
    day: string;
    tz: string;
    start_pct: number;
    end_pct: number;
    peak_pct: number;
    resets: number;
    cycles_over_90: number;
    readings: number;
    minutes_measured: number | null;
    availability: string | null;
}

interface LastRow {
    last: string | null;
}

const CYCLE_PEAK = 90;
/** The daemon rolls up at most this often; today's row is rewritten each time. */
export const ROLLUP_EVERY_MS = 15 * 60_000;

/** The local-midnight bounds of a day key in `tz`, as epoch ms. */
export function dayBounds(day: string, tz: string): { start: number; end: number } {
    const start = parseWhen(day, { now: new Date(), tz }).getTime();
    const next = zonedDay(new Date(start + 36 * 3_600_000).toISOString(), tz);
    return { start, end: parseWhen(next, { now: new Date(), tz }).getTime() };
}

function minutesIn(runs: readonly PollRun[], bounds: { start: number; end: number }): number | null {
    let ms = 0;
    let any = false;

    for (const run of runs) {
        if (run.outcome !== "ok" && run.outcome !== "stale") {
            continue;
        }

        const from = Math.max(Date.parse(run.from), bounds.start);
        const to = Math.min(Date.parse(run.to), bounds.end);

        if (to > from) {
            ms += to - from;
            any = true;
        }
    }

    return any ? Math.round(ms / 60_000) : null;
}

function cyclesOver(values: readonly number[]): number {
    let count = 0;
    let peak = Number.NEGATIVE_INFINITY;
    let previous: number | undefined;

    for (const value of values) {
        if (previous !== undefined && value < previous) {
            count += peak >= CYCLE_PEAK ? 1 : 0;
            peak = Number.NEGATIVE_INFINITY;
        }

        peak = Math.max(peak, value);
        previous = value;
    }

    return count + (peak >= CYCLE_PEAK ? 1 : 0);
}

/** The rows of every day the readings touch (or only `days`), one per series and day. */
export function dailyRowsOf(input: {
    series: readonly SeriesEntry[];
    tz: string;
    runs: readonly PollRun[];
    accountIdOf: (entry: SeriesEntry) => string | null;
    days?: ReadonlySet<string>;
}): DailyRow[] {
    const rows: DailyRow[] = [];

    for (const entry of input.series) {
        const byDay = new Map<string, SeriesEntry["points"]>();

        for (const point of entry.points) {
            const day = zonedDay(point.t, input.tz);

            if (day && (!input.days || input.days.has(day))) {
                byDay.set(day, [...(byDay.get(day) ?? []), point]);
            }
        }

        const runs = input.runs.filter((run) => run.provider === entry.provider && run.accountName === entry.account);

        for (const [day, points] of byDay) {
            const values = points.map((point) => point.percent);
            const bounds = dayBounds(day, input.tz);
            const last = Date.parse(points[points.length - 1].t);
            const span = entry.availability.find((s) => Date.parse(s.from) <= last && last <= Date.parse(s.to));

            rows.push({
                provider: entry.provider,
                accountId: input.accountIdOf(entry),
                accountName: entry.account,
                bucket: entry.key,
                kind: entry.kind,
                day,
                tz: input.tz,
                startPct: values[0],
                endPct: values[values.length - 1],
                peakPct: Math.max(...values),
                resets: entry.resets.filter((reset) => zonedDay(reset, input.tz) === day).length,
                cyclesOver90: cyclesOver(values),
                readings: values.length,
                minutesMeasured: minutesIn(runs, bounds),
                availability: span?.state ?? "unknown",
            });
        }
    }

    return rows;
}

function mapRow(row: DailySqlRow): DailyRow {
    return {
        provider: row.provider,
        accountId: row.account_id,
        accountName: row.account_name,
        bucket: row.bucket,
        kind: row.kind,
        day: row.day,
        tz: row.tz,
        startPct: row.start_pct,
        endPct: row.end_pct,
        peakPct: row.peak_pct,
        resets: row.resets,
        cyclesOver90: row.cycles_over_90,
        readings: row.readings,
        minutesMeasured: row.minutes_measured,
        availability: row.availability === "limited" || row.availability === "absent" ? row.availability : "unknown",
    };
}

function isMissingTable(err: unknown): boolean {
    return err instanceof Error && /no such table/i.test(err.message);
}

export class UsageDailyStore {
    constructor(private readonly db: Database) {}

    /** Writes each row, replacing the same account, window and day: today's row grows through the day. */
    upsert(rows: readonly DailyRow[], now: Date): number {
        const statement = this.db.prepare(
            `INSERT INTO usage_daily
                (provider, account_id, account_name, bucket, kind, day, tz, start_pct, end_pct, peak_pct, resets,
                 cycles_over_90, readings, minutes_measured, availability, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (provider, account_name, bucket, day) DO UPDATE SET
                account_id = excluded.account_id, kind = excluded.kind, tz = excluded.tz,
                start_pct = excluded.start_pct, end_pct = excluded.end_pct, peak_pct = excluded.peak_pct,
                resets = excluded.resets, cycles_over_90 = excluded.cycles_over_90, readings = excluded.readings,
                minutes_measured = excluded.minutes_measured, availability = excluded.availability,
                updated_at = excluded.updated_at`
        );
        const write = this.db.transaction((list: readonly DailyRow[]) => {
            for (const row of list) {
                statement.run(
                    row.provider,
                    row.accountId,
                    row.accountName,
                    row.bucket,
                    row.kind,
                    row.day,
                    row.tz,
                    row.startPct,
                    row.endPct,
                    row.peakPct,
                    row.resets,
                    row.cyclesOver90,
                    row.readings,
                    row.minutesMeasured,
                    row.availability,
                    now.toISOString()
                );
            }
        });

        write(rows);
        return rows.length;
    }

    /** Rows of the days from `from` to `to` (day keys, inclusive), by day, then account. */
    between(query: { from: string; to: string; providers?: readonly string[] }): DailyRow[] {
        const params: string[] = [query.from, query.to];
        let filter = "";

        if (query.providers && query.providers.length > 0) {
            filter = ` AND provider IN (${query.providers.map(() => "?").join(", ")})`;
            params.push(...query.providers);
        }

        try {
            const rows = this.db
                .prepare(
                    `SELECT provider, account_id, account_name, bucket, kind, day, tz, start_pct, end_pct, peak_pct,
                            resets, cycles_over_90, readings, minutes_measured, availability
                     FROM usage_daily WHERE day >= ? AND day <= ?${filter}
                     ORDER BY day ASC, provider ASC, account_name ASC, bucket ASC`
                )
                .all(...params) as DailySqlRow[];

            return rows.map(mapRow);
        } catch (err) {
            if (isMissingTable(err)) {
                return [];
            }

            throw err;
        }
    }

    /** When the rollup last wrote, ISO UTC; null before the first. */
    lastUpdatedAt(): string | null {
        try {
            const row = this.db.prepare("SELECT MAX(updated_at) AS last FROM usage_daily").get() as LastRow | null;
            return row?.last ?? null;
        } catch (err) {
            if (isMissingTable(err)) {
                return null;
            }

            throw err;
        }
    }
}

/**
 * Rolls up yesterday and today from the raw readings and the poll runs (the daemon tick's last stage), when the last
 * rollup is older than `ROLLUP_EVERY_MS` or `force` is set. Returns how many rows it wrote (0 when not due).
 */
export function rollUpRecentDays(input: {
    db: UsageLimitsDb;
    now: Date;
    tz: string;
    accountIdOf: (entry: SeriesEntry) => string | null;
    force?: boolean;
}): number {
    const connection = input.db.connection();
    const store = new UsageDailyStore(connection);
    const last = store.lastUpdatedAt();

    if (!input.force && last !== null && input.now.getTime() - Date.parse(last) < ROLLUP_EVERY_MS) {
        return 0;
    }

    const today = zonedDay(input.now.toISOString(), input.tz);
    const yesterday = zonedDay(new Date(dayBounds(today, input.tz).start - 3_600_000).toISOString(), input.tz);
    const from = new Date(dayBounds(yesterday, input.tz).start);
    const series = input.db.getSeries({ from: from.toISOString(), to: input.now.toISOString(), agg: "raw", step: 0 });
    const runs = new PollRunsStore(connection).runsBetween({ from, to: input.now });
    const rows = dailyRowsOf({
        series,
        tz: input.tz,
        runs,
        accountIdOf: input.accountIdOf,
        days: new Set([yesterday, today]),
    });

    return store.upsert(rows, input.now);
}
