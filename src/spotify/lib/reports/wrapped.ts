/**
 * A year in review, computed locally from the export — available for every year on record,
 * not just the current one, and without waiting for December.
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
import { genreRows } from "@app/spotify/lib/genre-rows";
import { byAlbum, byArtist, bySong, counted, localTime, type Play, sortedAggs } from "@app/spotify/lib/history";
import { MONTHS } from "@app/spotify/lib/reports/time";
import { sessionize } from "@app/spotify/lib/stats";

const SESSION_GAP_MS = 30 * 60000;

export interface WrappedReport {
    head: ReportHead;
    year: number;
    yearsOnRecord: number[];
    plays: number;
    ms: number;
    hours: number;
    minutes: number;
    previous: { year: number; plays: number; ms: number } | null;
    vsPreviousYear: number | null;
    distinct: { tracks: number; artists: number; albums: number };
    activeDays: number;
    sessions: number;
    newArtists: number;
    carriedOver: number;
    topDay: { date: string; plays: number } | null;
    topSongs: { track: string; artist: string; plays: number }[];
    topArtists: { artist: string; plays: number; ms: number; hours: number }[];
    topAlbums: { album: string; artist: string; plays: number }[];
    topGenres: { genre: string; plays: number; share: number }[];
    discoveries: { artist: string; plays: number; first: string }[];
    byMonth: { month: string; plays: number }[];
}

const slice = (plays: Play[], tz: string, year: number) => plays.filter((p) => localTime(p.ts, tz).y === year);

/**
 * `wrapped` always spans a whole calendar year, so it deliberately ignores `--since` /
 * `--until` / `--year` on the context and re-slices from everything on record.
 */
export function wrappedReport(yearArg: string | undefined, o: CommonOpts, given?: Ctx): WrappedReport {
    const ctx = given ?? context({ ...o, year: undefined, since: undefined, until: undefined });
    const all = counted(ctx.all, minMsOf(o));
    const years = [...new Set(all.map((p) => localTime(p.ts, ctx.tz).y))].sort();
    // Through the shared guard, so `wrapped nonsense` says which option was wrong instead of
    // "no plays in NaN" — `years.includes(NaN)` is false, so the bad input reached the error
    // message dressed as a missing year.
    const year = numberOption(yearArg ?? o.year, "year", years[years.length - 1] ?? 0, { min: 0, integer: true });
    if (!years.includes(year)) {
        throw new Error(`no plays in ${year}. Years on record: ${years.join(", ")}`);
    }

    const mine = slice(all, ctx.tz, year);
    const prev = slice(all, ctx.tz, year - 1);
    const ms = mine.reduce((s, p) => s + p.ms, 0);
    const prevMs = prev.reduce((s, p) => s + p.ms, 0);

    const songs = sortedAggs(bySong(mine));
    const artists = sortedAggs(byArtist(mine));
    const albums = sortedAggs(byAlbum(mine));
    const sessions = sessionize(mine, SESSION_GAP_MS);

    const seenBefore = new Set(all.filter((p) => localTime(p.ts, ctx.tz).y < year).map((p) => p.artist.toLowerCase()));
    const newArtists = artists.filter((a) => !seenBefore.has(a.key));

    const perDay = new Map<string, number>();
    const perMonth = new Array<number>(12).fill(0);
    for (const p of mine) {
        const t = localTime(p.ts, ctx.tz);
        perDay.set(t.date, (perDay.get(t.date) ?? 0) + 1);
        perMonth[t.m - 1]!++;
    }

    const topDay = [...perDay.entries()].sort((a, b) => b[1] - a[1])[0];
    const { rows: genres, tagged } = ctx.genres.empty ? { rows: [], tagged: 0 } : genreRows(ctx, mine);
    const prevArtists = new Set(prev.map((p) => p.artist.toLowerCase()));

    return {
        head: { ...head(ctx), window: String(year) },
        year,
        yearsOnRecord: years,
        plays: mine.length,
        ms,
        hours: +(ms / 3600000).toFixed(1),
        minutes: Math.round(ms / 60000),
        previous: prev.length ? { year: year - 1, plays: prev.length, ms: prevMs } : null,
        vsPreviousYear: prev.length ? (mine.length - prev.length) / prev.length : null,
        distinct: {
            tracks: new Set(mine.map((p) => p.uri)).size,
            artists: artists.length,
            albums: albums.length,
        },
        activeDays: perDay.size,
        sessions: sessions.length,
        newArtists: newArtists.length,
        carriedOver: artists.filter((a) => prevArtists.has(a.key)).length,
        topDay: topDay ? { date: topDay[0], plays: topDay[1] } : null,
        topSongs: songs.slice(0, 10).map((a) => ({ track: a.label, artist: a.sub, plays: a.plays })),
        topArtists: artists.slice(0, 10).map((a) => ({
            artist: a.label,
            plays: a.plays,
            ms: a.ms,
            hours: +(a.ms / 3600000).toFixed(1),
        })),
        topAlbums: albums.slice(0, 10).map((a) => ({ album: a.label, artist: a.sub, plays: a.plays })),
        topGenres: genres.slice(0, 10).map((g) => ({
            genre: g.genre,
            plays: g.plays,
            share: g.plays / Math.max(1, tagged),
        })),
        discoveries: newArtists.slice(0, 10).map((a) => ({
            artist: a.label,
            plays: a.plays,
            first: new Date(a.first).toISOString(),
        })),
        byMonth: perMonth.map((v, i) => ({ month: MONTHS[i]!, plays: v })),
    };
}
