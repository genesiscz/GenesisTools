/**
 * The biography reports: what arrived when, what stuck, what got left behind.
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
import { bucketOf, counted, localTime, songKey } from "@app/spotify/lib/history";
import { rollingPeak } from "@app/spotify/lib/stats";

const MONTH_MS = 30 * 86400000;

export interface DiscoveryYearRow {
    year: string;
    plays: number;
    artists: number;
    newArtists: number;
    newTracks: number;
    noveltyShare: number;
}

export interface DiscoveryReport {
    head: ReportHead;
    empty: boolean;
    years: DiscoveryYearRow[];
}

export function discoveryReport(o: CommonOpts, given?: Ctx): DiscoveryReport {
    const ctx = given ?? context(o);
    const plays = counted(ctx.plays, minMsOf(o));
    if (!plays.length) {
        return { head: head(ctx), empty: true, years: [] };
    }

    const firstArtist = new Map<string, number>();
    const firstTrack = new Map<string, number>();
    for (const p of plays) {
        const a = p.artist.toLowerCase();
        if (!firstArtist.has(a)) {
            firstArtist.set(a, p.ts);
        }

        if (!firstTrack.has(p.uri)) {
            firstTrack.set(p.uri, p.ts);
        }
    }

    // Resolve each artist's first-play year once. Doing it inside the play loop calls
    // `localTime` a second time per play, and that timezone conversion is the most expensive
    // step in the loop.
    const firstArtistYear = new Map<string, string>();
    for (const [artist, ts] of firstArtist) {
        firstArtistYear.set(artist, String(localTime(ts, ctx.tz).y));
    }

    const years = new Map<
        string,
        { plays: number; newArtists: number; newTracks: number; playsFromNew: number; artists: Set<string> }
    >();
    for (const p of plays) {
        const y = String(localTime(p.ts, ctx.tz).y);
        let row = years.get(y);
        if (!row) {
            row = { plays: 0, newArtists: 0, newTracks: 0, playsFromNew: 0, artists: new Set() };
            years.set(y, row);
        }

        const artist = p.artist.toLowerCase();
        row.plays++;
        row.artists.add(artist);
        if (firstArtistYear.get(artist) === y) {
            row.playsFromNew++;
        }
    }

    for (const year of firstArtistYear.values()) {
        const row = years.get(year);
        if (row) {
            row.newArtists++;
        }
    }

    for (const ts of firstTrack.values()) {
        const row = years.get(String(localTime(ts, ctx.tz).y));
        if (row) {
            row.newTracks++;
        }
    }

    return {
        head: head(ctx),
        empty: false,
        years: [...years.entries()].sort().map(([year, r]) => ({
            year,
            plays: r.plays,
            artists: r.artists.size,
            newArtists: r.newArtists,
            newTracks: r.newTracks,
            noveltyShare: r.playsFromNew / r.plays,
        })),
    };
}

export interface FirstRow {
    artist: string;
    plays: number;
    first: string;
    last: string;
    yearsActive: number;
    stillActive: boolean;
}

export interface FirstsReport {
    head: ReportHead;
    minPlays: number;
    artists: FirstRow[];
}

export function firstsReport(o: CommonOpts & { min?: string }, given?: Ctx): FirstsReport {
    const ctx = given ?? context(o);
    const plays = counted(ctx.plays, minMsOf(o));
    const min = numberOption(o.min, "min", 60);

    const m = new Map<string, { label: string; first: number; last: number; plays: number }>();
    for (const p of plays) {
        const k = p.artist.toLowerCase();
        const r = m.get(k) ?? { label: p.artist, first: p.ts, last: p.ts, plays: 0 };
        r.plays++;
        r.first = Math.min(r.first, p.ts);
        r.last = Math.max(r.last, p.ts);
        m.set(k, r);
    }

    const now = plays.length ? plays[plays.length - 1]!.ts : Date.now();

    return {
        head: head(ctx),
        minPlays: min,
        artists: [...m.values()]
            .filter((r) => r.plays >= min)
            .sort((a, b) => a.first - b.first)
            .map((r) => ({
                artist: r.label,
                plays: r.plays,
                first: new Date(r.first).toISOString(),
                last: new Date(r.last).toISOString(),
                yearsActive: +((r.last - r.first) / (365 * 86400000)).toFixed(1),
                stillActive: now - r.last < 180 * 86400000,
            })),
    };
}

export interface ForgottenRow {
    track: string;
    artist: string;
    plays: number;
    hours: number;
    lastPlayed: string;
    silentMonths: number;
}

export interface ForgottenReport {
    head: ReportHead;
    minPlays: number;
    quietMonths: number;
    tracks: ForgottenRow[];
}

export function forgottenReport(o: CommonOpts & { min?: string; quietMonths?: string }, given?: Ctx): ForgottenReport {
    const ctx = given ?? context(o);
    const plays = counted(ctx.plays, minMsOf(o));
    const min = numberOption(o.min, "min", 15);
    const quiet = numberOption(o.quietMonths, "quiet-months", 18) * MONTH_MS;
    const now = ctx.all.length ? ctx.all[ctx.all.length - 1]!.ts : Date.now();

    const m = new Map<
        string,
        { name: string; artist: string; plays: number; first: number; last: number; ms: number }
    >();
    for (const p of plays) {
        const k = songKey(p);
        const r = m.get(k) ?? { name: p.name, artist: p.artist, plays: 0, first: p.ts, last: p.ts, ms: 0 };
        r.plays++;
        r.ms += p.ms;
        r.first = Math.min(r.first, p.ts);
        r.last = Math.max(r.last, p.ts);
        m.set(k, r);
    }

    return {
        head: head(ctx),
        minPlays: min,
        quietMonths: quiet / MONTH_MS,
        tracks: [...m.values()]
            .filter((r) => r.plays >= min && now - r.last >= quiet)
            .sort((a, b) => b.plays - a.plays)
            .map((r) => ({
                track: r.name,
                artist: r.artist,
                plays: r.plays,
                hours: +(r.ms / 3600000).toFixed(2),
                lastPlayed: new Date(r.last).toISOString(),
                silentMonths: Math.round((now - r.last) / MONTH_MS),
            })),
    };
}

export interface ObsessionRow {
    track: string;
    artist: string;
    totalPlays: number;
    peakPlays: number;
    windowStart: string;
    windowEnd: string;
    intensity: number;
}

export interface ObsessionsReport {
    head: ReportHead;
    empty: boolean;
    windowDays: number;
    minPlays: number;
    /** Every qualifying song, hardest binge first. */
    hardest: ObsessionRow[];
    byMonth: (ObsessionRow & { month: string })[];
}

export function obsessionsReport(o: CommonOpts & { window?: string; min?: string }, given?: Ctx): ObsessionsReport {
    const ctx = given ?? context(o);
    const plays = counted(ctx.plays, minMsOf(o));
    const windowMs = numberOption(o.window, "window", 30) * 86400000;
    const min = numberOption(o.min, "min", 6);
    if (!plays.length) {
        return {
            head: head(ctx),
            empty: true,
            windowDays: windowMs / 86400000,
            minPlays: min,
            hardest: [],
            byMonth: [],
        };
    }

    const songs = new Map<string, { name: string; artist: string; ts: number[] }>();
    for (const p of plays) {
        const k = songKey(p);
        const r = songs.get(k) ?? { name: p.name, artist: p.artist, ts: [] };
        r.ts.push(p.ts);
        songs.set(k, r);
    }

    const peaks = [...songs.values()]
        .filter((r) => r.ts.length >= min)
        .map((r) => {
            const peak = rollingPeak(r.ts, windowMs);

            return {
                track: r.name,
                artist: r.artist,
                totalPlays: r.ts.length,
                peakPlays: peak.count,
                peakStartMs: peak.start,
                windowStart: new Date(peak.start).toISOString(),
                windowEnd: new Date(peak.end).toISOString(),
                intensity: peak.count / r.ts.length,
            };
        })
        .sort((a, b) => b.peakPlays - a.peakPlays);

    const perMonth = new Map<string, (typeof peaks)[number]>();
    for (const p of peaks) {
        const key = bucketOf(p.peakStartMs, ctx.tz, "month");
        const cur = perMonth.get(key);
        if (!cur || p.peakPlays > cur.peakPlays) {
            perMonth.set(key, p);
        }
    }

    const strip = ({ peakStartMs: _peakStartMs, ...rest }: (typeof peaks)[number]): ObsessionRow => rest;

    return {
        head: head(ctx),
        empty: false,
        windowDays: windowMs / 86400000,
        minPlays: min,
        hardest: peaks.map(strip),
        byMonth: [...perMonth.entries()].sort().map(([month, p]) => ({ month, ...strip(p) })),
    };
}

export interface LoyaltyRow {
    artist: string;
    plays: number;
    ms: number;
    activeMonths: number;
    spanMonths: number;
    consistency: number;
    first: string;
    last: string;
    stillActive: boolean;
}

export interface LoyaltyReport {
    head: ReportHead;
    minPlays: number;
    artists: LoyaltyRow[];
    /** Ranked by how many distinct months they survived. */
    longestCompanions: LoyaltyRow[];
    /** Dormant artists ranked by how intense the phase was while it lasted. */
    endedPhases: LoyaltyRow[];
}

export function loyaltyReport(o: CommonOpts & { min?: string }, given?: Ctx): LoyaltyReport {
    const ctx = given ?? context(o);
    const plays = counted(ctx.plays, minMsOf(o));
    const min = numberOption(o.min, "min", 40);
    const now = plays.length ? plays[plays.length - 1]!.ts : Date.now();

    const m = new Map<
        string,
        { label: string; plays: number; months: Set<string>; first: number; last: number; ms: number }
    >();
    for (const p of plays) {
        const k = p.artist.toLowerCase();
        const r = m.get(k) ?? { label: p.artist, plays: 0, months: new Set<string>(), first: p.ts, last: p.ts, ms: 0 };
        r.plays++;
        r.ms += p.ms;
        r.months.add(bucketOf(p.ts, ctx.tz, "month"));
        r.first = Math.min(r.first, p.ts);
        r.last = Math.max(r.last, p.ts);
        m.set(k, r);
    }

    const rows: LoyaltyRow[] = [...m.values()]
        .filter((r) => r.plays >= min)
        .map((r) => {
            const spanMonths = Math.max(1, Math.round((r.last - r.first) / MONTH_MS) + 1);

            return {
                artist: r.label,
                plays: r.plays,
                ms: r.ms,
                activeMonths: r.months.size,
                spanMonths,
                consistency: r.months.size / spanMonths,
                first: new Date(r.first).toISOString(),
                last: new Date(r.last).toISOString(),
                stillActive: now - r.last < 180 * 86400000,
            };
        });

    return {
        head: head(ctx),
        minPlays: min,
        artists: rows,
        longestCompanions: [...rows].sort((a, b) => b.activeMonths - a.activeMonths || b.consistency - a.consistency),
        endedPhases: [...rows]
            .filter((r) => !r.stillActive)
            .sort((a, b) => b.plays / b.activeMonths - a.plays / a.activeMonths),
    };
}
