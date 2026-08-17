/**
 * Loading and slicing the Extended Streaming History.
 *
 * The raw export is ~110 MB of JSON across a dozen files, which is a second or two of
 * parsing every time a report runs. Since this tool is meant to be poked at repeatedly
 * (and the dashboard re-reads on every request), the first load writes a dictionary-encoded
 * cache keyed by the source files' size and mtime; later loads read ~10 MB instead. Any
 * ordinary change to the export moves one of those, so the key changes with it. A replacement
 * that happens to match both the byte count and the modification time would be served from
 * cache; delete `~/.genesis-tools/spotify/cache` if you ever arrange that.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { cacheDir } from "@app/spotify/lib/paths";
import type { Profile } from "@app/spotify/lib/profiles";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

const log = logger.child({ component: "spotify:history" });

/** Spotify's own royalty threshold, and therefore what "a play" means everywhere here. */
export const PLAY_MS = 30_000;

const CACHE_VERSION = 2;

const F_SHUFFLE = 1;
const F_SKIPPED = 2;
const F_OFFLINE = 4;
const F_INCOGNITO = 8;

export interface Play {
    ts: number;
    ms: number;
    uri: string;
    name: string;
    artist: string;
    album: string;
    platform: string;
    country: string;
    reasonStart: string;
    reasonEnd: string;
    shuffle: boolean;
    skipped: boolean;
    offline: boolean;
    incognito: boolean;
}

interface RawEvent {
    ts: string;
    ms_played: number;
    platform?: string | null;
    conn_country?: string | null;
    master_metadata_track_name?: string | null;
    master_metadata_album_artist_name?: string | null;
    master_metadata_album_album_name?: string | null;
    spotify_track_uri?: string | null;
    reason_start?: string | null;
    reason_end?: string | null;
    shuffle?: boolean | null;
    skipped?: boolean | null;
    offline?: boolean | null;
    incognito_mode?: boolean | null;
}

interface Cache {
    v: number;
    sig: string;
    dict: string[];
    rows: number[][];
}

/** The export's audio files, oldest first. One definition of what counts as history input. */
export function historyFiles(dir: string): string[] {
    return readdirSync(dir)
        .filter((f) => f.startsWith("Streaming_History_Audio_") && f.endsWith(".json"))
        .sort()
        .map((f) => join(dir, f));
}

function signature(files: string[]): string {
    // SHA-256 rather than SHA-1: this is only a cache key, but the weaker digest trips SAST
    // scanners and the stronger one costs nothing at a dozen file stats.
    const h = createHash("sha256");
    for (const f of files) {
        const s = statSync(f);
        h.update(`${f}:${s.size}:${Math.round(s.mtimeMs)}`);
    }

    return h.digest("hex").slice(0, 16);
}

function encode(plays: Play[]): Cache {
    const dict: string[] = [];
    const index = new Map<string, number>();
    const id = (s: string) => {
        let i = index.get(s);
        if (i === undefined) {
            i = dict.length;
            dict.push(s);
            index.set(s, i);
        }

        return i;
    };

    const rows = plays.map((p) => [
        Math.round(p.ts / 1000),
        p.ms,
        id(p.uri),
        id(p.name),
        id(p.artist),
        id(p.album),
        id(p.platform),
        id(p.country),
        id(p.reasonStart),
        id(p.reasonEnd),
        (p.shuffle ? F_SHUFFLE : 0) |
            (p.skipped ? F_SKIPPED : 0) |
            (p.offline ? F_OFFLINE : 0) |
            (p.incognito ? F_INCOGNITO : 0),
    ]);

    return { v: CACHE_VERSION, sig: "", dict, rows };
}

function decode(c: Cache): Play[] {
    const d = c.dict;

    return c.rows.map((r) => ({
        ts: r[0]! * 1000,
        ms: r[1]!,
        uri: d[r[2]!]!,
        name: d[r[3]!]!,
        artist: d[r[4]!]!,
        album: d[r[5]!]!,
        platform: d[r[6]!]!,
        country: d[r[7]!]!,
        reasonStart: d[r[8]!]!,
        reasonEnd: d[r[9]!]!,
        shuffle: (r[10]! & F_SHUFFLE) !== 0,
        skipped: (r[10]! & F_SKIPPED) !== 0,
        offline: (r[10]! & F_OFFLINE) !== 0,
        incognito: (r[10]! & F_INCOGNITO) !== 0,
    }));
}

/** The export spells the same device a dozen ways across the years. */
function normPlatform(p: string): string {
    const s = p.toLowerCase();
    if (s.includes("android")) {
        return "android";
    }

    if (s.includes("ios") || s.includes("iphone") || s.includes("ipad")) {
        return "ios";
    }

    if (s.includes("osx") || s.includes("os x") || s.includes("mac")) {
        return "mac";
    }

    if (s.includes("windows")) {
        return "windows";
    }

    if (s.includes("linux")) {
        return "linux";
    }

    if (s.includes("web") || s.includes("chrome") || s.includes("firefox")) {
        return "web";
    }

    if (s.includes("cast") || s.includes("sonos") || s.includes("partner") || s.includes("speaker")) {
        return "speaker";
    }

    if (!s || s === "not_applicable" || s === "unknown") {
        return "unknown";
    }

    return s.split(/[ ;(]/)[0] || "other";
}

function parseAll(files: string[]): Play[] {
    const out: Play[] = [];
    for (const f of files) {
        // strict: this is Spotify's export, third-party data at a system boundary. The
        // lenient default accepts trailing commas and comments, so a truncated or hand-edited
        // file parses into a PARTIAL event list and every report silently reads short. The
        // cache read further down is exempt — this codebase writes that one.
        for (const e of SafeJSON.parse(readFileSync(f, "utf8"), { strict: true }) as RawEvent[]) {
            if (!e.spotify_track_uri) {
                continue;
            }

            out.push({
                ts: Date.parse(e.ts),
                ms: e.ms_played ?? 0,
                uri: e.spotify_track_uri,
                name: e.master_metadata_track_name ?? "",
                artist: e.master_metadata_album_artist_name ?? "",
                album: e.master_metadata_album_album_name ?? "",
                platform: normPlatform(e.platform ?? ""),
                country: e.conn_country ?? "",
                reasonStart: e.reason_start ?? "",
                reasonEnd: e.reason_end ?? "",
                shuffle: !!e.shuffle,
                skipped: !!e.skipped,
                offline: !!e.offline,
                incognito: !!e.incognito_mode,
            });
        }
    }

    out.sort((a, b) => a.ts - b.ts);

    return out;
}

/**
 * Decoded plays, keyed by profile plus the export's size/mtime signature.
 *
 * A CLI process runs one command and exits, so this only ever holds one entry there. The
 * dashboard's server is long-lived and answers several reports per page, and re-decoding
 * 120k rows per request is the difference between a snappy page and a second of latency.
 * Touch the export and the signature changes, so a stale entry is not reachable.
 */
const memo = new Map<string, Play[]>();

/**
 * One entry per profile, not one per signature ever seen.
 *
 * The key carries the export's signature so a changed export is never served from a stale
 * entry, but that also means every re-export inserts another decoded array — 120k plays each —
 * while the previous one stays reachable. A CLI process exits before that matters; the
 * dashboard server does not.
 */
function rememberPlays(profile: string, key: string, plays: Play[]): Play[] {
    for (const existing of memo.keys()) {
        if (existing !== key && existing.startsWith(`${profile}:`)) {
            memo.delete(existing);
        }
    }

    memo.set(key, plays);

    return plays;
}

/**
 * Drop this profile's superseded on-disk caches once the new one is safely written.
 *
 * The filename carries the export's signature, so a re-export writes a NEW ~10 MB file and
 * the old one becomes unreachable but stays on disk forever. Two of them were already
 * sitting in a real cache directory, 20 MB for one profile's 10 MB of data.
 *
 * Scoped to `<sanitized profile>-*.json` so a second profile's cache is never touched, and
 * only ever called after the replacement exists.
 */
function evictStaleCaches({ dir, prefix, keep }: { dir: string; prefix: string; keep: string }): void {
    try {
        for (const name of readdirSync(dir)) {
            if (name !== keep && name.startsWith(prefix) && name.endsWith(".json")) {
                unlinkSync(join(dir, name));
                log.debug({ dir, name }, "evicted superseded history cache");
            }
        }
    } catch (err) {
        // A cache that cannot be pruned is a disk-space problem, never a correctness one:
        // the caller already has its answer.
        log.debug({ dir, prefix, err }, "could not prune superseded history caches");
    }
}

/**
 * A filesystem-safe cache key that is INJECTIVE over profile names.
 *
 * Sanitising alone is not: `a b` and `a@b` both collapse to `a_b`, and profile names only
 * have to avoid separators and `..` to be valid. Two profiles then shared a cache prefix, so
 * loading one after its export changed evicted the other's cache — the precise invariant the
 * eviction helper promises to keep. A short digest of the ORIGINAL name restores it, and the
 * readable part is kept so a human can still tell whose cache a file is.
 */
export function profileCacheKey(name: string): string {
    const readable = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
    const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);

    return `${readable}-${digest}`;
}

export function loadAllPlays(profile: Profile): Play[] {
    if (!profile.historyDir) {
        throw new Error(
            `profile "${profile.name}" has no streaming history.\n` +
                `  Request it at https://www.spotify.com/account/privacy (Extended streaming history),\n` +
                `  unzip it, then: tools spotify profile add ${profile.name} --history <dir>`
        );
    }

    const files = historyFiles(profile.historyDir);
    if (!files.length) {
        throw new Error(`no Streaming_History_Audio_*.json in ${profile.historyDir}`);
    }

    const sig = signature(files);
    const memoKey = `${profile.name}:${sig}`;
    const inMemory = memo.get(memoKey);
    if (inMemory) {
        return inMemory;
    }

    const dir = cacheDir();
    const key = profileCacheKey(profile.name);
    const cachePath = join(dir, `${key}-${sig}.json`);
    if (existsSync(cachePath)) {
        try {
            const cached = SafeJSON.parse(readFileSync(cachePath, "utf8")) as Cache;
            if (cached.v === CACHE_VERSION) {
                log.debug({ profile: profile.name, cachePath, rows: cached.rows.length }, "history cache hit");
                const decoded = decode(cached);
                return rememberPlays(profile.name, memoKey, decoded);
            }
        } catch (err) {
            log.debug({ cachePath, err }, "history cache unreadable (interrupted write?), reparsing");
        }
    }

    log.debug({ profile: profile.name, files: files.length, dir: profile.historyDir }, "parsing streaming history");
    const plays = parseAll(files);
    try {
        mkdirSync(dir, { recursive: true });
        const enc = encode(plays);
        enc.sig = sig;
        // Atomic, because the reader above already treats a torn file as "reparse": a plain
        // write truncates first, so an interrupted run leaves a 10 MB corpse that every later
        // run reads, fails to parse, and rewrites.
        atomicWriteFileSync(cachePath, SafeJSON.stringify(enc));
        evictStaleCaches({ dir, prefix: `${key}-`, keep: basename(cachePath) });
    } catch (err) {
        log.warn({ cachePath, err }, "could not write the history cache; every run will reparse");
    }

    return rememberPlays(profile.name, memoKey, plays);
}

const offsetCache = new Map<string, Map<number, number>>();

function offsetsFor(tz: string): Map<number, number> {
    let days = offsetCache.get(tz);
    if (!days) {
        days = new Map<number, number>();
        offsetCache.set(tz, days);
    }

    return days;
}

/** The exact offset for one instant. One `Intl` round trip, so it is not for the hot loop. */
function offsetAt(ts: number, tz: string): number {
    const local = new Date(ts).toLocaleString("sv-SE", { timeZone: tz });

    return Math.round((Date.parse(`${local.replace(" ", "T")}Z`) - ts) / 60000);
}

/** A UTC day whose offset is not constant: a DST transition falls inside it. */
const SPLIT_DAY = Number.NaN;

/**
 * Minutes to add to a UTC timestamp to reach the profile's wall clock.
 *
 * Cached per UTC day, because computing it per play over 140k plays is the difference between
 * a snappy report and a slow one. A day whose first and last instant disagree — the two DST
 * transitions each year — is marked as such and its plays are computed individually, so an
 * event on a transition day is no longer assigned the neighbouring hour (or, near midnight,
 * the neighbouring date, which moved it between day, week and streak buckets).
 *
 * The cache is keyed by the whole timezone, not a hash of it. It used to fold the name into
 * its length, which made Europe/Prague and Europe/London (both 13 characters, an hour apart)
 * share an entry — reachable in the long-lived dashboard and in any two-person comparison.
 */
function offsetMinutes(ts: number, tz: string): number {
    const day = Math.floor(ts / 86400000);
    const days = offsetsFor(tz);
    const hit = days.get(day);
    if (hit !== undefined) {
        return Number.isNaN(hit) ? offsetAt(ts, tz) : hit;
    }

    const start = day * 86400000;
    const first = offsetAt(start, tz);
    const last = offsetAt(start + 86399999, tz);
    if (first !== last) {
        days.set(day, SPLIT_DAY);

        return offsetAt(ts, tz);
    }

    days.set(day, first);

    return first;
}

export interface LocalTime {
    y: number;
    m: number;
    d: number;
    hour: number;
    minute: number;
    /** 0 = Monday. */
    weekday: number;
    date: string;
}

export function localTime(ts: number, tz: string): LocalTime {
    const shifted = new Date(ts + offsetMinutes(ts, tz) * 60000);
    const y = shifted.getUTCFullYear();
    const m = shifted.getUTCMonth() + 1;
    const d = shifted.getUTCDate();

    return {
        y,
        m,
        d,
        hour: shifted.getUTCHours(),
        minute: shifted.getUTCMinutes(),
        weekday: (shifted.getUTCDay() + 6) % 7,
        date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    };
}

export type Bucket = "day" | "week" | "month" | "quarter" | "year";

const BUCKETS: readonly string[] = ["day", "week", "month", "quarter", "year"];

/**
 * `--bucket` and `?bucket=` are free-form strings until this runs. An unchecked cast reaches
 * `bucketOf` as an unknown bucket and comes back as garbage keys rather than an error.
 */
export function parseBucket(value: string | undefined, fallback: Bucket): Bucket {
    if (!value) {
        return fallback;
    }

    if (!BUCKETS.includes(value)) {
        throw new Error(`unknown bucket "${value}". Pick one of: ${BUCKETS.join(", ")}`);
    }

    return value as Bucket;
}

export function bucketOf(ts: number, tz: string, b: Bucket): string {
    const t = localTime(ts, tz);
    const mm = String(t.m).padStart(2, "0");
    if (b === "year") {
        return String(t.y);
    }

    if (b === "quarter") {
        return `${t.y}-Q${Math.floor((t.m - 1) / 3) + 1}`;
    }

    if (b === "month") {
        return `${t.y}-${mm}`;
    }

    if (b === "week") {
        const midnight = Date.UTC(t.y, t.m - 1, t.d);
        const monday = new Date(midnight - ((new Date(midnight).getUTCDay() + 6) % 7) * 86400000);

        return monday.toISOString().slice(0, 10);
    }

    return t.date;
}

export interface Filter {
    since?: string;
    until?: string;
    year?: string;
    minMs?: number;
    artist?: string;
    genreOf?: (uri: string) => string[];
    genre?: string;
    platform?: string;
    excludeIncognito?: boolean;
}

export function applyFilter(plays: Play[], tz: string, f: Filter): Play[] {
    let since = f.since;
    let until = f.until;
    if (f.year) {
        since = `${f.year}-01-01`;
        until = `${f.year}-12-31`;
    }

    const artist = f.artist?.toLowerCase();
    const genre = f.genre?.toLowerCase();
    const platform = f.platform?.toLowerCase();

    return plays.filter((p) => {
        if (f.minMs !== undefined && p.ms < f.minMs) {
            return false;
        }

        if (since || until) {
            const d = localTime(p.ts, tz).date;
            if (since && d < since) {
                return false;
            }

            if (until && d > until) {
                return false;
            }
        }

        if (artist && !p.artist.toLowerCase().includes(artist)) {
            return false;
        }

        if (platform && p.platform !== platform) {
            return false;
        }

        if (f.excludeIncognito && p.incognito) {
            return false;
        }

        if (genre && f.genreOf && !f.genreOf(p.uri).some((g) => g === genre)) {
            return false;
        }

        return true;
    });
}

export interface Agg {
    key: string;
    label: string;
    sub: string;
    plays: number;
    shortPlays: number;
    ms: number;
    first: number;
    last: number;
    uris: Set<string>;
}

export function aggregate(
    plays: Play[],
    keyOf: (p: Play) => string,
    labelOf: (p: Play) => [string, string]
): Map<string, Agg> {
    const out = new Map<string, Agg>();
    for (const p of plays) {
        const k = keyOf(p);
        let a = out.get(k);
        if (!a) {
            const [label, sub] = labelOf(p);
            a = { key: k, label, sub, plays: 0, shortPlays: 0, ms: 0, first: p.ts, last: p.ts, uris: new Set() };
            out.set(k, a);
        }

        if (p.ms >= PLAY_MS) {
            a.plays++;
        } else {
            a.shortPlays++;
        }

        a.ms += p.ms;
        a.uris.add(p.uri);
        if (p.ts < a.first) {
            a.first = p.ts;
        }

        if (p.ts > a.last) {
            a.last = p.ts;
        }
    }

    return out;
}

/**
 * The separator is NUL because a space is not injective: track "a b" by "c" and track "a" by
 * "b c" would be the same key, silently merging two songs in every ranking, trend, blend and
 * compatibility set that groups by one.
 */
const pairKey = (a: string, b: string) => `${a.toLowerCase()}\0${b.toLowerCase()}`;

/**
 * The song key for a title and an artist that did not come from a play — the harvested
 * library, for one, whose rows have to be matched against played songs. Callers must never
 * build this string themselves: the audit's "never played" count was wrong for exactly as long
 * as one of them did.
 */
export const songKeyOf = (name: string, artist: string) => pairKey(name, artist);

/** One song across every release it appears on. */
export const songKey = (p: Play) => songKeyOf(p.name, p.artist);

/** One album by one artist. Same rule, and it must stay the same rule. */
export const albumKey = (p: Play) => pairKey(p.album, p.artist);

export const byTrack = (plays: Play[]) =>
    aggregate(
        plays,
        (p) => p.uri,
        (p) => [p.name, p.artist]
    );

export const bySong = (plays: Play[]) => aggregate(plays, songKey, (p) => [p.name, p.artist]);

export const byArtist = (plays: Play[]) =>
    aggregate(
        plays,
        (p) => p.artist.toLowerCase(),
        (p) => [p.artist, ""]
    );

export const byAlbum = (plays: Play[]) => aggregate(plays, albumKey, (p) => [p.album, p.artist]);

export const sortedAggs = (m: Map<string, Agg>, by: "plays" | "ms" = "plays") =>
    [...m.values()].sort((a, b) => (by === "ms" ? b.ms - a.ms || b.plays - a.plays : b.plays - a.plays || b.ms - a.ms));

/** Plays that cleared the 30s bar, which is what "a play" means in every table. */
export const counted = (plays: Play[], minMs = PLAY_MS) => plays.filter((p) => p.ms >= minMs);

export function median(values: number[]): number {
    if (!values.length) {
        return 0;
    }

    const v = [...values].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);

    return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}
