/**
 * Attach MusicBrainz tags to every artist in the library.
 *
 * Reads  <dir>/artists.json      { all: {uri: name}, lastYear: {uri: name} }
 * Writes <dir>/mb_artists.jsonl  one row per artist, resumable
 *
 * MusicBrainz asks for one request per second and a User-Agent that identifies you.
 * Both are honoured here. Expect roughly 50 minutes for 3000 artists.
 *
 * Precision over recall, enforced downstream. This crawl records the best candidate along
 * with `exact` (the normalised name matched) and `score`; the gate — accept tags only when
 * `exact` and `score >= 90` — lives in `lib/genres`' resolver and in `merge-genres.ts`,
 * because keeping the raw answer on disk means the threshold can be re-tuned without
 * re-crawling. MusicBrainz search is fuzzy enough that "Ripple" or "Gemini" otherwise
 * returns a completely different artist, and a wrong genre is worse than a missing one.
 * Expect only ~40% of artists to clear the gate — the gap is what the Last.fm enricher fills.
 */
import { join } from "node:path";
import { loadArtistIndex } from "@app/spotify/lib/enrich/build-artist-index";
import type { EnrichOptions, EnrichResult } from "@app/spotify/lib/enrich/types";
import { appendJsonl, cachedKeys, getText, Pacer } from "@app/spotify/lib/io";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "spotify:enrich:musicbrainz" });

const UA = "GenesisToolsSpotifyStats/1.0 ( https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting )";
const MIN_INTERVAL_MS = 1100;

interface MbTag {
    name: string;
    count: number;
}

interface MbArtist {
    id: string;
    name: string;
    score: number;
    type?: string;
    country?: string;
    tags?: MbTag[];
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function lookup(name: string): Promise<unknown> {
    const q = encodeURIComponent(`artist:"${name.replace(/"/g, "")}"`);
    const res = await getText(`https://musicbrainz.org/ws/2/artist?query=${q}&limit=3&fmt=json`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        backoffMs: 3000,
    });
    if (!res.ok) {
        return { error: res.error };
    }

    const cands = ((SafeJSON.parse(res.body) as { artists?: MbArtist[] }).artists ?? []) as MbArtist[];
    if (!cands.length) {
        return null;
    }

    const want = normalise(name);
    const exact = cands.filter((c) => normalise(c.name) === want);
    const c = (exact[0] ?? cands[0])!;

    return {
        mbid: c.id,
        mbName: c.name,
        score: c.score,
        exact: exact.length > 0,
        type: c.type ?? null,
        country: c.country ?? null,
        tags: (c.tags ?? []).slice().sort((a, b) => b.count - a.count),
    };
}

export async function enrichMusicbrainz(opts: EnrichOptions): Promise<EnrichResult> {
    const dir = opts.dataDir;
    const cache = join(dir, "mb_artists.jsonl");
    const idx = loadArtistIndex(dir, opts.profile);

    // Last year's artists first: that subset is usually what a question is actually about,
    // so it becomes answerable long before the full crawl finishes.
    const order = [
        ...Object.entries(idx.lastYear),
        ...Object.entries(idx.all).filter(([uri]) => !(uri in idx.lastYear)),
    ];
    const done = cachedKeys(cache);
    let todo = order.filter(([uri]) => !done.has(uri));
    if (opts.limit) {
        todo = todo.slice(0, opts.limit);
    }

    log.info({ total: order.length, cached: done.size, todo: todo.length }, "musicbrainz crawl starting");

    const pacer = new Pacer(MIN_INTERVAL_MS);
    for (const [i, entry] of todo.entries()) {
        const [uri, name] = entry;
        await pacer.wait();
        let mb: unknown = null;
        try {
            mb = await lookup(name);
        } catch (err) {
            log.debug({ uri, name, err }, "musicbrainz lookup threw");
            mb = { error: String(err) };
        }

        appendJsonl(cache, { uri, name, mb });

        if ((i + 1) % 25 === 0 || i + 1 === todo.length) {
            opts.onProgress?.(i + 1, todo.length);
        }
    }

    return { total: order.length, cached: done.size, fetched: todo.length };
}
