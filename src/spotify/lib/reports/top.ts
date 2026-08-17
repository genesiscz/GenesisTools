/**
 * Rankings: tracks, songs (releases folded), artists, albums, genres.
 *
 * `rows` is the FULL ranking — `--csv` and the dashboard's pagination both need every row,
 * and the caller decides how many to show. `trend` is only computed for the visible slice,
 * because building a per-key time series for 30k tracks costs far more than it is worth.
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
import {
    type Agg,
    albumKey,
    type Bucket,
    byAlbum,
    byArtist,
    bySong,
    byTrack,
    counted,
    type Play,
    songKey,
    sortedAggs,
} from "@app/spotify/lib/history";
import { autoBucket, dense, denseBuckets, downsample, downsampleKeys, seriesByKey } from "@app/spotify/lib/series";

export const TOP_KINDS = ["tracks", "songs", "artists", "albums", "genres"] as const;
export type TopKind = (typeof TOP_KINDS)[number];

export interface TopOpts extends CommonOpts {
    /** What to rank; the CLI passes this as a positional argument. Defaults to `tracks`. */
    kind?: string;
    by?: string;
    min?: string;
    /** Commander's `--no-trend` sets this to false. */
    trend?: boolean;
}

export interface TopRow {
    key: string;
    name: string;
    artist: string;
    plays: number;
    shortPlays: number;
    ms: number;
    hours: number;
    releases: number;
    first: string;
    last: string;
    /** Play counts per downsampled bucket, only on the visible slice. */
    trend?: number[];
}

export interface TopGenreRow {
    genre: string;
    plays: number;
    ms: number;
    hours: number;
    share: number;
    tracks: number;
    artists: number;
}

export interface TopReport {
    head: ReportHead;
    kind: TopKind;
    metric: "plays" | "hours";
    minPlays: number;
    /** How many rows the caller asked to display (`--top`). */
    limit: number;
    totals: { plays: number; ms: number; distinct: number };
    /** Genre data is missing entirely for this profile, so `genres` would be all zeros. */
    genresMissing: boolean;
    coverage: { taggedPlays: number; untaggedPlays: number };
    rows: TopRow[];
    genres: TopGenreRow[];
    trendBucket: Bucket | null;
    trendKeys: string[];
}

function aggregatorFor(kind: TopKind): (plays: Play[]) => Map<string, Agg> {
    if (kind === "songs") {
        return bySong;
    }

    if (kind === "artists") {
        return byArtist;
    }

    if (kind === "albums") {
        return byAlbum;
    }

    return byTrack;
}

function keyFor(kind: TopKind): (p: Play) => string {
    if (kind === "songs") {
        return songKey;
    }

    if (kind === "artists") {
        return (p) => p.artist.toLowerCase();
    }

    if (kind === "albums") {
        return albumKey;
    }

    return (p) => p.uri;
}

function rowOf(a: Agg): TopRow {
    return {
        key: a.key,
        name: a.label,
        artist: a.sub,
        plays: a.plays,
        shortPlays: a.shortPlays,
        ms: a.ms,
        hours: +(a.ms / 3600000).toFixed(2),
        releases: a.uris.size,
        first: new Date(a.first).toISOString(),
        last: new Date(a.last).toISOString(),
    };
}

export function parseTopKind(what: string | undefined): TopKind {
    const kind = (what ?? "tracks") as TopKind;
    if (!TOP_KINDS.includes(kind)) {
        throw new Error(`unknown "${what}". Pick one of: ${TOP_KINDS.join(", ")}`);
    }

    return kind;
}

export function topReport(o: TopOpts, given?: Ctx): TopReport {
    const ctx = given ?? context(o);
    const kind = parseTopKind(o.kind);
    const plays = counted(ctx.plays, minMsOf(o));
    const byHours = o.by === "hours" || o.by === "ms";
    const min = numberOption(o.min, "min", 1);
    const totalMs = plays.reduce((s, p) => s + p.ms, 0);

    if (kind === "genres") {
        const { rows, tagged, untagged } = ctx.genres.empty
            ? { rows: [], tagged: 0, untagged: plays.length }
            : genreRows(ctx, plays);
        const kept = rows.filter((r) => r.plays >= min);

        return {
            head: head(ctx),
            kind,
            metric: byHours ? "hours" : "plays",
            minPlays: min,
            limit: ctx.top,
            totals: { plays: plays.length, ms: totalMs, distinct: kept.length },
            genresMissing: ctx.genres.empty,
            coverage: { taggedPlays: tagged, untaggedPlays: untagged },
            rows: [],
            genres: kept.map((r) => ({
                genre: r.genre,
                plays: r.plays,
                ms: r.ms,
                hours: +(r.ms / 3600000).toFixed(2),
                share: r.plays / Math.max(1, tagged),
                tracks: r.tracks.size,
                artists: r.artists.size,
            })),
            trendBucket: null,
            trendKeys: [],
        };
    }

    const aggs = sortedAggs(aggregatorFor(kind)(plays), byHours ? "ms" : "plays").filter((a) => a.plays >= min);
    const rows = aggs.map(rowOf);

    let trendBucket: Bucket | null = null;
    let trendKeys: string[] = [];
    if (o.trend !== false && plays.length) {
        trendBucket = autoBucket(plays);
        const allKeys = denseBuckets(plays, ctx.tz, trendBucket);
        trendKeys = downsampleKeys(allKeys, 24);
        const keyOf = keyFor(kind);
        const wanted = new Set(rows.slice(0, ctx.top).map((r) => r.key));
        const series = seriesByKey(
            plays.filter((p) => wanted.has(keyOf(p))),
            keyOf,
            ctx.tz,
            trendBucket
        );

        for (const row of rows.slice(0, ctx.top)) {
            const m = series.get(row.key);
            row.trend = m ? downsample(dense(m, allKeys), 24) : [];
        }
    }

    return {
        head: head(ctx),
        kind,
        metric: byHours ? "hours" : "plays",
        minPlays: min,
        limit: ctx.top,
        totals: { plays: plays.length, ms: totalMs, distinct: aggs.length },
        genresMissing: ctx.genres.empty,
        coverage: { taggedPlays: 0, untaggedPlays: 0 },
        rows,
        genres: [],
        trendBucket,
        trendKeys,
    };
}
