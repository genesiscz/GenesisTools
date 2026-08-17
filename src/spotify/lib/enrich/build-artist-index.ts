/**
 * Turn the harvested library into the artist index the enrichers consume.
 *
 * Reads  <dir>/sp_library_raw.json   (whatever harvestLibrary.ts returned) OR
 *        <dir>/spotify_library.jsonl (if it was already converted)
 * Writes <dir>/spotify_library.jsonl  one track per line
 *        <dir>/artists.json           { all, lastYear } — artist uri -> name
 *
 * `lastYear` exists so the enrichers can crawl recent artists first. Those crawls run for
 * tens of minutes, and the question being asked is usually about the recent window, so
 * ordering them first makes the answer available long before the full run finishes.
 *
 * chrome-devtools-mcp wraps evaluate_script output in a ```json fence, which is stripped
 * here rather than by hand.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, readJsonl, writeJsonl } from "@app/spotify/lib/io";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

const log = logger.child({ component: "spotify:build-artist-index" });

interface Track {
    uri: string;
    addedAt: string | null;
    artists: { uri: string; name: string }[];
}

export interface ArtistIndex {
    all: Record<string, string>;
    lastYear: Record<string, string>;
}

/**
 * The artist index both enrichers read, with the error a person can act on.
 *
 * `readJson` is a bare `readFileSync`, so a profile that has a library but has never run
 * `build` failed with `ENOENT: no such file or directory, open '…/artists.json'` — a path
 * nobody recognises, naming a file they never heard of, with no hint that one command
 * creates it. Both crawls need this, so the guard lives here rather than in each of them.
 */
export function loadArtistIndex(dir: string, profileHint?: string): ArtistIndex {
    const path = join(dir, "artists.json");

    if (!existsSync(path)) {
        const profile = profileHint ? ` --profile ${profileHint}` : "";

        throw new Error(
            `no artist index in ${dir}.\n` +
                `  It is built from the harvested library:\n` +
                `    tools spotify build${profile}\n` +
                "  If there is no library yet, harvest one first: tools spotify harvest --auto"
        );
    }

    return readJson<ArtistIndex>(path);
}

export interface BuildArtistIndexOptions {
    dataDir: string;
    /** Tracks saved on or after this date feed the `lastYear` crawl order. */
    since?: string;
}

export interface BuildArtistIndexResult {
    convertedFrom: string | null;
    jsonlPath: string;
    tracks: number;
    artists: number;
    recentArtists: number;
    since: string;
}

export function buildArtistIndex(opts: BuildArtistIndexOptions): BuildArtistIndexResult {
    const dir = opts.dataDir;
    const since = opts.since ?? new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    const jsonlPath = join(dir, "spotify_library.jsonl");
    const rawPath = join(dir, "sp_library_raw.json");

    let tracks: Track[];
    let convertedFrom: string | null = null;
    if (existsSync(rawPath)) {
        const raw = readFileSync(rawPath, "utf8")
            .trim()
            .replace(/^```json\s*/, "")
            .replace(/\s*```$/, "");
        const parsed = SafeJSON.parse(raw) as { tracks?: Track[] } | Track[];
        tracks = Array.isArray(parsed) ? parsed : (parsed.tracks ?? []);
        writeJsonl(jsonlPath, tracks);
        convertedFrom = rawPath;
        log.info({ rawPath, jsonlPath, tracks: tracks.length }, "converted raw harvest to jsonl");
    } else {
        tracks = readJsonl<Track>(jsonlPath);
        log.info({ jsonlPath, tracks: tracks.length }, "read existing library jsonl");
    }

    const all: Record<string, string> = {};
    const lastYear: Record<string, string> = {};
    for (const t of tracks) {
        const recent = (t.addedAt ?? "").slice(0, 10) >= since;
        for (const a of t.artists) {
            all[a.uri] ??= a.name;
            if (recent) {
                lastYear[a.uri] ??= a.name;
            }
        }
    }

    // Atomic: this file is the input to both enrichment crawls, and a run interrupted
    // mid-write left a truncated index that the next crawl read as a short artist list.
    atomicWriteFileSync(join(dir, "artists.json"), SafeJSON.stringify({ all, lastYear }));

    return {
        convertedFrom,
        jsonlPath,
        tracks: tracks.length,
        artists: Object.keys(all).length,
        recentArtists: Object.keys(lastYear).length,
        since,
    };
}
