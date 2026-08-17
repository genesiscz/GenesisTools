/**
 * When the listening happens: timelines, the weekly clock, the year grid, the seasons.
 */
import { type CommonOpts, type Ctx, context, head, minMsOf, type ReportHead } from "@app/spotify/lib/context";
import { genreRows } from "@app/spotify/lib/genre-rows";
import { type Bucket, counted, localTime, type Play, parseBucket } from "@app/spotify/lib/history";
import { autoBucket, dense, denseBuckets, totalSeries } from "@app/spotify/lib/series";
import { maxOf } from "@genesiscz/utils/math";

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface TimelineOpts extends CommonOpts {
    bucket?: string;
    by?: string;
}

export interface TimelineReport {
    head: ReportHead;
    empty: boolean;
    bucket: Bucket;
    metric: "plays" | "ms";
    points: { bucket: string; value: number; plays: number; ms: number }[];
    peak: { bucket: string; value: number } | null;
}

export function timelineReport(o: TimelineOpts, given?: Ctx): TimelineReport {
    const ctx = given ?? context(o);
    const plays = counted(ctx.plays, minMsOf(o));
    if (!plays.length) {
        return { head: head(ctx), empty: true, bucket: "month", metric: "plays", points: [], peak: null };
    }

    const bucket = parseBucket(o.bucket, autoBucket(plays));
    const metric = o.by === "hours" || o.by === "ms" ? "ms" : "plays";
    const keys = denseBuckets(plays, ctx.tz, bucket);
    const playSeries = dense(totalSeries(plays, ctx.tz, bucket, "plays"), keys);
    const msSeries = dense(totalSeries(plays, ctx.tz, bucket, "ms"), keys);
    const values = metric === "ms" ? msSeries : playSeries;
    const max = Math.max(...values);
    const peakIndex = values.indexOf(max);

    return {
        head: head(ctx),
        empty: false,
        bucket,
        metric,
        points: keys.map((k, i) => ({ bucket: k, value: values[i]!, plays: playSeries[i]!, ms: msSeries[i]! })),
        peak: { bucket: keys[peakIndex]!, value: max },
    };
}

export interface ClockReport {
    head: ReportHead;
    empty: boolean;
    /** 7 rows (Mon..Sun) of 24 hour cells. */
    byWeekdayHour: number[][];
    byHour: number[];
    byWeekday: number[];
    plays: number;
    peakHour: number;
    nightShare: number;
    officeShare: number;
    weekendShare: number;
}

export function clockReport(o: CommonOpts, given?: Ctx): ClockReport {
    const ctx = given ?? context(o);
    const plays = counted(ctx.plays, minMsOf(o));
    const grid: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    const hourTotals = new Array<number>(24).fill(0);
    const dayTotals = new Array<number>(7).fill(0);
    if (!plays.length) {
        return {
            head: head(ctx),
            empty: true,
            byWeekdayHour: grid,
            byHour: hourTotals,
            byWeekday: dayTotals,
            plays: 0,
            peakHour: 0,
            nightShare: 0,
            officeShare: 0,
            weekendShare: 0,
        };
    }

    for (const p of plays) {
        const t = localTime(p.ts, ctx.tz);
        grid[t.weekday]![t.hour]!++;
        hourTotals[t.hour]!++;
        dayTotals[t.weekday]!++;
    }

    const night = hourTotals.slice(0, 5).reduce((a, b) => a + b, 0);
    const workHours = hourTotals.slice(9, 18).reduce((a, b) => a + b, 0);

    return {
        head: head(ctx),
        empty: false,
        byWeekdayHour: grid,
        byHour: hourTotals,
        byWeekday: dayTotals,
        plays: plays.length,
        peakHour: hourTotals.indexOf(Math.max(...hourTotals)),
        nightShare: night / plays.length,
        officeShare: workHours / plays.length,
        weekendShare: (dayTotals[5]! + dayTotals[6]!) / plays.length,
    };
}

export interface CalendarReport {
    head: ReportHead;
    empty: boolean;
    /** ISO date → plays on that local day. Sparse: absent days had none. */
    days: Record<string, number>;
    max: number;
    years: string[];
}

export function calendarReport(o: CommonOpts, given?: Ctx): CalendarReport {
    const ctx = given ?? context(o);
    const plays = counted(ctx.plays, minMsOf(o));
    if (!plays.length) {
        return { head: head(ctx), empty: true, days: {}, max: 0, years: [] };
    }

    const perDay = new Map<string, number>();
    for (const p of plays) {
        const d = localTime(p.ts, ctx.tz).date;
        perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }

    return {
        head: head(ctx),
        empty: false,
        days: Object.fromEntries(perDay),
        max: maxOf(perDay.values(), 0),
        years: [...new Set([...perDay.keys()].map((d) => d.slice(0, 4)))].sort(),
    };
}

export type SeasonName = "winter" | "spring" | "summer" | "autumn";

export interface SeasonsReport {
    head: ReportHead;
    empty: boolean;
    byMonth: { month: string; plays: number; ms: number; hours: number }[];
    bySeason: { season: SeasonName; plays: number; topGenres: { genre: string; share: number }[] }[];
}

const seasonOf = (m: number): SeasonName =>
    m === 12 || m <= 2 ? "winter" : m <= 5 ? "spring" : m <= 8 ? "summer" : "autumn";

export function seasonsReport(o: CommonOpts, given?: Ctx): SeasonsReport {
    const ctx = given ?? context(o);
    const plays = counted(ctx.plays, minMsOf(o));
    if (!plays.length) {
        return { head: head(ctx), empty: true, byMonth: [], bySeason: [] };
    }

    const perMonth = new Array<number>(12).fill(0);
    const msPerMonth = new Array<number>(12).fill(0);
    const seasons: Record<SeasonName, Play[]> = { winter: [], spring: [], summer: [], autumn: [] };
    for (const p of plays) {
        const t = localTime(p.ts, ctx.tz);
        perMonth[t.m - 1]!++;
        msPerMonth[t.m - 1]! += p.ms;
        seasons[seasonOf(t.m)]!.push(p);
    }

    const names: SeasonName[] = ["winter", "spring", "summer", "autumn"];

    return {
        head: head(ctx),
        empty: false,
        byMonth: perMonth.map((v, i) => ({
            month: MONTHS[i]!,
            plays: v,
            ms: msPerMonth[i]!,
            hours: +(msPerMonth[i]! / 3600000).toFixed(1),
        })),
        bySeason: names.map((name) => {
            const list = seasons[name];
            if (ctx.genres.empty) {
                return { season: name, plays: list.length, topGenres: [] };
            }

            const { rows, tagged } = genreRows(ctx, list);

            return {
                season: name,
                plays: list.length,
                topGenres: rows.slice(0, 4).map((r) => ({ genre: r.genre, share: r.plays / Math.max(1, tagged) })),
            };
        }),
    };
}
