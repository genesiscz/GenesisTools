/**
 * The one-screen answer to "so what does my listening look like".
 */
import { type CommonOpts, type Ctx, context, head, minMsOf, type ReportHead } from "@app/spotify/lib/context";
import { genreRows } from "@app/spotify/lib/genre-rows";
import { albumKey, byArtist, byTrack, counted, localTime, median, type Play } from "@app/spotify/lib/history";
import { loadLibrary } from "@app/spotify/lib/library";
import { gini, longestStreak, normalizedEntropy, type Streak, sessionize } from "@app/spotify/lib/stats";

const SESSION_GAP_MS = 30 * 60000;

export interface SummaryYearRow {
    year: string;
    plays: number;
    ms: number;
    hours: number;
    artists: number;
    newArtists: number;
    topArtist: string | null;
}

export interface SummaryGenreRow {
    genre: string;
    plays: number;
    share: number;
}

export interface SummaryReport {
    head: ReportHead;
    empty: boolean;
    span: { from: string; to: string; days: number };
    totals: {
        plays: number;
        shortPlays: number;
        ms: number;
        hours: number;
        tracks: number;
        artists: number;
        albums: number;
        activeDays: number;
        sessions: number;
        medianSessionMinutes: number;
    };
    shape: {
        playsPerActiveDay: number;
        activeDayShare: number;
        diversity: number;
        concentration: number;
        likedShareOfPlays: number | null;
        likedTracks: number;
    };
    streak: Streak | null;
    years: SummaryYearRow[];
    topGenres: SummaryGenreRow[];
    monthly: { month: string; plays: number }[];
}

const yearOf = (p: Play, tz: string) => String(localTime(p.ts, tz).y);

export function summaryReport(o: CommonOpts, given?: Ctx): SummaryReport {
    const ctx = given ?? context(o);
    const plays = counted(ctx.plays, minMsOf(o));
    if (!plays.length) {
        return {
            head: head(ctx),
            empty: true,
            span: { from: "", to: "", days: 0 },
            totals: {
                plays: 0,
                shortPlays: ctx.plays.length,
                ms: 0,
                hours: 0,
                tracks: 0,
                artists: 0,
                albums: 0,
                activeDays: 0,
                sessions: 0,
                medianSessionMinutes: 0,
            },
            shape: {
                playsPerActiveDay: 0,
                activeDayShare: 0,
                diversity: 0,
                concentration: 0,
                likedShareOfPlays: null,
                likedTracks: 0,
            },
            streak: null,
            years: [],
            topGenres: [],
            monthly: [],
        };
    }

    const ms = plays.reduce((s, p) => s + p.ms, 0);
    const tracks = byTrack(plays);
    const artists = byArtist(plays);
    const albums = new Set(plays.map(albumKey));
    const days = new Set(plays.map((p) => localTime(p.ts, ctx.tz).date));
    const streak = longestStreak(days);
    // Calendar days from the first local date to the last, inclusive — not the elapsed
    // milliseconds between two timestamps. `days` counts distinct local dates, so dividing one
    // by the other needs both to measure the same thing: two plays fourteen hours apart across
    // midnight are two active days over an elapsed 0.6, and the share came out above 100%.
    const first = localTime(plays[0]!.ts, ctx.tz).date;
    const last = localTime(plays[plays.length - 1]!.ts, ctx.tz).date;
    const spanDays = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86400000) + 1;
    const sessions = sessionize(plays, SESSION_GAP_MS);
    const artistPlays = [...artists.values()].map((a) => a.plays);
    const diversity = normalizedEntropy(artistPlays);
    const concentration = gini(artistPlays);
    const lib = loadLibrary(ctx.profile);
    const liked = new Set(lib.map((t) => t.uri));
    const likedPlays = plays.filter((p) => liked.has(p.uri)).length;

    const years = new Map<string, { plays: number; ms: number; artists: Set<string> }>();
    for (const p of plays) {
        const y = yearOf(p, ctx.tz);
        let row = years.get(y);
        if (!row) {
            row = { plays: 0, ms: 0, artists: new Set() };
            years.set(y, row);
        }

        row.plays++;
        row.ms += p.ms;
        row.artists.add(p.artist.toLowerCase());
    }

    const firstSeen = new Map<string, string>();
    for (const p of plays) {
        const k = p.artist.toLowerCase();
        if (!firstSeen.has(k)) {
            firstSeen.set(k, yearOf(p, ctx.tz));
        }
    }

    const newPerYear = new Map<string, number>();
    for (const y of firstSeen.values()) {
        newPerYear.set(y, (newPerYear.get(y) ?? 0) + 1);
    }

    // Counted on the lowercase key, like every other artist tally here, so "AIR" and "Air"
    // do not split into two counters and hand the year to the wrong artist. The first spelling
    // seen is kept as the label.
    const topArtistPerYear = new Map<string, string>();
    const artistLabels = new Map<string, string>();
    const perYearArtist = new Map<string, Map<string, number>>();
    for (const p of plays) {
        const y = yearOf(p, ctx.tz);
        let m = perYearArtist.get(y);
        if (!m) {
            m = new Map();
            perYearArtist.set(y, m);
        }

        const key = p.artist.toLowerCase();
        if (!artistLabels.has(key)) {
            artistLabels.set(key, p.artist);
        }

        m.set(key, (m.get(key) ?? 0) + 1);
    }

    for (const [y, m] of perYearArtist) {
        const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        topArtistPerYear.set(y, top ? (artistLabels.get(top) ?? top) : "");
    }

    const { rows: gr, tagged } = ctx.genres.empty ? { rows: [], tagged: 0 } : genreRows(ctx, plays);

    const monthly = new Map<string, number>();
    for (const p of plays) {
        const t = localTime(p.ts, ctx.tz);
        const k = `${t.y}-${String(t.m).padStart(2, "0")}`;
        monthly.set(k, (monthly.get(k) ?? 0) + 1);
    }

    return {
        head: head(ctx),
        empty: false,
        span: {
            from: new Date(plays[0]!.ts).toISOString(),
            to: new Date(plays[plays.length - 1]!.ts).toISOString(),
            days: Math.round(spanDays),
        },
        totals: {
            plays: plays.length,
            shortPlays: ctx.plays.length - plays.length,
            ms,
            hours: +(ms / 3600000).toFixed(1),
            tracks: tracks.size,
            artists: artists.size,
            albums: albums.size,
            activeDays: days.size,
            sessions: sessions.length,
            medianSessionMinutes: median(sessions.map((s) => (s.end - s.start) / 60000)),
        },
        shape: {
            playsPerActiveDay: plays.length / days.size,
            activeDayShare: days.size / Math.max(1, spanDays),
            diversity,
            concentration,
            likedShareOfPlays: lib.length ? likedPlays / plays.length : null,
            likedTracks: lib.length,
        },
        streak: streak.longest,
        years: [...years.entries()].sort().map(([y, r]) => ({
            year: y,
            plays: r.plays,
            ms: r.ms,
            hours: +(r.ms / 3600000).toFixed(1),
            artists: r.artists.size,
            newArtists: newPerYear.get(y) ?? 0,
            topArtist: topArtistPerYear.get(y) ?? null,
        })),
        topGenres: gr.slice(0, 10).map((g) => ({
            genre: g.genre,
            plays: g.plays,
            share: g.plays / Math.max(1, tagged),
        })),
        monthly: [...monthly.entries()].sort().map(([month, count]) => ({ month, plays: count })),
    };
}
