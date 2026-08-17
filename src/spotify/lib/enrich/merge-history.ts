/**
 * Join Spotify's official Extended Streaming History onto the harvested library.
 *
 * Reads  <dir>/spotify_library.genres.jsonl, or spotify_library.jsonl before enrichment
 *        <history>/Streaming_History_Audio_*.json   (default <dir>/../streaming-history)
 * Writes <dir>/spotify_library.full.jsonl  — every track plus personal listening fields
 *
 * This is the only source of PERSONAL play counts. The `playcount` harvested from the
 * internal API is the track's GLOBAL stream count across all Spotify users; the two are
 * unrelated and must never be reported as if they were the same number.
 *
 * Request the export at https://www.spotify.com/account/privacy (Extended streaming
 * history), confirm by email, and expect up to 30 days. The link expires after 14 days.
 *
 * A "play" follows Spotify's own royalty threshold: >= 30 seconds. Everything shorter is
 * counted separately as a skip, because a library full of 3-second previews would
 * otherwise read as heavy listening — which matters here, since harvesting generates
 * exactly those 3-second previews.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { historyFiles, PLAY_MS } from "@app/spotify/lib/history";
import { writeJsonl } from "@app/spotify/lib/io";
import { loadLibraryIn } from "@app/spotify/lib/library";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "spotify:enrich:merge-history" });

interface Event {
    ts: string;
    ms_played: number;
    spotify_track_uri: string | null;
    master_metadata_track_name: string | null;
    master_metadata_album_artist_name: string | null;
}

interface Stat {
    plays: number;
    shortPlays: number;
    msPlayed: number;
    first: string;
    last: string;
    name: string;
    artist: string;
}

interface Track {
    uri: string;
    name: string;
    artists: { uri: string; name: string }[];
    playcount: number | null;
    genres?: string[];
    myPlays?: number;
    myShortPlays?: number;
    myHours?: number;
    firstPlayed?: string | null;
    lastPlayed?: string | null;
}

export type MergeHistoryGrouping = "tracks" | "artists" | "genres";

export interface MergeHistoryOptions {
    dataDir: string;
    historyDir?: string;
    since?: string;
    by?: MergeHistoryGrouping;
    top?: number;
}

export interface MergeHistoryResult {
    files: number;
    events: number;
    eventsWithoutUri: number;
    since: string | null;
    distinctTracks: number;
    totalPlays: number;
    totalHours: number;
    library: { total: number; matched: number };
    by: MergeHistoryGrouping;
    rows: { label: string; sub?: string; plays: number; hours: number; extra?: number; liked?: boolean }[];
}

export function mergeHistory(opts: MergeHistoryOptions): MergeHistoryResult {
    const dir = opts.dataDir;
    const historyDir = opts.historyDir ?? resolve(dir, "..", "streaming-history");
    const since = opts.since ?? null;
    const by = opts.by ?? "tracks";
    const top = opts.top ?? 25;

    const files = historyFiles(historyDir);
    if (!files.length) {
        throw new Error(`no Streaming_History_Audio_*.json in ${historyDir}`);
    }

    // The raw events rather than `loadAllPlays`: this writes the export's own ISO timestamps
    // into spotify_library.full.jsonl and reports how many events carried no track URI, and
    // the decoded `Play` keeps neither (its ts is epoch milliseconds, and URI-less rows are
    // dropped during parsing). File discovery is shared, which is where the two would drift.
    const stats = new Map<string, Stat>();
    let events = 0;
    let noUri = 0;
    for (const f of files) {
        for (const e of SafeJSON.parse(readFileSync(f, "utf8"), { strict: true }) as Event[]) {
            events++;
            if (!e.spotify_track_uri) {
                noUri++;
                continue;
            }

            if (since && e.ts.slice(0, 10) < since) {
                continue;
            }

            let s = stats.get(e.spotify_track_uri);
            if (!s) {
                s = {
                    plays: 0,
                    shortPlays: 0,
                    msPlayed: 0,
                    first: e.ts,
                    last: e.ts,
                    name: e.master_metadata_track_name ?? "",
                    artist: e.master_metadata_album_artist_name ?? "",
                };
                stats.set(e.spotify_track_uri, s);
            }

            if (e.ms_played >= PLAY_MS) {
                s.plays++;
            } else {
                s.shortPlays++;
            }

            s.msPlayed += e.ms_played ?? 0;
            if (e.ts < s.first) {
                s.first = e.ts;
            }

            if (e.ts > s.last) {
                s.last = e.ts;
            }
        }
    }

    // Whichever library file exists, through the shared loader: hardcoding the enriched name
    // meant that between `build` and `enrich` this joined against nothing, reported "0 of 0
    // matched", and wrote an empty full.jsonl — in the documented pipeline order.
    //
    // Copied, because the loader memoizes what it parsed and the loop below writes the personal
    // fields onto each row: mutating in place would hand every later reader in this process a
    // library carrying one merge's numbers.
    const tracks = loadLibraryIn(dir).map((t) => ({ ...t }) as Track);
    if (!tracks.length) {
        throw new Error(`no library in ${dir}. Run \`tools spotify build\` first.`);
    }

    let matched = 0;
    for (const t of tracks) {
        const s = stats.get(t.uri);
        t.myPlays = s?.plays ?? 0;
        t.myShortPlays = s?.shortPlays ?? 0;
        t.myHours = s ? +(s.msPlayed / 3600000).toFixed(2) : 0;
        t.firstPlayed = s?.first ?? null;
        t.lastPlayed = s?.last ?? null;
        if (s) {
            matched++;
        }
    }

    writeJsonl(join(dir, "spotify_library.full.jsonl"), tracks);
    log.info({ dir, tracks: tracks.length, matched }, "wrote spotify_library.full.jsonl");

    const totalHours = [...stats.values()].reduce((a, s) => a + s.msPlayed, 0) / 3600000;
    const totalPlays = [...stats.values()].reduce((a, s) => a + s.plays, 0);

    let rows: MergeHistoryResult["rows"] = [];
    if (by === "tracks") {
        // Ranked over the HISTORY, not the library, so heavy plays of never-liked tracks show up.
        const liked = new Set(tracks.map((t) => t.uri));
        rows = [...stats.entries()]
            .sort((a, b) => b[1].plays - a[1].plays)
            .slice(0, top)
            .map(([uri, s]) => ({
                label: s.name,
                sub: s.artist,
                plays: s.plays,
                hours: +(s.msPlayed / 3600000).toFixed(1),
                liked: liked.has(uri),
            }));
    } else if (by === "artists") {
        const agg = new Map<string, { plays: number; ms: number }>();
        for (const s of stats.values()) {
            const a = agg.get(s.artist) ?? { plays: 0, ms: 0 };
            a.plays += s.plays;
            a.ms += s.msPlayed;
            agg.set(s.artist, a);
        }

        rows = [...agg.entries()]
            .sort((a, b) => b[1].plays - a[1].plays)
            .slice(0, top)
            .map(([label, a]) => ({ label, plays: a.plays, hours: +(a.ms / 3600000).toFixed(1) }));
    } else {
        // Genres only exist for liked tracks, so this ranks the liked subset by real listening.
        const agg = new Map<string, { plays: number; ms: number; tracks: number }>();
        for (const t of tracks) {
            if (!t.myPlays) {
                continue;
            }

            // Read the millisecond total back from `stats`, not from `myHours`: that field is
            // rounded to two decimals, and multiplying it back out drifts by up to 18 seconds
            // per track, which accumulates across a whole genre.
            const ms = stats.get(t.uri)?.msPlayed ?? 0;
            for (const g of t.genres ?? []) {
                const a = agg.get(g) ?? { plays: 0, ms: 0, tracks: 0 };
                a.plays += t.myPlays;
                a.ms += ms;
                a.tracks++;
                agg.set(g, a);
            }
        }

        rows = [...agg.entries()]
            .sort((a, b) => b[1].plays - a[1].plays)
            .slice(0, top)
            .map(([label, a]) => ({ label, plays: a.plays, hours: +(a.ms / 3600000).toFixed(1), extra: a.tracks }));
    }

    return {
        files: files.length,
        events,
        eventsWithoutUri: noUri,
        since,
        distinctTracks: stats.size,
        totalPlays,
        totalHours: +totalHours.toFixed(1),
        library: { total: tracks.length, matched },
        by,
        rows,
    };
}
