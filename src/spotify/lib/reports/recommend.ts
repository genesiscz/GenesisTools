/**
 * Discover: artists and albums you will probably like, worked out from your own plays and Liked
 * Songs. Nothing here calls Spotify, so a pick is always an ARTIST (or an album you already
 * touched), with the songs that triggered it as evidence. No local source knows an artist's full
 * catalogue, so this never claims "song X you have not heard".
 *
 * Each method is a pure function over one `ArtistIndex`, so tests feed fixtures and the report
 * only wires the profile in.
 */
import { type ArtistCatalog, type CatalogArtist, type CatalogRelease, loadCatalog } from "@app/spotify/lib/catalog";
import { type CommonOpts, context, head, minMsOf, numberOption, type ReportHead } from "@app/spotify/lib/context";
import { type Play, songKey } from "@app/spotify/lib/history";
import { type LibTrack, loadLibrary } from "@app/spotify/lib/library";
import { sessionize } from "@app/spotify/lib/stats";

const DAY_MS = 86_400_000;
const MONTH_MS = 30 * DAY_MS;

export const RECOMMEND_METHODS = [
    {
        id: "bursts",
        title: "Discovery bursts",
        description:
            "Artists you liked 2 or more songs of within a couple of weeks, right after you first heard them. A burst like that usually means the rest of their music fits you too, so the less of it you explored afterwards, the higher they rank.",
        needsLibrary: true,
    },
    {
        id: "unfinished",
        title: "Unfinished artists",
        description:
            "Artists you replay hard and rarely skip, but only know a few songs of. You already love what you know; the rest of the catalogue is the obvious next step.",
        needsLibrary: false,
    },
    {
        id: "old-loves",
        title: "Old loves",
        description:
            "Artists that once filled a big part of a year and then went quiet. Their newer albums, or the ones you never got to, are a safe bet.",
        needsLibrary: false,
    },
    {
        id: "neighbours",
        title: "Session neighbours",
        description:
            "Artists that keep turning up in the same listening sessions as your current favourites, but that you rarely play on their own. Your own playlists already vouch for them.",
        needsLibrary: false,
    },
] as const;

export type RecommendMethod = (typeof RECOMMEND_METHODS)[number]["id"];
export type RecommendMethodInfo = (typeof RECOMMEND_METHODS)[number];

export function isRecommendMethod(value: string | undefined): value is RecommendMethod {
    return RECOMMEND_METHODS.some((m) => m.id === value);
}

export interface Evidence {
    song: string;
    detail: string;
}

export interface AlbumPick {
    name: string;
    /** Spotify URI when a liked song came from it; history alone only knows the album's name. */
    uri: string | null;
    likedSongs: number;
}

/** A song from the artist's own Spotify page that you have never played or liked. */
export interface SongToTry {
    name: string;
    uri: string;
    /** Global stream count. */
    playcount: number | null;
    cover: string | null;
}

export interface Recommendation {
    artist: string;
    /** `spotify:artist:…` when the artist appears in Liked Songs. */
    artistUri: string | null;
    score: number;
    reason: string;
    evidence: Evidence[];
    albums: AlbumPick[];
    plays: number;
    songsHeard: number;
    likedSongs: number;
    lastPlayed: string | null;
    /** Filled from the artist catalogue (`harvest --artists --auto`); empty until it is harvested. */
    songsToTry: SongToTry[];
    popularReleases: CatalogRelease[];
    /** Whether the catalogue has this artist at all, so "nothing new" and "not fetched" differ. */
    inCatalog: boolean;
}

// ---------------------------------------------------------------------------
// One index over plays and liked songs, keyed by lower-cased artist name. The history export
// names an artist; the library adds the URI, the albums and the date each song was liked.
// ---------------------------------------------------------------------------

export interface ArtistStats {
    key: string;
    name: string;
    uri: string | null;
    plays: Play[];
    /** Short plays plus counted plays flagged as skipped: each event once, for the skip rate. */
    skips: number;
    /** Plays under the counting threshold; with `plays` they are every event of the artist. */
    shortPlays: number;
    /** Lower-cased titles of every counted play in the WHOLE history, not just the window. */
    heard: Set<string>;
    first: number | null;
    last: number | null;
    liked: { name: string; addedAt: number | null; album: { name: string; uri: string } | null }[];
}

export interface ArtistIndex {
    artists: Map<string, ArtistStats>;
    /** The newest counted play: "now" for every "how long ago" question, so fixtures are stable. */
    now: number;
}

function stats(index: Map<string, ArtistStats>, name: string): ArtistStats {
    const key = name.toLowerCase();
    let s = index.get(key);
    if (!s) {
        s = {
            key,
            name,
            uri: null,
            plays: [],
            skips: 0,
            shortPlays: 0,
            heard: new Set(),
            first: null,
            last: null,
            liked: [],
        };
        index.set(key, s);
    }

    return s;
}

export interface ArtistIndexInput {
    /** The plays the methods rank from: the report's filtered window. */
    plays: Play[];
    library: LibTrack[];
    /** A play counts from this many milliseconds; shorter ones only feed the skip rate. */
    minMs: number;
    /**
     * The whole history, for "when did you first hear this artist". Defaults to `plays`; a
     * report passes the unfiltered list so a date window cannot make an old artist look new.
     */
    history?: Play[];
}

export function buildArtistIndex({ plays, library, minMs, history }: ArtistIndexInput): ArtistIndex {
    const artists = new Map<string, ArtistStats>();
    let now = 0;

    for (const p of plays) {
        if (!p.artist) {
            continue;
        }

        const s = stats(artists, p.artist);
        if (p.ms < minMs) {
            s.shortPlays++;
            s.skips++;
            continue;
        }

        if (p.skipped) {
            s.skips++;
        }

        s.plays.push(p);
        s.heard.add(p.name.toLowerCase());
        s.first = s.first === null ? p.ts : Math.min(s.first, p.ts);
        s.last = s.last === null ? p.ts : Math.max(s.last, p.ts);
        now = Math.max(now, p.ts);
    }

    for (const t of library) {
        const primary = t.artists[0];
        if (!primary) {
            continue;
        }

        const s = stats(artists, primary.name);
        s.uri = s.uri ?? primary.uri;
        const addedAt = t.addedAt ? Date.parse(t.addedAt) : null;
        s.liked.push({
            name: t.name,
            addedAt: Number.isFinite(addedAt) ? addedAt : null,
            album: t.album ? { name: t.album.name, uri: t.album.uri } : null,
        });
        if (addedAt && Number.isFinite(addedAt)) {
            now = Math.max(now, addedAt);
        }
    }

    for (const p of history ?? []) {
        const s = p.ms >= minMs ? artists.get(p.artist.toLowerCase()) : undefined;
        if (s) {
            s.first = s.first === null ? p.ts : Math.min(s.first, p.ts);
            s.heard.add(p.name.toLowerCase());
        }
    }

    return { artists, now: now || Date.now() };
}

const isoDay = (ts: number | null) => (ts === null ? null : new Date(ts).toISOString().slice(0, 10));
const monthYear = (ts: number) => new Date(ts).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

function songsHeard(s: ArtistStats, after = Number.NEGATIVE_INFINITY): number {
    return new Set(s.plays.filter((p) => p.ts > after).map(songKey)).size;
}

/** Albums of the artist's liked songs first (they carry URIs), then the most played albums. */
function albumsOf(s: ArtistStats, limit = 4): AlbumPick[] {
    const picks = new Map<string, AlbumPick>();
    for (const l of s.liked) {
        if (!l.album) {
            continue;
        }

        const key = l.album.name.toLowerCase();
        const pick = picks.get(key) ?? { name: l.album.name, uri: l.album.uri, likedSongs: 0 };
        pick.likedSongs++;
        picks.set(key, pick);
    }

    const byPlays = new Map<string, number>();
    for (const p of s.plays) {
        if (p.album) {
            byPlays.set(p.album, (byPlays.get(p.album) ?? 0) + 1);
        }
    }

    for (const [name] of [...byPlays].sort((a, b) => b[1] - a[1])) {
        if (!picks.has(name.toLowerCase())) {
            picks.set(name.toLowerCase(), { name, uri: null, likedSongs: 0 });
        }
    }

    return [...picks.values()].sort((a, b) => b.likedSongs - a.likedSongs).slice(0, limit);
}

function topSongs(plays: Play[], limit: number): Evidence[] {
    const counts = new Map<string, { name: string; n: number }>();
    for (const p of plays) {
        const k = songKey(p);
        const c = counts.get(k) ?? { name: p.name, n: 0 };
        c.n++;
        counts.set(k, c);
    }

    return [...counts.values()]
        .sort((a, b) => b.n - a.n)
        .slice(0, limit)
        .map((c) => ({ song: c.name, detail: `${c.n} plays` }));
}

function base(s: ArtistStats): Omit<Recommendation, "score" | "reason" | "evidence"> {
    return {
        artist: s.name,
        artistUri: s.uri,
        albums: albumsOf(s),
        plays: s.plays.length,
        songsHeard: songsHeard(s),
        likedSongs: s.liked.length,
        lastPlayed: isoDay(s.last),
        songsToTry: [],
        popularReleases: [],
        inCatalog: false,
    };
}

/** The artist's top songs minus everything you played (30 s or more) or liked, by song title. */
export function songsToTry(s: ArtistStats, entry: CatalogArtist, limit = 5): SongToTry[] {
    const known = new Set([...s.heard, ...s.liked.map((l) => l.name.toLowerCase())]);

    return entry.topTracks
        .filter((t) => !known.has(t.name.toLowerCase()))
        .slice(0, limit)
        .map((t) => ({ name: t.name, uri: t.uri, playcount: t.playcount, cover: t.cover }));
}

/** Adds the catalogue's songs and releases to each pick that has an artist URI on file. */
export function withCatalog(recs: Recommendation[], index: ArtistIndex, catalog: ArtistCatalog): Recommendation[] {
    return recs.map((rec) => {
        const entry = rec.artistUri ? catalog.artists[rec.artistUri] : undefined;
        const s = index.artists.get(rec.artist.toLowerCase());
        if (!entry || !s) {
            return rec;
        }

        return {
            ...rec,
            inCatalog: true,
            songsToTry: songsToTry(s, entry),
            popularReleases: entry.popularReleases.slice(0, 4),
        };
    });
}

// ---------------------------------------------------------------------------
// 1. Discovery bursts
// ---------------------------------------------------------------------------

export interface BurstOptions {
    /** Likes this close together form one burst. */
    windowDays: number;
    /** A burst needs at least this many liked songs. */
    minLikes: number;
    /** "New to you": no counted play more than this many days before the burst started. */
    newWithinDays: number;
}

export function recommendBursts(index: ArtistIndex, o: BurstOptions): Recommendation[] {
    const out: Recommendation[] = [];
    const windowMs = o.windowDays * DAY_MS;

    for (const s of index.artists.values()) {
        const dated = s.liked.filter((l) => l.addedAt !== null).sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
        if (dated.length < o.minLikes) {
            continue;
        }

        // The first burst: the earliest like that has enough company within the window.
        let burst: typeof dated | null = null;
        for (const [i, start] of dated.entries()) {
            const inWindow = dated.slice(i).filter((l) => (l.addedAt ?? 0) - (start.addedAt ?? 0) <= windowMs);
            if (inWindow.length >= o.minLikes) {
                burst = inWindow;
                break;
            }
        }

        if (!burst) {
            continue;
        }

        const burstStart = burst[0]?.addedAt ?? 0;
        const burstEnd = burst[burst.length - 1]?.addedAt ?? burstStart;
        if (s.first !== null && s.first < burstStart - o.newWithinDays * DAY_MS) {
            continue;
        }

        const burstSongs = new Set(burst.map((l) => l.name.toLowerCase()));
        const exploredAfter = new Set(
            s.plays.filter((p) => p.ts > burstEnd && !burstSongs.has(p.name.toLowerCase())).map(songKey)
        ).size;
        const likedAfter = s.liked.filter((l) => (l.addedAt ?? 0) > burstEnd).length;
        const score = Math.round((burst.length * 100) / (1 + exploredAfter / 4 + likedAfter / 2));
        const days = Math.max(1, Math.round((burstEnd - burstStart) / DAY_MS));

        const when =
            `You liked ${burst.length} songs by ${s.name} within ${days} ${days === 1 ? "day" : "days"} ` +
            `in ${monthYear(burstStart)}`;
        out.push({
            ...base(s),
            score,
            reason:
                (s.first === null
                    ? `${when}, but your history has no full play of them at all. `
                    : `${when}, right after you first heard them. `) +
                (exploredAfter === 0
                    ? "You have not played anything else by them since."
                    : `Since then you played only ${exploredAfter} other ${exploredAfter === 1 ? "song" : "songs"} by them.`),
            evidence: burst.map((l) => ({ song: l.name, detail: `liked ${isoDay(l.addedAt)}` })),
        });
    }

    return out.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// 2. Unfinished artists
// ---------------------------------------------------------------------------

export interface UnfinishedOptions {
    minPlays: number;
    maxSongs: number;
}

export function recommendUnfinished(index: ArtistIndex, o: UnfinishedOptions): Recommendation[] {
    const out: Recommendation[] = [];
    for (const s of index.artists.values()) {
        const songs = songsHeard(s);
        if (s.plays.length < o.minPlays || songs === 0 || songs > o.maxSongs) {
            continue;
        }

        const skipRate = s.skips / (s.plays.length + s.shortPlays);
        const perSong = s.plays.length / songs;
        out.push({
            ...base(s),
            score: Math.round(perSong * (1 - skipRate)),
            reason:
                `You played ${s.name} ${s.plays.length} times but only ${songs} different ${songs === 1 ? "song" : "songs"}, ` +
                `and you skip them ${Math.round(skipRate * 100)}% of the time. The rest of their music is the next step.`,
            evidence: topSongs(s.plays, 5),
        });
    }

    return out.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// 3. Old loves
// ---------------------------------------------------------------------------

export interface OldLovesOptions {
    minPlays: number;
    quietMonths: number;
}

export function recommendOldLoves(index: ArtistIndex, o: OldLovesOptions): Recommendation[] {
    const yearTotals = new Map<string, number>();
    for (const s of index.artists.values()) {
        for (const p of s.plays) {
            const y = new Date(p.ts).getUTCFullYear().toString();
            yearTotals.set(y, (yearTotals.get(y) ?? 0) + 1);
        }
    }

    const out: Recommendation[] = [];
    for (const s of index.artists.values()) {
        if (s.plays.length < o.minPlays || s.last === null) {
            continue;
        }

        const silentMonths = Math.floor((index.now - s.last) / MONTH_MS);
        if (silentMonths < o.quietMonths) {
            continue;
        }

        const byYear = new Map<string, number>();
        for (const p of s.plays) {
            const y = new Date(p.ts).getUTCFullYear().toString();
            byYear.set(y, (byYear.get(y) ?? 0) + 1);
        }

        const [peakYear, peakPlays] = [...byYear].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
        const share = peakPlays / (yearTotals.get(peakYear) ?? 1);
        out.push({
            ...base(s),
            score: Math.round(share * 1000 + s.plays.length / 10),
            reason:
                `In ${peakYear} you played ${s.name} ${peakPlays} times (${(share * 100).toFixed(1)}% of that year). ` +
                `You have not played them for ${silentMonths} months.`,
            evidence: topSongs(s.plays, 4),
        });
    }

    return out.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// 4. Session neighbours
// ---------------------------------------------------------------------------

export interface NeighboursOptions {
    /** Your favourites: the top artists of this many recent days. */
    recentDays: number;
    topArtists: number;
    /** Silence between plays that ends a session. */
    gapMinutes: number;
    /** Skip neighbours you already play this often on your own in the recent window. */
    maxRecentPlays: number;
}

export function recommendNeighbours(index: ArtistIndex, o: NeighboursOptions): Recommendation[] {
    const since = index.now - o.recentDays * DAY_MS;
    const recentPlays = (s: ArtistStats) => s.plays.filter((p) => p.ts >= since).length;
    const favourites = new Set(
        [...index.artists.values()]
            .map((s) => ({ key: s.key, n: recentPlays(s) }))
            .filter((x) => x.n > 0)
            .sort((a, b) => b.n - a.n)
            .slice(0, o.topArtists)
            .map((x) => x.key)
    );

    const all = [...index.artists.values()].flatMap((s) => s.plays);
    const together = new Map<string, { sessions: number; with: Map<string, number> }>();
    for (const session of sessionize(all, o.gapMinutes * 60_000)) {
        const keys = new Set(session.items.map((p) => p.artist.toLowerCase()));
        const favs = [...keys].filter((k) => favourites.has(k));
        if (!favs.length) {
            continue;
        }

        for (const k of keys) {
            if (favourites.has(k)) {
                continue;
            }

            const t = together.get(k) ?? { sessions: 0, with: new Map<string, number>() };
            t.sessions++;
            for (const f of favs) {
                t.with.set(f, (t.with.get(f) ?? 0) + 1);
            }

            together.set(k, t);
        }
    }

    const out: Recommendation[] = [];
    for (const [key, t] of together) {
        const s = index.artists.get(key);
        if (!s || t.sessions < 3 || recentPlays(s) > o.maxRecentPlays) {
            continue;
        }

        const partners = [...t.with].sort((a, b) => b[1] - a[1]).slice(0, 3);
        const names = partners.map(([k]) => index.artists.get(k)?.name ?? k);
        out.push({
            ...base(s),
            score: t.sessions * 10 + t.with.size,
            reason:
                `${s.name} came up in ${t.sessions} of your sessions together with ${names.join(", ")}, ` +
                `but you played them only ${recentPlays(s)} times in the last ${o.recentDays} days.`,
            evidence: partners.map(([k, n]) => ({
                song: index.artists.get(k)?.name ?? k,
                detail: `together in ${n} ${n === 1 ? "session" : "sessions"}`,
            })),
        });
    }

    return out.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface RecommendOpts extends CommonOpts {
    method?: string;
    window?: string;
    min?: string;
    quietMonths?: string;
    gap?: string;
}

export interface RecommendReport {
    head: ReportHead;
    method: RecommendMethodInfo;
    methods: readonly RecommendMethodInfo[];
    /** The knobs this run used, for the "how was this picked" line. */
    settings: { label: string; value: string }[];
    /** The method needs Liked Songs and this profile has no harvested library. */
    missingLibrary: boolean;
    /** The whole ranking (`--json` promises every row); `limit` is how many a table shows. */
    recommendations: Recommendation[];
    limit: number;
    /** How many of the first `limit` picks the artist catalogue covers, and how many artists it holds. */
    catalog: { artists: number; covered: number };
}

export function recommendReport(o: RecommendOpts): RecommendReport {
    const id: RecommendMethod = isRecommendMethod(o.method) ? o.method : "bursts";
    const method = RECOMMEND_METHODS.find((m) => m.id === id) ?? RECOMMEND_METHODS[0];
    const ctx = context(o);
    const minMs = minMsOf(o);
    // A filter that narrows plays (artist, genre, platform) must narrow the likes too, or a
    // genre-filtered run would still rank liked artists from every other genre.
    const narrowed = Boolean(o.artist || o.genre || o.platform);
    const played = new Set(ctx.plays.map((p) => p.artist.toLowerCase()));
    const library = loadLibrary(ctx.profile).filter(
        (t) => !narrowed || played.has(t.artists[0]?.name.toLowerCase() ?? "")
    );
    const index = buildArtistIndex({ plays: ctx.plays, library, minMs, history: ctx.all });
    const top = ctx.top;

    const catalog = loadCatalog();
    const catalogSize = Object.keys(catalog.artists).length;

    if (method.needsLibrary && library.length === 0) {
        return {
            head: head(ctx),
            method,
            methods: RECOMMEND_METHODS,
            settings: [],
            missingLibrary: true,
            recommendations: [],
            limit: top,
            catalog: { artists: catalogSize, covered: 0 },
        };
    }

    let settings: { label: string; value: string }[];
    let recommendations: Recommendation[];
    if (id === "bursts") {
        const opts = {
            windowDays: numberOption(o.window, "window", 14),
            minLikes: numberOption(o.min, "min", 2),
            newWithinDays: 30,
        };
        settings = [
            { label: "Burst window", value: `${opts.windowDays} days` },
            { label: "Liked songs in a burst", value: `${opts.minLikes} or more` },
            { label: "New to you", value: `no play more than ${opts.newWithinDays} days before` },
        ];
        recommendations = recommendBursts(index, opts);
    } else if (id === "unfinished") {
        const opts = { minPlays: numberOption(o.min, "min", 40), maxSongs: 5 };
        settings = [
            { label: "Plays at least", value: String(opts.minPlays) },
            { label: "Songs known at most", value: String(opts.maxSongs) },
        ];
        recommendations = recommendUnfinished(index, opts);
    } else if (id === "old-loves") {
        const opts = {
            minPlays: numberOption(o.min, "min", 50),
            quietMonths: numberOption(o.quietMonths, "quiet-months", 12),
        };
        settings = [
            { label: "Plays at least", value: String(opts.minPlays) },
            { label: "Silent for at least", value: `${opts.quietMonths} months` },
        ];
        recommendations = recommendOldLoves(index, opts);
    } else {
        const opts = {
            recentDays: 180,
            topArtists: 25,
            gapMinutes: numberOption(o.gap, "gap", 30),
            maxRecentPlays: 5,
        };
        settings = [
            { label: "Favourites", value: `your top ${opts.topArtists} artists of the last ${opts.recentDays} days` },
            { label: "Session gap", value: `${opts.gapMinutes} minutes` },
        ];
        recommendations = recommendNeighbours(index, opts);
    }

    const ranked = withCatalog(recommendations, index, catalog);

    return {
        head: head(ctx),
        method,
        methods: RECOMMEND_METHODS,
        settings,
        missingLibrary: false,
        recommendations: ranked,
        limit: top,
        catalog: { artists: catalogSize, covered: ranked.slice(0, top).filter((r) => r.inCatalog).length },
    };
}

/** Artist URIs the given methods would show, most promising first: what `harvest --artists` fetches. */
export function catalogCandidates(o: RecommendOpts & { methods: RecommendMethod[]; perMethod: number }): string[] {
    const uris: string[] = [];
    for (const method of o.methods) {
        const report = recommendReport({ ...o, method, top: String(o.perMethod) });
        for (const rec of report.recommendations.slice(0, report.limit)) {
            if (rec.artistUri && !uris.includes(rec.artistUri)) {
                uris.push(rec.artistUri);
            }
        }
    }

    return uris;
}
