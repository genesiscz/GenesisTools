/**
 * One artist, one track, or a search across everything ever played.
 */
import { type CommonOpts, type Ctx, context, head, minMsOf, type ReportHead } from "@app/spotify/lib/context";
import {
    type Bucket,
    byAlbum,
    byArtist,
    bySong,
    counted,
    type Play,
    songKey,
    sortedAggs,
} from "@app/spotify/lib/history";
import { autoBucket, dense, denseBuckets, downsample, downsampleKeys, totalSeries } from "@app/spotify/lib/series";
import { rollingPeak } from "@app/spotify/lib/stats";

const PEAK_WINDOW_MS = 30 * 86400000;

export interface Arc {
    bucket: Bucket;
    keys: string[];
    values: number[];
    /** Full-resolution series, for a chart that can afford every point. */
    fullKeys: string[];
    fullValues: number[];
    peak: { bucket: string; plays: number } | null;
}

function arcOf(plays: Play[], tz: string): Arc {
    const bucket = autoBucket(plays);
    const keys = denseBuckets(plays, tz, bucket);
    const values = dense(totalSeries(plays, tz, bucket), keys);
    const peakIndex = values.length ? values.indexOf(Math.max(...values)) : -1;

    return {
        bucket,
        keys: downsampleKeys(keys, 60),
        values: downsample(values, 60),
        fullKeys: keys,
        fullValues: values,
        peak: peakIndex >= 0 ? { bucket: keys[peakIndex]!, plays: values[peakIndex]! } : null,
    };
}

export interface ArtistReport {
    head: ReportHead;
    query: string;
    found: boolean;
    matched: string[];
    plays: number;
    ms: number;
    hours: number;
    rank: number;
    totalArtists: number;
    shareOfPlays: number;
    distinctTracks: number;
    first: string;
    last: string;
    genres: string[];
    peakWindow: { plays: number; start: string } | null;
    arc: Arc | null;
    topTracks: { track: string; plays: number; ms: number; hours: number }[];
    topAlbums: { album: string; plays: number; tracks: number }[];
}

export function artistReport(query: string, o: CommonOpts, given?: Ctx): ArtistReport {
    const ctx = given ?? context(o);
    const all = counted(ctx.plays, minMsOf(o));
    const q = query.toLowerCase();
    const mine = all.filter((p) => p.artist.toLowerCase().includes(q));
    const base = {
        head: head(ctx),
        query,
        matched: [] as string[],
        plays: 0,
        ms: 0,
        hours: 0,
        rank: 0,
        totalArtists: 0,
        shareOfPlays: 0,
        distinctTracks: 0,
        first: "",
        last: "",
        genres: [] as string[],
        peakWindow: null,
        arc: null,
        topTracks: [],
        topAlbums: [],
    };

    if (!mine.length) {
        return { ...base, found: false };
    }

    // Matches, most played first. A substring query hits several artists ("Nocturne Drive" and
    // "Nocturne"), and the headline name and the rank both have to be about the same one — the
    // biggest. Insertion order is the order of first play, which put a footnote at the top and
    // then reported ITS rank beside statistics summed over all the matches.
    const playsByName = new Map<string, number>();
    for (const p of mine) {
        playsByName.set(p.artist, (playsByName.get(p.artist) ?? 0) + 1);
    }

    const names = [...playsByName.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const ms = mine.reduce((s, p) => s + p.ms, 0);
    const allArtists = sortedAggs(byArtist(all));
    const rank = allArtists.findIndex((a) => a.key === names[0]!.toLowerCase()) + 1;
    const songs = sortedAggs(bySong(mine));
    const albums = sortedAggs(byAlbum(mine));
    const peak = rollingPeak(
        mine.map((p) => p.ts),
        PEAK_WINDOW_MS
    );

    return {
        ...base,
        found: true,
        matched: names,
        plays: mine.length,
        ms,
        hours: +(ms / 3600000).toFixed(2),
        rank,
        totalArtists: allArtists.length,
        shareOfPlays: mine.length / all.length,
        distinctTracks: new Set(mine.map((p) => p.uri)).size,
        first: new Date(mine[0]!.ts).toISOString(),
        last: new Date(mine[mine.length - 1]!.ts).toISOString(),
        genres: ctx.genres.forArtist(names[0]!),
        peakWindow: { plays: peak.count, start: new Date(peak.start).toISOString() },
        arc: arcOf(mine, ctx.tz),
        topTracks: songs.map((a) => ({
            track: a.label,
            plays: a.plays,
            ms: a.ms,
            hours: +(a.ms / 3600000).toFixed(2),
        })),
        topAlbums: albums.map((a) => ({ album: a.label, plays: a.plays, tracks: a.uris.size })),
    };
}

export interface TrackReport {
    head: ReportHead;
    query: string;
    found: boolean;
    track: string;
    artist: string;
    plays: number;
    shortPlays: number;
    ms: number;
    hours: number;
    rank: number;
    totalSongs: number;
    releases: number;
    first: string;
    last: string;
    peakWindow: { plays: number; start: string } | null;
    arc: Arc | null;
    otherMatches: { track: string; artist: string; plays: number }[];
}

export function trackReport(query: string, o: CommonOpts, given?: Ctx): TrackReport {
    const ctx = given ?? context(o);
    const all = counted(ctx.plays, minMsOf(o));
    const q = query.toLowerCase();
    const matches = all.filter((p) => p.name.toLowerCase().includes(q));
    const base = {
        head: head(ctx),
        query,
        track: "",
        artist: "",
        plays: 0,
        shortPlays: 0,
        ms: 0,
        hours: 0,
        rank: 0,
        totalSongs: 0,
        releases: 0,
        first: "",
        last: "",
        peakWindow: null,
        arc: null,
        otherMatches: [],
    };

    if (!matches.length) {
        return { ...base, found: false };
    }

    const grouped = sortedAggs(bySong(matches));
    const best = grouped[0]!;
    const mine = matches.filter((p) => songKey(p) === best.key);
    const peak = rollingPeak(
        mine.map((p) => p.ts),
        PEAK_WINDOW_MS
    );
    const allSongs = sortedAggs(bySong(all));

    return {
        ...base,
        found: true,
        track: best.label,
        artist: best.sub,
        plays: best.plays,
        shortPlays: best.shortPlays,
        ms: best.ms,
        hours: +(best.ms / 3600000).toFixed(2),
        rank: allSongs.findIndex((a) => a.key === best.key) + 1,
        totalSongs: allSongs.length,
        releases: best.uris.size,
        first: new Date(best.first).toISOString(),
        last: new Date(best.last).toISOString(),
        peakWindow: { plays: peak.count, start: new Date(peak.start).toISOString() },
        arc: arcOf(mine, ctx.tz),
        otherMatches: grouped.slice(1).map((a) => ({ track: a.label, artist: a.sub, plays: a.plays })),
    };
}

export interface SearchReport {
    head: ReportHead;
    query: string;
    found: boolean;
    plays: number;
    songs: { track: string; artist: string; plays: number; first: string; last: string }[];
    artists: { artist: string; plays: number }[];
}

export function searchReport(query: string, o: CommonOpts, given?: Ctx): SearchReport {
    const ctx = given ?? context(o);
    const all = counted(ctx.plays, minMsOf(o));
    const q = query.toLowerCase();
    const matches = all.filter(
        (p) =>
            p.name.toLowerCase().includes(q) || p.artist.toLowerCase().includes(q) || p.album.toLowerCase().includes(q)
    );
    if (!matches.length) {
        return { head: head(ctx), query, found: false, plays: 0, songs: [], artists: [] };
    }

    return {
        head: head(ctx),
        query,
        found: true,
        plays: matches.length,
        songs: sortedAggs(bySong(matches)).map((a) => ({
            track: a.label,
            artist: a.sub,
            plays: a.plays,
            first: new Date(a.first).toISOString(),
            last: new Date(a.last).toISOString(),
        })),
        artists: sortedAggs(byArtist(matches)).map((a) => ({ artist: a.label, plays: a.plays })),
    };
}
