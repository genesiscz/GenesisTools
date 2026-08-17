/**
 * Two composite views.
 *
 * `dna` reduces a listening life to eight axes, each a ratio in [0,1] so they can sit on one
 * screen without units fighting each other.
 *
 * `shift` runs the compatibility machinery against the same person in two different periods.
 * Comparing someone to their past self is the same computation as comparing two people, and
 * it answers the question people actually mean by "has my taste changed".
 */
import {
    type CommonOpts,
    type Ctx,
    context,
    dateOption,
    head,
    minMsOf,
    numberOption,
    type ReportHead,
    yearOption,
} from "@app/spotify/lib/context";
import {
    applyFilter,
    byArtist,
    bySong,
    counted,
    localTime,
    PLAY_MS,
    type Play,
    songKey,
    sortedAggs,
} from "@app/spotify/lib/history";
import { globalPlaycounts } from "@app/spotify/lib/library";
import {
    blendScore,
    type CompatComponent,
    cosine,
    gini,
    jaccard,
    normalize,
    normalizedEntropy,
    overlapCoefficient,
    quantile,
    TASTE_WEIGHTS,
    TOP_ARTIST_N,
    topKeys,
    type Vector,
    weightedJaccard,
} from "@app/spotify/lib/stats";

const YEAR_MS = 365 * 86400000;

export interface DnaAxis {
    axis: string;
    value: number;
    detail: string;
    low: string;
    high: string;
}

export interface DnaReport {
    head: ReportHead;
    empty: boolean;
    plays: number;
    axes: DnaAxis[];
}

/**
 * Three play sets, because the axes ask three different questions of the same data. Passing
 * one set for all three is what made `--year 2025` report loyalty 0 and novelty ~1 for
 * everyone: inside a single year every artist is newly met and nobody has three years.
 */
interface AxesInput {
    /** The window, already past the 30s bar: the basis for every ranking axis. */
    plays: Play[];
    /** The same window WITHOUT that bar, for the axis that counts abandoned starts. */
    windowRaw: Play[];
    /** The entire record, for the axes that ask how long an artist has been around. */
    all: Play[];
    tz: string;
    /** uri to global stream count, from the harvested library. */
    global: Map<string, number>;
}

function axes({ plays, windowRaw, all, tz, global }: AxesInput): DnaAxis[] {
    const artists = byArtist(plays);
    const artistPlays = [...artists.values()].map((a) => a.plays);
    const now = plays[plays.length - 1]!.ts;

    const firstSeen = new Map<string, number>();
    for (const p of all) {
        const k = p.artist.toLowerCase();
        const prev = firstSeen.get(k);
        if (prev === undefined || p.ts < prev) {
            firstSeen.set(k, p.ts);
        }
    }

    const fresh = plays.filter((p) => now - (firstSeen.get(p.artist.toLowerCase()) ?? 0) < YEAR_MS).length;

    const yearsOf = new Map<string, Set<number>>();
    for (const p of all) {
        const k = p.artist.toLowerCase();
        const set = yearsOf.get(k) ?? new Set<number>();
        set.add(localTime(p.ts, tz).y);
        yearsOf.set(k, set);
    }

    const longTerm = plays.filter((p) => (yearsOf.get(p.artist.toLowerCase())?.size ?? 0) >= 3).length;
    const night = plays.filter((p) => localTime(p.ts, tz).hour < 5).length;

    const songs = sortedAggs(bySong(plays));
    const topSlice = Math.max(1, Math.round(songs.length * 0.01));
    const repeat = songs.slice(0, topSlice).reduce((s, a) => s + a.plays, 0) / plays.length;

    const counts = plays
        .map((p) => global.get(p.uri))
        .filter((x): x is number => typeof x === "number")
        .sort((a, b) => a - b);
    // Stream counts span six orders of magnitude, so obscurity is scored on a log scale
    // anchored at 1k (utterly unknown) and 1B (a global hit).
    const medianGlobal = counts.length ? quantile(counts, 0.5) : 0;
    const obscurity = counts.length
        ? Math.min(1, Math.max(0, 1 - (Math.log10(Math.max(1000, medianGlobal)) - 3) / 6))
        : 0;

    return [
        {
            axis: "diversity",
            value: normalizedEntropy(artistPlays),
            detail: `${artists.size.toLocaleString("en-US")} artists`,
            low: "a few on repeat",
            high: "spread wide",
        },
        {
            axis: "concentration",
            value: gini(artistPlays),
            detail: "Gini over artist plays",
            low: "even",
            high: "top-heavy",
        },
        {
            axis: "novelty",
            value: fresh / plays.length,
            detail: "plays from artists met in the last year",
            low: "settled",
            high: "always hunting",
        },
        {
            axis: "obscurity",
            value: obscurity,
            detail: counts.length
                ? `median ${Math.round(medianGlobal).toLocaleString("en-US")} global streams`
                : "no library joined",
            low: "chart",
            high: "underground",
        },
        {
            axis: "loyalty",
            value: longTerm / plays.length,
            detail: "plays from artists kept 3+ years",
            low: "passing phases",
            high: "long companions",
        },
        {
            axis: "nocturnality",
            value: night / plays.length,
            detail: "plays before 05:00",
            low: "daylight",
            high: "night shift",
        },
        {
            axis: "restlessness",
            value:
                windowRaw.filter((p) => p.ms < PLAY_MS || p.reasonEnd === "fwdbtn").length /
                Math.max(1, windowRaw.length),
            detail: "starts abandoned",
            low: "sits through",
            high: "skips fast",
        },
        {
            axis: "repetition",
            value: repeat,
            detail: `top ${topSlice} songs' share of plays`,
            low: "wide rotation",
            high: "obsessive",
        },
    ];
}

export function dnaReport(o: CommonOpts, given?: Ctx): DnaReport {
    const ctx = given ?? context(o);
    const plays = counted(ctx.plays, minMsOf(o));
    if (!plays.length) {
        return { head: head(ctx), empty: true, plays: 0, axes: [] };
    }

    return {
        head: head(ctx),
        empty: false,
        plays: plays.length,
        axes: axes({
            plays,
            windowRaw: ctx.plays,
            all: ctx.all,
            tz: ctx.tz,
            global: globalPlaycounts(ctx.profile),
        }),
    };
}

interface Taste {
    artists: Vector;
    genres: Vector;
    songSet: Set<string>;
    raw: Vector;
}

function tasteOf(plays: Play[], genresOf: (p: Play) => string[]): Taste {
    const artists: Vector = new Map();
    const genres: Vector = new Map();
    const songSet = new Set<string>();
    for (const p of plays) {
        const a = p.artist.toLowerCase();
        artists.set(a, (artists.get(a) ?? 0) + 1);
        songSet.add(songKey(p));
        for (const g of genresOf(p)) {
            genres.set(g, (genres.get(g) ?? 0) + 1);
        }
    }

    return { artists: normalize(artists), genres: normalize(genres), songSet, raw: artists };
}

export interface ShiftReport {
    head: ReportHead;
    from: string;
    to: string;
    plays: { from: number; to: number };
    artists: { from: number; to: number };
    continuity: number;
    change: number;
    components: { name: string; score: number; weight: number }[];
    droppedArtists: { artist: string; plays: number }[];
    gainedArtists: { artist: string; plays: number }[];
    genreShifts: { genre: string; from: number; to: number; delta: number }[];
}

/**
 * A period is either a bare year (`2025`) or an explicit `YYYY-MM-DD:YYYY-MM-DD` range.
 *
 * Validated like every other window in the tool, and for the same reason: the filter compares
 * date strings, so `2025-13-01:2025-12-31` or `202x` would otherwise come back as an empty
 * period and be reported as a real one.
 *
 * The other shared options (`--artist`, `--genre`, `--platform`, `--min-ms`, `--all-plays`,
 * `--exclude-incognito`) are already applied by `context()`, so this only narrows the window.
 */
/**
 * `tz` and `spec` are both strings and sat next to each other positionally, so transposing
 * them type-checked and silently compared the wrong period. Named fields make that a
 * compile error instead of a wrong answer.
 */
interface WindowOfInput {
    all: Play[];
    tz: string;
    /** A year (`2019`) or a range (`2019-01-01:2019-12-31`). */
    spec: string;
    minMs: number;
}

function windowOf({ all, tz, spec, minMs }: WindowOfInput): Play[] {
    if (!spec.includes(":")) {
        return applyFilter(all, tz, { year: yearOption(spec, "period"), minMs });
    }

    const [from, to] = spec.split(":");
    const since = dateOption(from, "period start");
    const until = dateOption(to, "period end");
    if (since && until && since > until) {
        throw new Error(`period ${spec} starts after it ends`);
    }

    return applyFilter(all, tz, { since, until, minMs });
}

export function shiftReport(from: string, to: string, o: CommonOpts & { min?: string }, given?: Ctx): ShiftReport {
    // Through `context()` like every other report: it used to load the profile and filter by
    // hand, so `--artist`, `--genre`, `--platform`, `--min-ms` and `--exclude-incognito` were
    // accepted on both doors and then silently ignored here. `shift` supplies its own two
    // windows, so the context is built without one.
    const ctx = given ?? context({ ...o, year: undefined, since: undefined, until: undefined });
    const tz = ctx.tz;
    const genresOf = (p: Play) => ctx.genres.forPlay(p.uri, p.artist);
    const all = ctx.plays;
    const minMs = minMsOf(o);
    const min = numberOption(o.min, "min", 10);

    const A = windowOf({ all, tz, spec: from, minMs });
    const B = windowOf({ all, tz, spec: to, minMs });
    if (!A.length || !B.length) {
        throw new Error(`no plays in ${!A.length ? from : to}. Use a year, or "YYYY-MM-DD:YYYY-MM-DD".`);
    }

    const ta = tasteOf(A, genresOf);
    const tb = tasteOf(B, genresOf);
    const topA = topKeys(ta.artists, TOP_ARTIST_N);
    const topB = topKeys(tb.artists, TOP_ARTIST_N);

    // The same four components and the same weighting `compat` uses, from one definition. What
    // differs on purpose is what is being compared: two windows of one person here, two people
    // there, so each builds its own vectors.
    const comps: CompatComponent[] = [
        { name: "genre profile", score: cosine(ta.genres, tb.genres), weight: TASTE_WEIGHTS.genres, detail: "" },
        {
            name: "artist overlap",
            score: weightedJaccard(ta.artists, tb.artists),
            weight: TASTE_WEIGHTS.artists,
            detail: "",
        },
        {
            name: `shared top ${TOP_ARTIST_N}`,
            score: overlapCoefficient(topA, topB),
            weight: TASTE_WEIGHTS.topArtists,
            detail: "",
        },
        { name: "exact songs", score: jaccard(ta.songSet, tb.songSet), weight: TASTE_WEIGHTS.songs, detail: "" },
    ];
    const continuity = blendScore(comps);

    const labels = new Map<string, string>();
    for (const p of [...A, ...B]) {
        const k = p.artist.toLowerCase();
        if (!labels.has(k)) {
            labels.set(k, p.artist);
        }
    }

    const dropped = [...ta.raw.entries()].filter(([k, n]) => n >= min && !tb.raw.has(k)).sort((x, y) => y[1] - x[1]);
    const gained = [...tb.raw.entries()].filter(([k, n]) => n >= min && !ta.raw.has(k)).sort((x, y) => y[1] - x[1]);

    const genreDelta = [...new Set([...ta.genres.keys(), ...tb.genres.keys()])]
        .map((g) => ({ genre: g, a: ta.genres.get(g) ?? 0, b: tb.genres.get(g) ?? 0 }))
        .map((g) => ({ ...g, delta: g.b - g.a }))
        .filter((g) => Math.abs(g.delta) > 0.002)
        .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

    return {
        head: {
            profile: ctx.profile.name,
            label: ctx.profile.label || ctx.profile.name,
            window: `${from} → ${to}`,
            timezone: tz,
        },
        from,
        to,
        plays: { from: A.length, to: B.length },
        artists: { from: ta.raw.size, to: tb.raw.size },
        continuity,
        change: 1 - continuity,
        components: comps.map((x) => ({ name: x.name, score: x.score, weight: x.weight })),
        droppedArtists: dropped.map(([k, n]) => ({ artist: labels.get(k) ?? k, plays: n })),
        gainedArtists: gained.map(([k, n]) => ({ artist: labels.get(k) ?? k, plays: n })),
        genreShifts: genreDelta.map((g) => ({ genre: g.genre, from: g.a, to: g.b, delta: g.delta })),
    };
}
