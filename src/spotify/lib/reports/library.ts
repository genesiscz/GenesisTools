/**
 * Where the two data sources meet: personal plays from the export, global stream counts
 * from the browser harvest.
 *
 * Holding both makes questions possible that neither answers alone — how obscure your
 * favourites are, which liked tracks you never actually play, which songs you play
 * constantly without ever saving.
 *
 * `plays` is always personal and `playcount` is always the track's worldwide total. Only
 * `gems` and `mainstream` mix them, and both label each side.
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
import { bucketOf, counted, localTime, songKey, songKeyOf } from "@app/spotify/lib/history";
import { loadLibrary, requireLibrary } from "@app/spotify/lib/library";
import { quantile, spearman } from "@app/spotify/lib/stats";

export interface AuditReport {
    head: ReportHead;
    library: number;
    likedAndPlayed: number;
    neverPlayed: number;
    neverPlayedButOtherRelease: number;
    duplicateSaves: number;
    /** Songs played but never saved, most played first. */
    topUnliked: { track: string; artist: string; plays: number }[];
    /** Liked tracks with no play of any release, newest save first is NOT applied. */
    sampleNeverPlayed: { track: string; artist: string; addedAt: string | null }[];
    duplicates: { song: string; copies: number }[];
}

export function auditReport(o: CommonOpts, given?: Ctx): AuditReport {
    const ctx = given ?? context(o);
    const lib = requireLibrary(ctx.profile);
    const plays = counted(ctx.plays, minMsOf(o));

    const playsByUri = new Map<string, number>();
    const playsBySong = new Map<string, { name: string; artist: string; plays: number }>();
    for (const p of plays) {
        playsByUri.set(p.uri, (playsByUri.get(p.uri) ?? 0) + 1);
        const k = songKey(p);
        const r = playsBySong.get(k) ?? { name: p.name, artist: p.artist, plays: 0 };
        r.plays++;
        playsBySong.set(k, r);
    }

    const likedUris = new Set(lib.map((t) => t.uri));
    const libSongKey = (t: (typeof lib)[number]) => songKeyOf(t.name, t.artists[0]?.name ?? "");
    const likedSongs = new Set(lib.map(libSongKey));

    const neverPlayed = lib
        .filter((t) => !playsByUri.has(t.uri))
        .map((t) => ({
            track: t.name,
            artist: t.artists[0]?.name ?? "",
            addedAt: t.addedAt,
            otherRelease: playsBySong.has(libSongKey(t)),
        }));
    const trulyNever = neverPlayed.filter((t) => !t.otherRelease);

    const unliked = [...playsBySong.entries()]
        .filter(([k]) => !likedSongs.has(k))
        .map(([, v]) => ({ track: v.name, artist: v.artist, plays: v.plays }))
        .sort((a, b) => b.plays - a.plays);

    // Grouped by the song key, displayed by the label: the key is NUL-separated and is not a
    // display string.
    const dupes = new Map<string, { label: string; copies: number }>();
    for (const t of lib) {
        const k = libSongKey(t);
        const row = dupes.get(k) ?? { label: `${t.name} · ${t.artists[0]?.name ?? ""}`, copies: 0 };
        row.copies++;
        dupes.set(k, row);
    }

    const duplicated = [...dupes.values()]
        .filter((d) => d.copies > 1)
        .sort((a, b) => b.copies - a.copies)
        .map((d) => ({ song: d.label, copies: d.copies }));

    // Both sides of this subtraction must count the same thing. `lib` has duplicate rows (the
    // report says so two lines down), so counting played tracks off `lib.length` would
    // understate it and can go negative.
    const likedAndPlayed = [...likedUris].filter((uri) => playsByUri.has(uri)).length;

    return {
        head: head(ctx),
        library: lib.length,
        likedAndPlayed,
        neverPlayed: trulyNever.length,
        neverPlayedButOtherRelease: neverPlayed.length - trulyNever.length,
        duplicateSaves: duplicated.length,
        topUnliked: unliked,
        sampleNeverPlayed: trulyNever.map((t) => ({ track: t.track, artist: t.artist, addedAt: t.addedAt })),
        duplicates: duplicated,
    };
}

export interface GemRow {
    uri: string;
    track: string;
    artist: string;
    plays: number;
    playcount: number;
    ratio: number;
}

export interface GemsReport {
    head: ReportHead;
    minPlays: number;
    maxGlobal: number;
    gems: GemRow[];
}

export function gemsReport(o: CommonOpts & { min?: string; maxGlobal?: string }, given?: Ctx): GemsReport {
    const ctx = given ?? context(o);
    const lib = requireLibrary(ctx.profile);
    const plays = counted(ctx.plays, minMsOf(o));
    const min = numberOption(o.min, "min", 8);
    const maxGlobal = numberOption(o.maxGlobal, "max-global", 1_000_000);

    const global = new Map<string, { name: string; artist: string; playcount: number }>();
    for (const t of lib) {
        if (typeof t.playcount === "number" && t.playcount > 0) {
            global.set(t.uri, { name: t.name, artist: t.artists[0]?.name ?? "", playcount: t.playcount });
        }
    }

    const mine = new Map<string, number>();
    for (const p of plays) {
        mine.set(p.uri, (mine.get(p.uri) ?? 0) + 1);
    }

    const gems = [...mine.entries()]
        .map(([uri, n]) => {
            const g = global.get(uri);
            if (!g) {
                return null;
            }

            return { uri, track: g.name, artist: g.artist, plays: n, playcount: g.playcount, ratio: n / g.playcount };
        })
        .filter((r): r is GemRow => !!r && r.plays >= min && r.playcount <= maxGlobal)
        .sort((a, b) => b.ratio - a.ratio);

    return { head: head(ctx), minPlays: min, maxGlobal, gems };
}

export interface MainstreamReport {
    head: ReportHead;
    /** True when no play could be joined to a global stream count. */
    unjoinable: boolean;
    minPlays: number;
    joinedPlays: number;
    ofPlays: number;
    medianGlobal: number;
    quartiles: [number, number, number];
    underOneMillionShare: number;
    overHundredMillionShare: number;
    agreementWithWorld: number;
    byYear: { year: string; plays: number; medianGlobal: number }[];
    /** Every qualifying artist, most mainstream first. */
    artists: { artist: string; plays: number; avgGlobal: number }[];
}

export function mainstreamReport(o: CommonOpts & { min?: string }, given?: Ctx): MainstreamReport {
    const ctx = given ?? context(o);
    const lib = requireLibrary(ctx.profile);
    const plays = counted(ctx.plays, minMsOf(o));
    const min = numberOption(o.min, "min", 30);

    const global = new Map<string, number>();
    for (const t of lib) {
        if (typeof t.playcount === "number" && t.playcount > 0) {
            global.set(t.uri, t.playcount);
        }
    }

    const matched = plays.filter((p) => global.has(p.uri));
    if (!matched.length) {
        return {
            head: head(ctx),
            unjoinable: true,
            minPlays: min,
            joinedPlays: 0,
            ofPlays: plays.length,
            medianGlobal: 0,
            quartiles: [0, 0, 0],
            underOneMillionShare: 0,
            overHundredMillionShare: 0,
            agreementWithWorld: 0,
            byYear: [],
            artists: [],
        };
    }

    const counts = matched.map((p) => global.get(p.uri)!).sort((a, b) => a - b);
    const perYear = new Map<string, number[]>();
    for (const p of matched) {
        const y = String(localTime(p.ts, ctx.tz).y);
        const list = perYear.get(y) ?? [];
        list.push(global.get(p.uri)!);
        perYear.set(y, list);
    }

    const artistRows = new Map<string, { label: string; plays: number; total: number }>();
    for (const p of matched) {
        const k = p.artist.toLowerCase();
        const r = artistRows.get(k) ?? { label: p.artist, plays: 0, total: 0 };
        r.plays++;
        r.total += global.get(p.uri)!;
        artistRows.set(k, r);
    }

    const uris = [...new Set(matched.map((p) => p.uri))];
    const mineCount = new Map<string, number>();
    for (const p of matched) {
        mineCount.set(p.uri, (mineCount.get(p.uri) ?? 0) + 1);
    }

    const agreement = spearman(
        uris.map((u) => mineCount.get(u)!),
        uris.map((u) => global.get(u)!)
    );

    return {
        head: head(ctx),
        unjoinable: false,
        minPlays: min,
        joinedPlays: matched.length,
        ofPlays: plays.length,
        medianGlobal: quantile(counts, 0.5),
        quartiles: [quantile(counts, 0.25), quantile(counts, 0.5), quantile(counts, 0.75)],
        underOneMillionShare: counts.filter((x) => x < 1e6).length / counts.length,
        overHundredMillionShare: counts.filter((x) => x > 1e8).length / counts.length,
        agreementWithWorld: agreement,
        byYear: [...perYear.entries()].sort().map(([year, list]) => ({
            year,
            plays: list.length,
            medianGlobal: quantile(
                [...list].sort((a, b) => a - b),
                0.5
            ),
        })),
        artists: [...artistRows.values()]
            .filter((r) => r.plays >= min)
            .map((r) => ({ artist: r.label, plays: r.plays, avgGlobal: Math.round(r.total / r.plays) }))
            .sort((a, b) => b.avgGlobal - a.avgGlobal),
    };
}

export interface SavesReport {
    head: ReportHead;
    empty: boolean;
    total: number;
    byMonth: { month: string; saved: number }[];
    busiest: { month: string; saved: number } | null;
}

export function savesReport(o: CommonOpts, given?: Ctx): SavesReport {
    const ctx = given ?? context(o);
    const lib = loadLibrary(ctx.profile);
    if (!lib.length) {
        return { head: head(ctx), empty: true, total: 0, byMonth: [], busiest: null };
    }

    const perMonth = new Map<string, number>();
    for (const t of lib) {
        if (!t.addedAt) {
            continue;
        }

        // A malformed timestamp parses to NaN, and `bucketOf(NaN)` yields a key like
        // "NaN-NaN" that then sits in the chart and can win the busiest-month comparison.
        const addedAt = Date.parse(t.addedAt);
        if (Number.isNaN(addedAt)) {
            continue;
        }

        const key = bucketOf(addedAt, ctx.tz, "month");
        perMonth.set(key, (perMonth.get(key) ?? 0) + 1);
    }

    const byMonth = [...perMonth.entries()].sort().map(([month, saved]) => ({ month, saved }));
    const busiest = byMonth.reduce<{ month: string; saved: number } | null>(
        (best, row) => (!best || row.saved > best.saved ? row : best),
        null
    );

    return { head: head(ctx), empty: false, total: lib.length, byMonth, busiest };
}
