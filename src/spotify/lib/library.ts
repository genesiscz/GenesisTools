/**
 * The harvested Liked Songs library, and the genre resolver that lets history-only tracks
 * inherit genres.
 *
 * The library holds ~4k liked tracks; the streaming history holds ~34k played ones. Genres
 * are attached to artists, not tracks, so an artist tagged once in the library carries that
 * tag to every play of theirs — including the 88% of played tracks that were never liked.
 * That is the difference between "genres of my library" and "genres of my listening".
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LfArtistRow, MbArtistRow } from "@app/spotify/lib/genres";
import { lastfmTags, musicbrainzTags, SEED_GENRES } from "@app/spotify/lib/genres";
import type { Play } from "@app/spotify/lib/history";
import { readJsonl } from "@app/spotify/lib/io";
import type { Profile } from "@app/spotify/lib/profiles";

export type LibArtist = { uri: string; name: string };

export type LibTrack = {
    uri: string;
    name: string;
    playcount: number | null;
    durationMs?: number;
    addedAt: string | null;
    artists: LibArtist[];
    album?: { uri: string; name: string; date?: string };
    genres?: string[];
};

/** The enriched file when it exists, otherwise the raw harvest. Keyed by directory, not by
 *  profile, because the genre resolver is cached per directory rather than per profile. */
export function libraryPathIn(dataDir: string | undefined): string | null {
    if (!dataDir) {
        return null;
    }

    for (const f of ["spotify_library.genres.jsonl", "spotify_library.jsonl"]) {
        const p = join(dataDir, f);
        if (existsSync(p)) {
            return p;
        }
    }

    return null;
}

export function libraryPath(profile: Profile): string | null {
    return libraryPathIn(profile.dataDir);
}

/**
 * Parsed libraries, keyed by path plus size and mtime — the same invalidation the genre
 * resolver uses, for the same reason: the dashboard answers several reports per page and many
 * of them join against this file, so re-reading and re-parsing it each time blocks the server's
 * event loop over and over on bytes that have not changed.
 */
const libraryCache = new Map<string, LibTrack[]>();

/**
 * Drop every entry for the same file or directory except the one being inserted.
 *
 * Both caches key on a size-and-mtime signature so a changed file is never served stale, which
 * also means a re-harvest inserts a new entry and leaves the old one reachable forever. The
 * dashboard server is long-lived; one entry per source is all it ever needs.
 */
function evictOthers(cache: Map<string, unknown>, prefix: string, keep: string): void {
    for (const key of cache.keys()) {
        if (key !== keep && key.startsWith(prefix)) {
            cache.delete(key);
        }
    }
}

export function loadLibraryIn(dataDir: string | undefined): LibTrack[] {
    const p = libraryPathIn(dataDir);
    if (!p) {
        return [];
    }

    const s = statSync(p, { throwIfNoEntry: false });
    const key = s ? `${p}:${s.size}:${Math.round(s.mtimeMs)}` : p;
    const hit = libraryCache.get(key);
    if (hit) {
        return hit;
    }

    const rows = readJsonl<LibTrack>(p);
    evictOthers(libraryCache, `${p}:`, key);
    libraryCache.set(key, rows);

    return rows;
}

export function loadLibrary(profile: Profile): LibTrack[] {
    return loadLibraryIn(profile.dataDir);
}

export function requireLibrary(profile: Profile): LibTrack[] {
    const lib = loadLibrary(profile);
    if (!lib.length) {
        throw new Error(
            `profile "${profile.name}" has no harvested library.\n` +
                `  Run the browser harvest (see the skill's step 2-3), then:\n` +
                `  spotify profile add ${profile.name} --data <dir>`
        );
    }

    return lib;
}

export type GenreResolver = {
    /** Genres for a played track: exact library match first, then the artist's own tags. */
    forPlay: (uri: string, artist: string) => string[];
    forArtist: (artist: string) => string[];
    byUri: Map<string, string[]>;
    byArtist: Map<string, string[]>;
    vocabulary: Set<string>;
    /** True when nothing could be loaded, so callers can explain instead of showing zeros. */
    empty: boolean;
};

const EMPTY_TAGS: string[] = [];

/**
 * Genres for a play, from several profiles' enrichment at once.
 *
 * The union rather than the first non-empty answer, because the caller builds the resolver list
 * as `[a, b]` and a two-person comparison has to give the same number whichever way round it is
 * asked. With first-match, two people who had both enriched the same artist differently got a
 * different genre vector — and so potentially a different compatibility — from `compat a b` and
 * `compat b a`. Deduplicated, so an artist both sides tagged the same way still counts once.
 */
export function mergeResolvers(resolvers: GenreResolver[]): (p: Play) => string[] {
    return (p) => {
        let merged: string[] | undefined;
        for (const r of resolvers) {
            for (const g of r.forPlay(p.uri, p.artist)) {
                merged ??= [];
                if (!merged.includes(g)) {
                    merged.push(g);
                }
            }
        }

        // Sorted so the array itself is order-independent, not only its contents: it reaches
        // reports that slice it for display.
        return merged?.sort() ?? EMPTY_TAGS;
    };
}

/**
 * Built resolvers, keyed by the data directory plus the size and mtime of the three files they
 * are built from.
 *
 * A CLI process builds one and exits. The dashboard's server is long-lived and answers several
 * reports per page — the Together page alone issues compat, timeline, blend and gift, and each
 * two-person report builds a resolver for BOTH profiles — so without this it re-read and
 * re-parsed the same three JSONL files eight times per navigation, synchronously, on the
 * server's event loop. Same approach as the history cache, and touching a file changes the key.
 */
const resolverCache = new Map<string, GenreResolver>();

function resolverKey(dir: string): string {
    const parts = [dir];
    // `spotify_library.jsonl` is in the key because `libraryPathIn` falls back to it when the
    // enriched file is absent. Without it, a profile that has run `build` but not `enrich`
    // keys on `genres.jsonl:absent` forever, so a re-harvest never invalidates the entry and
    // the long-lived dashboard serves the previous harvest's genres until it restarts.
    for (const name of [
        "mb_artists.jsonl",
        "lf_artists.jsonl",
        "spotify_library.genres.jsonl",
        "spotify_library.jsonl",
    ]) {
        // A missing file is the normal case for a profile without enrichment, so it is part of
        // the key rather than an error: `statSync` throwing is the answer, not a failure.
        const s = statSync(join(dir, name), { throwIfNoEntry: false });
        parts.push(s ? `${name}:${s.size}:${Math.round(s.mtimeMs)}` : `${name}:absent`);
    }

    return parts.join("|");
}

export function genreResolver(profile: Profile): GenreResolver {
    const dir = profile.dataDir;
    if (dir) {
        const key = resolverKey(dir);
        const hit = resolverCache.get(key);
        if (hit) {
            return hit;
        }

        const built = buildGenreResolver(dir);
        evictOthers(resolverCache, `${dir}|`, key);
        resolverCache.set(key, built);

        return built;
    }

    return buildGenreResolver(undefined);
}

function buildGenreResolver(dir: string | undefined): GenreResolver {
    const byUri = new Map<string, string[]>();
    const byArtist = new Map<string, string[]>();
    const vocabulary = new Set<string>(SEED_GENRES);

    if (!dir) {
        return {
            forPlay: () => EMPTY_TAGS,
            forArtist: () => EMPTY_TAGS,
            byUri,
            byArtist,
            vocabulary,
            empty: true,
        };
    }

    const mbTags = new Map<string, string[]>();
    const artistNames = new Map<string, string>();
    for (const r of readJsonl<MbArtistRow>(join(dir, "mb_artists.jsonl"))) {
        if (r.name) {
            artistNames.set(r.uri, r.name.toLowerCase());
        }

        const tags = musicbrainzTags(r);
        for (const t of tags) {
            vocabulary.add(t);
        }

        mbTags.set(r.uri, tags);
    }

    const lfTags = new Map<string, string[]>();
    for (const r of readJsonl<LfArtistRow>(join(dir, "lf_artists.jsonl"))) {
        if (r.name && !artistNames.has(r.uri)) {
            artistNames.set(r.uri, r.name.toLowerCase());
        }

        lfTags.set(r.uri, lastfmTags(r, vocabulary));
    }

    for (const [uri, name] of artistNames) {
        const merged: string[] = [];
        for (const t of [...(mbTags.get(uri) ?? []), ...(lfTags.get(uri) ?? [])]) {
            if (!merged.includes(t)) {
                merged.push(t);
            }
        }

        if (!merged.length) {
            continue;
        }

        const prev = byArtist.get(name);
        if (!prev) {
            byArtist.set(name, merged);
            continue;
        }

        for (const t of merged) {
            if (!prev.includes(t)) {
                prev.push(t);
            }
        }
    }

    for (const t of loadLibraryIn(dir)) {
        if (t.genres?.length) {
            byUri.set(t.uri, t.genres);
        }

        for (const a of t.artists ?? []) {
            const key = a.name.toLowerCase();
            if (!byArtist.has(key) && t.genres?.length) {
                byArtist.set(key, t.genres);
            }
        }
    }

    const forArtist = (artist: string) => byArtist.get(artist.toLowerCase()) ?? EMPTY_TAGS;

    return {
        forPlay: (uri, artist) => byUri.get(uri) ?? forArtist(artist),
        forArtist,
        byUri,
        byArtist,
        vocabulary,
        empty: byUri.size === 0 && byArtist.size === 0,
    };
}

/** Global stream counts, harvested from the web player's own API. Not personal plays. */
export function globalPlaycounts(profile: Profile): Map<string, number> {
    const out = new Map<string, number>();
    for (const t of loadLibrary(profile)) {
        if (typeof t.playcount === "number" && t.playcount > 0) {
            out.set(t.uri, t.playcount);
        }
    }

    return out;
}

export function likedUris(profile: Profile): Set<string> {
    return new Set(loadLibrary(profile).map((t) => t.uri));
}

export function likedArtists(profile: Profile): Set<string> {
    const out = new Set<string>();
    for (const t of loadLibrary(profile)) {
        for (const a of t.artists ?? []) {
            out.add(a.name.toLowerCase());
        }
    }

    return out;
}
