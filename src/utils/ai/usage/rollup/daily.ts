import type { Database } from "bun:sqlite";
import { parseWhen } from "@genesiscz/utils/ai/usage/contract/window";
import { type PollRun, PollRunsStore } from "@genesiscz/utils/ai/usage/poll-runs/store";
import { zonedDay } from "@genesiscz/utils/ai/usage/spend/reports/dates";
import type { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import type { SeriesEntry, SeriesPoint } from "@genesiscz/utils/ai/usage-poll/series-rows";

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
    /**
     * First, last and highest reading of the day. A day with no reading (`readings` 0) holds the reading standing at
     * its start (readings are written on change only, so a quiet window has none), or 0 when the window was gone then.
     */
    startPct: number;
    endPct: number;
    peakPct: number;
    resets: number;
    /** Reset cycles that first reached 90 % this day (a cycle crossing midnight counts on one day only). */
    cyclesOver90: number;
    readings: number;
    /** Minutes of the day the poller measured this account; null when no run says. */
    minutesMeasured: number | null;
    /** The window's state at the end of the day (or of the readings' range, for today), from its availability spans. */
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

interface FirstRow {
    first: string | null;
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

/** A new reset cycle began between two readings: a reset the series found, or a drop where no reset clock says. */
function newCycle(previous: SeriesPoint, point: SeriesPoint, resets: readonly number[]): boolean {
    const from = Date.parse(previous.t);
    const to = Date.parse(point.t);

    if (resets.some((at) => from < at && at <= to)) {
        return true;
    }

    return previous.resetsAt === null && point.percent < previous.percent;
}

/**
 * The reset cycles that reached 90 %, by local day: each cycle counts once, on the day its readings first reached
 * 90 %, so a cycle that crosses midnight is not counted on both days. A cycle the carried reading already had at
 * 90 % was counted on an earlier day.
 */
function cyclesOverByDay(entry: SeriesEntry, tz: string): Map<string, number> {
    const counts = new Map<string, number>();
    const resets = entry.resets.map((at) => Date.parse(at));
    let previous = entry.carried;
    let counted = previous !== undefined && previous.percent >= CYCLE_PEAK;

    for (const point of entry.points) {
        if (previous && newCycle(previous, point, resets)) {
            counted = false;
        }

        const day = zonedDay(point.t, tz);

        if (!counted && point.percent >= CYCLE_PEAK && day) {
            counts.set(day, (counts.get(day) ?? 0) + 1);
            counted = true;
        }

        previous = point;
    }

    return counts;
}

/** The local day of the oldest reading the store keeps; null on an empty store. */
function oldestReadingDay(db: Database, tz: string): string | null {
    const row = db.prepare<FirstRow, []>("SELECT MIN(timestamp) AS first FROM usage_snapshots").get();
    return row?.first ? zonedDay(row.first, tz) : null;
}

/** The local days a span covers, its end exclusive. */
function daysOfSpan(span: { from: string; to: string }, tz: string): string[] {
    const end = Date.parse(span.to);
    const days: string[] = [];
    let day = zonedDay(span.from, tz);

    while (day && dayBounds(day, tz).start < end) {
        days.push(day);
        day = zonedDay(new Date(dayBounds(day, tz).end).toISOString(), tz);
    }

    return days;
}

/**
 * The reading standing at `at`: the last one before it, or the one carried into the range. Undefined when the window
 * was gone at `at`, or no reading came before it.
 */
function heldAt(entry: SeriesEntry, at: number): number | undefined {
    const span = entry.availability.find((s) => Date.parse(s.from) <= at && at < Date.parse(s.to));

    if (!span || span.state === "absent") {
        return undefined;
    }

    const before = entry.points.filter((point) => Date.parse(point.t) < at).at(-1);
    return (before ?? entry.carried)?.percent;
}

/**
 * The rows of every day the readings or the availability spans touch (or only `days`), one per series and day. The
 * series door keeps an absent row out of the points and in the spans, so a day the window was gone all day has no
 * reading and still gets its row. A limited window with no changed reading that day gets its row too, holding the
 * reading carried into it, but only on a day the poller measured the account: a day nobody polled is not a known
 * state, and a window long gone with its account would otherwise be carried forever. Each row's availability is the
 * span at the day's end, not at its last reading.
 */
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

        for (const span of entry.availability) {
            for (const day of daysOfSpan(span, input.tz)) {
                if (byDay.has(day) || (input.days && !input.days.has(day))) {
                    continue;
                }

                if (span.state === "absent" || (minutesIn(runs, dayBounds(day, input.tz)) ?? 0) > 0) {
                    byDay.set(day, []);
                }
            }
        }

        const rangeEnd = Math.max(0, ...entry.availability.map((s) => Date.parse(s.to)));
        const cycles = cyclesOverByDay(entry, input.tz);

        for (const [day, points] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
            const values = points.map((point) => point.percent);
            const bounds = dayBounds(day, input.tz);
            const held = values.length === 0 ? heldAt(entry, bounds.start) : undefined;
            const end = Math.min(bounds.end - 1, rangeEnd);
            const span = entry.availability.find((s) => Date.parse(s.from) <= end && end <= Date.parse(s.to));

            rows.push({
                provider: entry.provider,
                accountId: input.accountIdOf(entry),
                accountName: entry.account,
                bucket: entry.key,
                kind: entry.kind,
                day,
                tz: input.tz,
                startPct: values[0] ?? held ?? 0,
                endPct: values[values.length - 1] ?? held ?? 0,
                peakPct: values.length > 0 ? Math.max(...values) : (held ?? 0),
                resets: entry.resets.filter((reset) => zonedDay(reset, input.tz) === day).length,
                cyclesOver90: cycles.get(day) ?? 0,
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
        kind: row.kind === "" ? null : row.kind,
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

    /**
     * Writes each row, replacing the same account, window, kind and day: today's row grows through the day. A missing
     * kind is stored as '' (the key needs a value NULL would not give), and `between` reads it back as null.
     */
    upsert(rows: readonly DailyRow[], now: Date): number {
        const statement = this.db.prepare(
            `INSERT INTO usage_daily
                (provider, account_id, account_name, bucket, kind, day, tz, start_pct, end_pct, peak_pct, resets,
                 cycles_over_90, readings, minutes_measured, availability, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (provider, account_name, bucket, kind, day) DO UPDATE SET
                account_id = excluded.account_id, tz = excluded.tz,
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
                    row.kind ?? "",
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
                     ORDER BY day ASC, provider ASC, account_name ASC, bucket ASC, kind ASC`
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

    /** The last day the rollup wrote in `tz`; null when it never wrote one there. */
    lastDay(tz: string): string | null {
        try {
            const row = this.db
                .prepare("SELECT MAX(day) AS last FROM usage_daily WHERE tz = ?")
                .get(tz) as LastRow | null;
            return row?.last ?? null;
        } catch (err) {
            if (isMissingTable(err)) {
                return null;
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
    // From the last day it wrote (a failed or missed tick resumes there), or on a store it never rolled, from the oldest
    // retained reading: the prune after this pass must not drop a day nobody rolled up. Never later than yesterday.
    const resume = store.lastDay(input.tz) ?? oldestReadingDay(connection, input.tz) ?? yesterday;
    const first = resume < yesterday ? resume : yesterday;
    const from = new Date(dayBounds(first, input.tz).start);
    // `keepQuiet`: a window with no changed reading since `from` is still carried through the days the poller measured.
    const series = input.db.getSeries({
        from: from.toISOString(),
        to: input.now.toISOString(),
        agg: "raw",
        step: 0,
        keepQuiet: true,
    });
    const runs = new PollRunsStore(connection).runsBetween({ from, to: input.now });
    const rows = dailyRowsOf({
        series,
        tz: input.tz,
        runs,
        accountIdOf: input.accountIdOf,
        days: new Set(daysOfSpan({ from: from.toISOString(), to: input.now.toISOString() }, input.tz)),
    });

    return store.upsert(rows, input.now);
}
