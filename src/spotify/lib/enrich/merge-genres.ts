/**
 * Merge MusicBrainz + Last.fm artist tags onto the track library and report genres.
 *
 * Reads  <dir>/spotify_library.jsonl, mb_artists.jsonl, lf_artists.jsonl
 * Writes <dir>/spotify_library.genres.jsonl   (every track plus a `genres` array)
 * Returns the genre breakdown for tracks added on/after `since` (default: one year ago).
 *
 * A track's genres are the union of its artists' tags. MusicBrainz goes first because it
 * was matched precisely; Last.fm fills the long tail but only through a vocabulary
 * whitelist, since its raw tag cloud is full of "all", "go", "australia" and the tags of
 * whichever other artist happens to share the name.
 */
import { join } from "node:path";
import type { LfArtistRow, MbArtistRow } from "@app/spotify/lib/genres";
import { lastfmTags, musicbrainzTags, SEED_GENRES } from "@app/spotify/lib/genres";
import { readJsonl, writeJsonl } from "@app/spotify/lib/io";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "spotify:enrich:merge-genres" });

interface Track {
    uri: string;
    name: string;
    playcount: number | null;
    addedAt: string | null;
    artists: { uri: string; name: string }[];
    genres?: string[];
}

export interface MergeGenresOptions {
    dataDir: string;
    /** Window for the returned breakdown. Defaults to one year ago. */
    since?: string;
    minTracks?: number;
    top?: number;
}

export interface MergeGenresResult {
    since: string;
    sources: { musicbrainzArtists: number; lastfmArtists: number; vocabulary: number };
    library: { tracks: number; tagged: number };
    window: { tracks: number; tagged: number; distinctGenres: number };
    genres: { genre: string; tracks: number; share: number; plays: number }[];
}

export function mergeGenres(opts: MergeGenresOptions): MergeGenresResult {
    const dir = opts.dataDir;
    const since = opts.since ?? new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    const minTracks = opts.minTracks ?? 1;
    const top = opts.top ?? 0;

    const mb = new Map<string, string[]>();
    for (const r of readJsonl<MbArtistRow>(join(dir, "mb_artists.jsonl"))) {
        mb.set(r.uri, musicbrainzTags(r));
    }

    // The whitelist is MusicBrainz's own vocabulary across this library plus the seed list,
    // so it adapts to whatever the library actually contains instead of being a fixed guess.
    const vocab = new Set<string>(SEED_GENRES);
    for (const tags of mb.values()) {
        for (const t of tags) {
            vocab.add(t);
        }
    }

    const lf = new Map<string, string[]>();
    for (const r of readJsonl<LfArtistRow>(join(dir, "lf_artists.jsonl"))) {
        lf.set(r.uri, lastfmTags(r, vocab));
    }

    const tracks = readJsonl<Track>(join(dir, "spotify_library.jsonl"));
    for (const t of tracks) {
        const seen = new Set<string>();
        const genres: string[] = [];
        for (const src of [mb, lf]) {
            for (const a of t.artists) {
                for (const tag of src.get(a.uri) ?? []) {
                    if (!seen.has(tag)) {
                        seen.add(tag);
                        genres.push(tag);
                    }
                }
            }
        }

        t.genres = genres;
    }

    writeJsonl(join(dir, "spotify_library.genres.jsonl"), tracks);
    log.info({ dir, tracks: tracks.length }, "wrote spotify_library.genres.jsonl");

    const sel = tracks.filter((t) => (t.addedAt ?? "").slice(0, 10) >= since);
    const selTagged = sel.filter((t) => t.genres!.length);
    const counts = new Map<string, number>();
    const plays = new Map<string, number>();
    for (const t of sel) {
        for (const g of t.genres!) {
            counts.set(g, (counts.get(g) ?? 0) + 1);
            plays.set(g, (plays.get(g) ?? 0) + (t.playcount ?? 0));
        }
    }

    let rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).filter(([, n]) => n >= minTracks);
    if (top) {
        rows = rows.slice(0, top);
    }

    return {
        since,
        sources: { musicbrainzArtists: mb.size, lastfmArtists: lf.size, vocabulary: vocab.size },
        library: { tracks: tracks.length, tagged: tracks.filter((t) => t.genres!.length).length },
        window: { tracks: sel.length, tagged: selTagged.length, distinctGenres: counts.size },
        genres: rows.map(([genre, n]) => ({
            genre,
            tracks: n,
            share: +((n * 100) / Math.max(1, sel.length)).toFixed(1),
            plays: plays.get(genre) ?? 0,
        })),
    };
}
