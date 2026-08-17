/**
 * How the listening happens rather than what: devices, shuffle, skips, sittings, streaks.
 *
 * The export carries a `skipped` flag that is null for most of the archive's history, so
 * skip rate is derived from what always exists: a play that ended on the forward button, or
 * ended under the 30 second bar.
 */
import {
    type CommonOpts,
    type Ctx,
    context,
    head,
    minMsOf,
    numberOption,
    type ReportHead,
} from "@app/spotify/lib/context";
import { byArtist, counted, localTime, median, PLAY_MS, type Play } from "@app/spotify/lib/history";
import { longestStreak, type Streak, sessionize } from "@app/spotify/lib/stats";

export interface BreakdownRow {
    key: string;
    plays: number;
    ms: number;
}

function breakdown(plays: Play[], keyOf: (p: Play) => string, limit = 12): BreakdownRow[] {
    const m = new Map<string, { plays: number; ms: number }>();
    for (const p of plays) {
        const k = keyOf(p) || "unknown";
        const row = m.get(k) ?? { plays: 0, ms: 0 };
        row.plays++;
        row.ms += p.ms;
        m.set(k, row);
    }

    return [...m.entries()]
        .sort((a, b) => b[1].plays - a[1].plays)
        .slice(0, limit)
        .map(([key, v]) => ({ key, plays: v.plays, ms: v.ms }));
}

export interface BehaviorReport {
    head: ReportHead;
    empty: boolean;
    events: number;
    plays: number;
    rates: {
        shuffle: number;
        offline: number;
        incognito: number;
        skipFlag: number;
        forwardEnd: number;
        completed: number;
    };
    platforms: BreakdownRow[];
    countries: BreakdownRow[];
    reasonStart: BreakdownRow[];
    reasonEnd: BreakdownRow[];
}

export function behaviorReport(o: CommonOpts, given?: Ctx): BehaviorReport {
    const ctx = given ?? context(o);
    const all = ctx.plays;
    const played = counted(all, minMsOf(o));
    if (!all.length) {
        return {
            head: head(ctx),
            empty: true,
            events: 0,
            plays: 0,
            rates: { shuffle: 0, offline: 0, incognito: 0, skipFlag: 0, forwardEnd: 0, completed: 0 },
            platforms: [],
            countries: [],
            reasonStart: [],
            reasonEnd: [],
        };
    }

    const denom = Math.max(1, played.length);
    const shuffled = played.filter((p) => p.shuffle).length;
    const offline = played.filter((p) => p.offline).length;
    const incognito = all.filter((p) => p.incognito).length;
    const skippedFlag = all.filter((p) => p.skipped).length;
    const forwarded = all.filter((p) => p.reasonEnd === "fwdbtn").length;
    const completed = all.filter((p) => p.reasonEnd === "trackdone").length;

    return {
        head: head(ctx),
        empty: false,
        events: all.length,
        plays: played.length,
        rates: {
            shuffle: shuffled / denom,
            offline: offline / denom,
            incognito: incognito / all.length,
            skipFlag: skippedFlag / all.length,
            forwardEnd: forwarded / all.length,
            completed: completed / all.length,
        },
        platforms: breakdown(played, (p) => p.platform, 20),
        countries: breakdown(played, (p) => p.country, 20),
        reasonStart: breakdown(all, (p) => p.reasonStart, 20),
        reasonEnd: breakdown(all, (p) => p.reasonEnd, 20),
    };
}

export interface SkipRow {
    artist: string;
    starts: number;
    skips: number;
    ms: number;
    rate: number;
}

export interface SkipsReport {
    head: ReportHead;
    minStarts: number;
    overallRate: number;
    /** Ranked most-skipped first; the most-finished tail is the same array reversed. */
    artists: SkipRow[];
}

export function skipsReport(o: CommonOpts & { min?: string }, given?: Ctx): SkipsReport {
    const ctx = given ?? context(o);
    const all = ctx.plays;
    const min = numberOption(o.min, "min", 12);

    const rows = new Map<string, { label: string; starts: number; skips: number; ms: number }>();
    for (const p of all) {
        const k = p.artist.toLowerCase();
        const r = rows.get(k) ?? { label: p.artist, starts: 0, skips: 0, ms: 0 };
        r.starts++;
        if (p.ms < PLAY_MS || p.reasonEnd === "fwdbtn") {
            r.skips++;
        }

        r.ms += p.ms;
        rows.set(k, r);
    }

    const ranked = [...rows.values()]
        .filter((r) => r.starts >= min)
        .map((r) => ({ artist: r.label, starts: r.starts, skips: r.skips, ms: r.ms, rate: r.skips / r.starts }))
        .sort((a, b) => b.rate - a.rate);

    return {
        head: head(ctx),
        minStarts: min,
        overallRate: all.filter((p) => p.ms < PLAY_MS || p.reasonEnd === "fwdbtn").length / Math.max(1, all.length),
        artists: ranked,
    };
}

export interface SessionRow {
    start: string;
    startMs: number;
    minutes: number;
    tracks: number;
    artists: number;
    topArtist: string;
}

export interface SessionsReport {
    head: ReportHead;
    empty: boolean;
    gapMinutes: number;
    count: number;
    medianMinutes: number;
    meanMinutes: number;
    medianTracks: number;
    perActiveDay: number;
    /** Every sitting, longest first. */
    sessions: SessionRow[];
}

export function sessionsReport(o: CommonOpts & { gap?: string }, given?: Ctx): SessionsReport {
    const ctx = given ?? context(o);
    const plays = counted(ctx.plays, minMsOf(o));
    const gapMs = numberOption(o.gap, "gap", 30) * 60000;
    if (!plays.length) {
        return {
            head: head(ctx),
            empty: true,
            gapMinutes: gapMs / 60000,
            count: 0,
            medianMinutes: 0,
            meanMinutes: 0,
            medianTracks: 0,
            perActiveDay: 0,
            sessions: [],
        };
    }

    const sessions = sessionize(plays, gapMs).map((s) => ({
        startMs: s.start,
        start: new Date(s.start).toISOString(),
        minutes: (s.end - s.start) / 60000,
        tracks: s.items.length,
        artists: new Set(s.items.map((i) => i.artist)).size,
        topArtist: [...byArtist(s.items).values()].sort((a, b) => b.plays - a.plays)[0]?.label ?? "",
    }));

    const totalMin = sessions.reduce((s, x) => s + x.minutes, 0);
    const perDay = new Set(sessions.map((s) => localTime(s.startMs, ctx.tz).date));

    return {
        head: head(ctx),
        empty: false,
        gapMinutes: gapMs / 60000,
        count: sessions.length,
        medianMinutes: median(sessions.map((s) => s.minutes)),
        meanMinutes: totalMin / sessions.length,
        medianTracks: median(sessions.map((s) => s.tracks)),
        perActiveDay: sessions.length / Math.max(1, perDay.size),
        sessions: [...sessions].sort((a, b) => b.minutes - a.minutes),
    };
}

export interface StreaksReport {
    head: ReportHead;
    empty: boolean;
    activeDays: number;
    longest: Streak | null;
    current: Streak | null;
    /** Every run of consecutive listening days, longest first. */
    runs: Streak[];
    /** Every silence between runs, longest first. */
    gaps: { days: number; from: string; to: string }[];
}

export function streaksReport(o: CommonOpts, given?: Ctx): StreaksReport {
    const ctx = given ?? context(o);
    const plays = counted(ctx.plays, minMsOf(o));
    if (!plays.length) {
        return { head: head(ctx), empty: true, activeDays: 0, longest: null, current: null, runs: [], gaps: [] };
    }

    const days = [...new Set(plays.map((p) => localTime(p.ts, ctx.tz).date))].sort();
    const { longest, current, total } = longestStreak(days);

    const runs: Streak[] = [];
    const gaps: { days: number; from: string; to: string }[] = [];
    const next = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    let runStart = days[0]!;
    let runLen = 1;
    for (let i = 1; i < days.length; i++) {
        if (next(days[i - 1]!) === days[i]) {
            runLen++;
            continue;
        }

        runs.push({ length: runLen, start: runStart, end: days[i - 1]! });
        gaps.push({
            days: Math.round((Date.parse(days[i]!) - Date.parse(days[i - 1]!)) / 86400000) - 1,
            from: days[i - 1]!,
            to: days[i]!,
        });
        runStart = days[i]!;
        runLen = 1;
    }

    runs.push({ length: runLen, start: runStart, end: days[days.length - 1]! });

    return {
        head: head(ctx),
        empty: false,
        activeDays: total,
        longest,
        current,
        runs: [...runs].sort((a, b) => b.length - a.length),
        gaps: [...gaps].sort((a, b) => b.days - a.days),
    };
}
