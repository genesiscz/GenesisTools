/**
 * Two people, one question: how much taste do they actually share?
 *
 * Four measurements, because one number lies. Two people can share almost no exact
 * recordings and still live in the same three genres, or overlap on a hundred chart hits
 * while agreeing on nothing else. Each component is reported next to the blend so the
 * shape of the agreement is visible, not just its size.
 *
 * Genres are a property of ARTISTS, so whichever profile has enrichment data lends its tags
 * to the other. A partner who only ever handed over a streaming-history export still gets a
 * genre profile, as long as their artists appear somewhere in the enriched library.
 */
import { type CommonOpts, minMsOf, numberOption, windowLabel, windowOptions } from "@app/spotify/lib/context";
import {
    applyFilter,
    type Bucket,
    bucketOf,
    loadAllPlays,
    type Play,
    parseBucket,
    songKey,
} from "@app/spotify/lib/history";
import { type GenreResolver, genreResolver, mergeResolvers } from "@app/spotify/lib/library";
import { DEFAULT_TIMEZONE, getProfile, type Profile } from "@app/spotify/lib/profiles";
import {
    blendScore,
    type CompatComponent,
    cosine,
    jaccard,
    normalize,
    overlapCoefficient,
    TASTE_WEIGHTS,
    TOP_ARTIST_N,
    topKeys,
    type Vector,
    weightedJaccard,
} from "@app/spotify/lib/stats";
import { maxOf } from "@genesiscz/utils/math";

export interface CompatOpts extends CommonOpts {
    timeline?: boolean;
    bucket?: string;
    minPlays?: string;
}

interface Taste {
    profile: Profile;
    plays: Play[];
    artists: Vector;
    songs: Vector;
    songSet: Set<string>;
    /** songKey to something a person can read; the key itself is not a display string. */
    songLabels: Map<string, string>;
    genres: Vector;
    ms: number;
}

function taste(profile: Profile, plays: Play[], genresOf: (p: Play) => string[]): Taste {
    const artists: Vector = new Map();
    const songs: Vector = new Map();
    const songLabels = new Map<string, string>();
    const genres: Vector = new Map();
    let ms = 0;
    for (const p of plays) {
        ms += p.ms;
        const a = p.artist.toLowerCase();
        artists.set(a, (artists.get(a) ?? 0) + 1);
        const s = songKey(p);
        songs.set(s, (songs.get(s) ?? 0) + 1);
        if (!songLabels.has(s)) {
            songLabels.set(s, `${p.name} · ${p.artist}`);
        }

        for (const g of genresOf(p)) {
            genres.set(g, (genres.get(g) ?? 0) + 1);
        }
    }

    return {
        profile,
        plays,
        ms,
        artists: normalize(artists),
        songs: normalize(songs),
        songSet: new Set(songs.keys()),
        songLabels,
        genres: normalize(genres),
    };
}

function intersect(a: Set<string>, b: Set<string>): string[] {
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];

    return [...small].filter((x) => big.has(x));
}

function components(a: Taste, b: Taste): CompatComponent[] {
    const topA = topKeys(a.artists, TOP_ARTIST_N);
    const topB = topKeys(b.artists, TOP_ARTIST_N);
    const sharedTop = [...topA].filter((x) => topB.has(x)).length;

    return [
        {
            name: "genre profile",
            score: cosine(a.genres, b.genres),
            weight: TASTE_WEIGHTS.genres,
            detail: `cosine over ${a.genres.size} vs ${b.genres.size} genres`,
        },
        {
            name: "artist overlap",
            score: weightedJaccard(a.artists, b.artists),
            weight: TASTE_WEIGHTS.artists,
            detail: "play-weighted, so listening amounts matter",
        },
        {
            name: `shared top ${TOP_ARTIST_N}`,
            score: overlapCoefficient(topA, topB),
            weight: TASTE_WEIGHTS.topArtists,
            detail: `${sharedTop} of ${TOP_ARTIST_N} favourite artists in common`,
        },
        {
            name: "exact songs",
            score: jaccard(a.songSet, b.songSet),
            weight: TASTE_WEIGHTS.songs,
            detail: `${intersect(a.songSet, b.songSet).length.toLocaleString("en-US")} songs both have played`,
        },
    ];
}

function loadTaste(name: string, o: CommonOpts, resolvers: GenreResolver[]): Taste {
    const profile = getProfile(name);
    const tz = o.tz ?? profile.timezone ?? DEFAULT_TIMEZONE;
    // The same validation `context()` applies, since these reports build their own filter: an
    // unparseable `--since` otherwise compares lexicographically and quietly selects nothing.
    const window = windowOptions(o);
    // Every option `common()` registers, not a subset: these reports advertise the same flags
    // as the rest of the tool, so accepting one and dropping it is the same defect whether it
    // is `--min-ms` or `--artist`. The genre filter needs the resolver, which is why it is
    // applied here rather than left to `applyFilter`'s own `genreOf`.
    const genresOf = mergeResolvers(resolvers);
    let plays = applyFilter(loadAllPlays(profile), tz, {
        since: window.since,
        until: window.until,
        year: window.year,
        artist: o.artist,
        platform: o.platform,
        minMs: minMsOf(o),
        excludeIncognito: o.excludeIncognito,
    });

    if (o.genre) {
        const want = o.genre.toLowerCase();
        plays = plays.filter((p) => genresOf(p).includes(want));
    }

    return taste(profile, plays, genresOf);
}

const labelOf = (t: Taste) => t.profile.label || t.profile.name;

export interface CompatSide {
    profile: string;
    label: string;
    plays: number;
    ms: number;
    hours: number;
    artists: number;
    songs: number;
}

export interface CompatReport {
    kind: "overall";
    window: string;
    a: CompatSide;
    b: CompatSide;
    /** True when one side has no plays in the window, so nothing can be compared. */
    emptySide: string | null;
    compatibility: number;
    components: { name: string; score: number; weight: number; detail: string }[];
    sharedSongs: number;
    sharedArtists: number;
    topShared: { artist: string; aShare: number; bShare: number }[];
    sharedSongRows: { song: string; aShare: number; bShare: number }[];
    onlyA: { artist: string; share: number }[];
    onlyB: { artist: string; share: number }[];
    genreProfile: { genre: string; a: number; b: number }[];
    verdict: string;
}

export interface CompatTimelinePoint {
    bucket: string;
    compatibility: number | null;
    aPlays: number;
    bPlays: number;
    components: { name: string; score: number }[];
}

export interface CompatTimelineReport {
    kind: "timeline";
    window: string;
    bucket: Bucket;
    minPlays: number;
    a: CompatSide;
    b: CompatSide;
    emptySide: string | null;
    points: CompatTimelinePoint[];
    average: number | null;
    closest: CompatTimelinePoint | null;
    furthest: CompatTimelinePoint | null;
}

function sideOf(t: Taste): CompatSide {
    return {
        profile: t.profile.name,
        label: labelOf(t),
        plays: t.plays.length,
        ms: t.ms,
        hours: +(t.ms / 3600000).toFixed(1),
        artists: t.artists.size,
        songs: t.songSet.size,
    };
}

export function verdict(score: number): string {
    if (score >= 0.6) {
        return "Practically one library with two accounts.";
    }

    // These name commands the reader is meant to run next, so they carry the `analytics`
    // group they actually live under. Without it every suggestion here is `unknown command`.
    if (score >= 0.4) {
        return "Strong overlap with room to surprise each other. Try `spotify analytics gift`.";
    }

    if (score >= 0.22) {
        return "A real shared core surrounded by two separate worlds. `spotify analytics blend` is the safe playlist.";
    }

    if (score >= 0.1) {
        return "Mostly separate taste with a handful of bridges. `spotify analytics blend` will be short.";
    }

    return "Different musical universes. `spotify analytics gift` is more useful than `blend` here.";
}

export function compatReport(aName: string, bName: string, o: CompatOpts): CompatReport {
    const resolvers = [genreResolver(getProfile(aName)), genreResolver(getProfile(bName))];
    const A = loadTaste(aName, o, resolvers);
    const B = loadTaste(bName, o, resolvers);
    const base = {
        kind: "overall" as const,
        window: windowLabel(o),
        a: sideOf(A),
        b: sideOf(B),
    };

    if (!A.plays.length || !B.plays.length) {
        return {
            ...base,
            emptySide: !A.plays.length ? labelOf(A) : labelOf(B),
            compatibility: 0,
            components: [],
            sharedSongs: 0,
            sharedArtists: 0,
            topShared: [],
            sharedSongRows: [],
            onlyA: [],
            onlyB: [],
            genreProfile: [],
            verdict: "",
        };
    }

    const comps = components(A, B);
    const score = blendScore(comps);
    const sharedSongs = intersect(A.songSet, B.songSet);
    const sharedArtists = [...A.artists.keys()].filter((k) => B.artists.has(k));

    const labelsA = new Map<string, string>();
    for (const p of A.plays) {
        const k = p.artist.toLowerCase();
        if (!labelsA.has(k)) {
            labelsA.set(k, p.artist);
        }
    }

    const labelsB = new Map<string, string>();
    for (const p of B.plays) {
        const k = p.artist.toLowerCase();
        if (!labelsB.has(k)) {
            labelsB.set(k, p.artist);
        }
    }

    const together = sharedArtists
        .map((k) => ({ artist: labelsA.get(k) ?? k, aShare: A.artists.get(k)!, bShare: B.artists.get(k)! }))
        .sort((x, y) => Math.min(y.aShare, y.bShare) - Math.min(x.aShare, x.bShare));

    return {
        ...base,
        emptySide: null,
        compatibility: score,
        components: comps.map((x) => ({
            name: x.name,
            score: x.score,
            weight: x.weight,
            detail: x.detail,
        })),
        sharedSongs: sharedSongs.length,
        sharedArtists: sharedArtists.length,
        topShared: together,
        sharedSongRows: sharedSongs
            .map((k) => ({
                song: A.songLabels.get(k) ?? B.songLabels.get(k) ?? k,
                aShare: A.songs.get(k)!,
                bShare: B.songs.get(k)!,
            }))
            .sort((x, y) => Math.min(y.aShare, y.bShare) - Math.min(x.aShare, x.bShare)),
        onlyA: [...A.artists.entries()]
            .filter(([k]) => !B.artists.has(k))
            .sort((x, y) => y[1] - x[1])
            .map(([k, share]) => ({ artist: labelsA.get(k) ?? k, share })),
        onlyB: [...B.artists.entries()]
            .filter(([k]) => !A.artists.has(k))
            .sort((x, y) => y[1] - x[1])
            .map(([k, share]) => ({ artist: labelsB.get(k) ?? k, share })),
        genreProfile: [...new Set([...A.genres.keys(), ...B.genres.keys()])]
            .map((g) => ({ genre: g, a: A.genres.get(g) ?? 0, b: B.genres.get(g) ?? 0 }))
            .sort((x, y) => y.a + y.b - (x.a + x.b)),
        verdict: verdict(score),
    };
}

export function compatTimelineReport(aName: string, bName: string, o: CompatOpts): CompatTimelineReport {
    const resolvers = [genreResolver(getProfile(aName)), genreResolver(getProfile(bName))];
    const A = loadTaste(aName, o, resolvers);
    const B = loadTaste(bName, o, resolvers);
    const bucket = parseBucket(o.bucket, "quarter");
    const minPlays = numberOption(o.minPlays, "min-plays", 40);
    const base = {
        kind: "timeline" as const,
        window: windowLabel(o),
        bucket,
        minPlays,
        a: sideOf(A),
        b: sideOf(B),
    };

    if (!A.plays.length || !B.plays.length) {
        return {
            ...base,
            emptySide: !A.plays.length ? labelOf(A) : labelOf(B),
            points: [],
            average: null,
            closest: null,
            furthest: null,
        };
    }

    const genresOf = mergeResolvers(resolvers);
    // Each side is bucketed in its OWN timezone unless `--tz` overrides both, the same rule the
    // window filter already used. Bucketing a partner in Prague by a New York clock moved their
    // plays across day and month boundaries, so the two sides of a boundary bucket were
    // measuring different spans of time and the score for it was meaningless.
    const group = (plays: Play[], profileTz: string | undefined) => {
        const tz = o.tz ?? profileTz ?? DEFAULT_TIMEZONE;
        const out = new Map<string, Play[]>();
        for (const p of plays) {
            const k = bucketOf(p.ts, tz, bucket);
            const list = out.get(k);
            if (list) {
                list.push(p);
            } else {
                out.set(k, [p]);
            }
        }

        return out;
    };

    const groupA = group(A.plays, A.profile.timezone);
    const groupB = group(B.plays, B.profile.timezone);
    const keys = [...new Set([...groupA.keys(), ...groupB.keys()])].sort();

    const points: CompatTimelinePoint[] = keys.map((k) => {
        const la = groupA.get(k) ?? [];
        const lb = groupB.get(k) ?? [];
        if (la.length < minPlays || lb.length < minPlays) {
            return { bucket: k, compatibility: null, aPlays: la.length, bPlays: lb.length, components: [] };
        }

        const comps = components(taste(A.profile, la, genresOf), taste(B.profile, lb, genresOf));

        return {
            bucket: k,
            compatibility: blendScore(comps),
            aPlays: la.length,
            bPlays: lb.length,
            components: comps.map((x) => ({ name: x.name, score: x.score })),
        };
    });

    const scored = points.filter((p) => p.compatibility !== null);

    return {
        ...base,
        emptySide: null,
        points,
        average: scored.length ? scored.reduce((s, p) => s + p.compatibility!, 0) / scored.length : null,
        closest: scored.length ? scored.reduce((x, y) => (y.compatibility! > x.compatibility! ? y : x)) : null,
        furthest: scored.length ? scored.reduce((x, y) => (y.compatibility! < x.compatibility! ? y : x)) : null,
    };
}

export interface BlendReport {
    window: string;
    a: CompatSide;
    b: CompatSide;
    minPlays: number;
    tracks: { song: string; aPlays: number; bPlays: number; score: number }[];
}

export function blendReport(aName: string, bName: string, o: CommonOpts & { min?: string }): BlendReport {
    const resolvers = [genreResolver(getProfile(aName)), genreResolver(getProfile(bName))];
    const A = loadTaste(aName, o, resolvers);
    const B = loadTaste(bName, o, resolvers);
    const min = numberOption(o.min, "min", 2);

    const countsA = new Map<string, number>();
    const countsB = new Map<string, number>();
    for (const p of A.plays) {
        countsA.set(songKey(p), (countsA.get(songKey(p)) ?? 0) + 1);
    }

    for (const p of B.plays) {
        countsB.set(songKey(p), (countsB.get(songKey(p)) ?? 0) + 1);
    }

    const maxA = maxOf(countsA.values(), 1);
    const maxB = maxOf(countsB.values(), 1);

    const tracks = intersect(new Set(countsA.keys()), new Set(countsB.keys()))
        .map((k) => {
            const na = countsA.get(k)!;
            const nb = countsB.get(k)!;
            const ra = na / maxA;
            const rb = nb / maxB;

            return {
                song: A.songLabels.get(k) ?? B.songLabels.get(k) ?? k,
                aPlays: na,
                bPlays: nb,
                score: (2 * ra * rb) / (ra + rb),
            };
        })
        .filter((r) => r.aPlays >= min && r.bPlays >= min)
        .sort((x, y) => y.score - x.score);

    return { window: windowLabel(o), a: sideOf(A), b: sideOf(B), minPlays: min, tracks };
}

export interface GiftReport {
    window: string;
    from: CompatSide;
    to: CompatSide;
    candidates: {
        track: string;
        artist: string;
        yourPlays: number;
        theirArtistAffinity: number;
        theirGenreAffinity: number;
        score: number;
    }[];
}

export function giftReport(fromName: string, toName: string, o: CommonOpts): GiftReport {
    const resolvers = [genreResolver(getProfile(fromName)), genreResolver(getProfile(toName))];
    const genresOf = mergeResolvers(resolvers);
    const F = loadTaste(fromName, o, resolvers);
    const T = loadTaste(toName, o, resolvers);

    const maxArtist = maxOf(T.artists.values(), 1e-9);
    const maxGenre = maxOf(T.genres.values(), 1e-9);

    const mine = new Map<string, { name: string; artist: string; plays: number; genres: string[] }>();
    for (const p of F.plays) {
        const k = songKey(p);
        const r = mine.get(k) ?? { name: p.name, artist: p.artist, plays: 0, genres: genresOf(p) };
        r.plays++;
        mine.set(k, r);
    }

    const maxMine = maxOf(
        [...mine.values()].map((r) => r.plays),
        1
    );

    const candidates = [...mine.entries()]
        .filter(([k]) => !T.songSet.has(k))
        .map(([, r]) => {
            const artistAffinity = (T.artists.get(r.artist.toLowerCase()) ?? 0) / maxArtist;
            const genreAffinity = r.genres.length
                ? r.genres.reduce((s, g) => s + (T.genres.get(g) ?? 0), 0) / (r.genres.length * maxGenre)
                : 0;
            const love = r.plays / maxMine;

            return {
                track: r.name,
                artist: r.artist,
                yourPlays: r.plays,
                theirArtistAffinity: artistAffinity,
                theirGenreAffinity: genreAffinity,
                score: love * (0.25 + 0.45 * Math.sqrt(artistAffinity) + 0.3 * Math.sqrt(genreAffinity)),
            };
        })
        .sort((x, y) => y.score - x.score);

    return { window: windowLabel(o), from: sideOf(F), to: sideOf(T), candidates };
}
