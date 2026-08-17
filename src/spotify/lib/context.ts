/**
 * Every report needs the same four things: a profile, its plays, the window the caller
 * asked for, and a genre resolver. This assembles them once so the reports stay about
 * their statistic — and so the CLI, the HTTP routes and the dashboard all resolve a
 * window in exactly the same way.
 */
import { applyFilter, type Filter, loadAllPlays, PLAY_MS, type Play } from "@app/spotify/lib/history";
import { type GenreResolver, genreResolver } from "@app/spotify/lib/library";
import { DEFAULT_TIMEZONE, getProfile, type Profile } from "@app/spotify/lib/profiles";

/** Options shared by every report. `--since` means the same thing everywhere. */
export interface CommonOpts {
    profile?: string;
    since?: string;
    until?: string;
    year?: string;
    top?: string;
    json?: boolean;
    tz?: string;
    artist?: string;
    genre?: string;
    platform?: string;
    minMs?: string;
    allPlays?: boolean;
    excludeIncognito?: boolean;
}

export interface Ctx {
    profile: Profile;
    tz: string;
    /** Everything, unfiltered — needed by reports that compare a window against all time. */
    all: Play[];
    plays: Play[];
    genres: GenreResolver;
    window: string;
    top: number;
    json: boolean;
}

export function windowLabel(o: CommonOpts): string {
    if (o.year) {
        return o.year;
    }

    if (o.since && o.until) {
        return `${o.since} to ${o.until}`;
    }

    if (o.since) {
        return `since ${o.since}`;
    }

    if (o.until) {
        return `until ${o.until}`;
    }

    return "all time";
}

/**
 * Every numeric option arrives as a string, from a CLI flag or a query parameter. A bare
 * `Number("abc")` is `NaN`, and a `NaN` threshold makes every `>=` comparison false — so the
 * report comes back empty and says nothing about why. Reject the bad value instead, naming
 * the option, and let the caller's error path print it.
 */
export function numberOption(
    value: string | undefined,
    option: string,
    fallback: number,
    // Every numeric option here is a count, a threshold or a duration, so the default is the
    // conservative one: whole and not negative. `--top -1` used to slice from the end of the
    // ranking and `?top=1.5` to truncate silently. Pass explicit bounds to widen or narrow it.
    bounds: { min?: number; max?: number; integer?: boolean } = { min: 0, integer: true }
): number {
    if (value === undefined || value === "") {
        return fallback;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`--${option} must be a number; got "${value}"`);
    }

    if (bounds.integer && !Number.isInteger(parsed)) {
        throw new Error(`--${option} must be a whole number; got "${value}"`);
    }

    if (bounds.min !== undefined && parsed < bounds.min) {
        throw new Error(`--${option} must be at least ${bounds.min}; got "${value}"`);
    }

    // An upper bound matters where the number is a proportion rather than a count:
    // `--volume 500` is not "very loud", it is a mistake worth naming before anything plays.
    if (bounds.max !== undefined && parsed > bounds.max) {
        throw new Error(`--${option} must be at most ${bounds.max}; got "${value}"`);
    }

    return parsed;
}

/**
 * A calendar date, checked rather than pattern-matched: `2025-13-01` and `2025-02-30` both look
 * like dates and neither exists. The filter compares `YYYY-MM-DD` strings lexicographically, so
 * anything else silently selects nothing (or everything) instead of saying what was wrong.
 */
export function dateOption(value: string | undefined, option: string): string | undefined {
    if (value === undefined || value === "") {
        return undefined;
    }

    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const t = m ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
    if (!m || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value) {
        throw new Error(`--${option} must be a date as YYYY-MM-DD; got "${value}"`);
    }

    return value;
}

/** A four-digit calendar year. `--year 202x` used to read as "no plays in that year". */
export function yearOption(value: string | undefined, option = "year"): string | undefined {
    if (value === undefined || value === "") {
        return undefined;
    }

    if (!/^\d{4}$/.test(value)) {
        throw new Error(`--${option} must be a four-digit year; got "${value}"`);
    }

    return value;
}

/** Both window options at once, including the ordering between them. */
export function windowOptions(o: CommonOpts): { since?: string; until?: string; year?: string } {
    const since = dateOption(o.since, "since");
    const until = dateOption(o.until, "until");
    if (since && until && since > until) {
        throw new Error(`--since ${since} is after --until ${until}`);
    }

    return { since, until, year: yearOption(o.year) };
}

export function context(o: CommonOpts): Ctx {
    const profile = getProfile(o.profile);
    const tz = o.tz ?? profile.timezone ?? DEFAULT_TIMEZONE;
    const all = loadAllPlays(profile);
    const genres = genreResolver(profile);
    const window = windowOptions(o);

    const filter: Filter = {
        since: window.since,
        until: window.until,
        year: window.year,
        artist: o.artist,
        genre: o.genre,
        platform: o.platform,
        excludeIncognito: o.excludeIncognito,
        minMs: o.minMs ? numberOption(o.minMs, "min-ms", PLAY_MS) : o.allPlays ? 0 : undefined,
        genreOf: (uri) => genres.byUri.get(uri) ?? [],
    };

    // Genre filtering needs the artist fallback too, otherwise it only ever matches liked tracks.
    if (o.genre) {
        filter.genreOf = undefined;
    }

    let plays = applyFilter(all, tz, filter);
    if (o.genre) {
        const want = o.genre.toLowerCase();
        plays = plays.filter((p) => genres.forPlay(p.uri, p.artist).includes(want));
    }

    return {
        profile,
        tz,
        all,
        plays,
        genres,
        window: windowLabel(o),
        top: numberOption(o.top, "top", 20),
        json: !!o.json,
    };
}

/** The threshold a report treats as "a play", honouring `--min-ms` / `--all-plays`. */
export function minMsOf(o: CommonOpts): number {
    if (o.minMs) {
        return numberOption(o.minMs, "min-ms", PLAY_MS);
    }

    return o.allPlays ? 0 : PLAY_MS;
}

/** Header block every report payload carries, so any renderer can title itself. */
export interface ReportHead {
    profile: string;
    label: string;
    window: string;
    timezone: string;
}

export function head(ctx: Ctx): ReportHead {
    return {
        profile: ctx.profile.name,
        label: ctx.profile.label || ctx.profile.name,
        window: ctx.window,
        timezone: ctx.tz,
    };
}
