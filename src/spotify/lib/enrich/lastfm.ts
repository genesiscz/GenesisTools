/**
 * Attach Last.fm community tags to every artist in the library.
 *
 * Reads  <dir>/artists.json      { all: {uri: name}, lastYear: {uri: name} }
 * Writes <dir>/lf_artists.jsonl  one row per artist, resumable
 *
 * With an API key (flag or `LASTFM_API_KEY`) this uses the documented artist.getTopTags
 * endpoint, which returns tags with weights and is allowed ~5 req/s. Without a key it falls
 * back to reading the public /+tags page, which carries the same tag cloud in HTML — that is
 * what beets and similar tools do, and it needs no registration.
 *
 * Last.fm matches on artist NAME only, so a name collision attaches the wrong artist's tags
 * ("Ripple" comes back funk/soul/disco). That is why the genre merge filters these tags
 * through a vocabulary and prefers MusicBrainz where both have an opinion.
 */
import { join } from "node:path";
import { loadArtistIndex } from "@app/spotify/lib/enrich/build-artist-index";
import type { EnrichOptions, EnrichResult } from "@app/spotify/lib/enrich/types";
import { appendJsonl, cachedKeys, getText, Pacer } from "@app/spotify/lib/io";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "spotify:enrich:lastfm" });

const BROWSER_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36";

async function viaApi(name: string, key: string): Promise<unknown> {
    const u = `https://ws.audioscrobbler.com/2.0/?method=artist.gettoptags&artist=${encodeURIComponent(name)}&api_key=${key}&format=json`;
    const res = await getText(u, { headers: { "User-Agent": BROWSER_UA } });
    if (!res.ok) {
        return { error: res.error };
    }

    const j = SafeJSON.parse(res.body) as {
        error?: number;
        message?: string;
        toptags?: { tag?: { name: string; count: number } | { name: string; count: number }[] };
    };
    if (j.error) {
        return { error: `lastfm ${j.error}: ${j.message}` };
    }

    const raw = j.toptags?.tag ?? [];
    const list = Array.isArray(raw) ? raw : [raw];

    return { tags: list.map((t) => t.name.toLowerCase()), weighted: true };
}

async function viaHtml(name: string): Promise<unknown> {
    const u = `https://www.last.fm/music/${encodeURIComponent(name.replace(/ /g, "+")).replace(/%2B/g, "+")}/+tags`;
    // 502 here usually means "no such artist page", not an outage, so do not burn retries on
    // it — that alone tripled the crawl time on the first run. It has to appear in BOTH lists
    // to mean that: `fatal` stops the retries, and the result must then read as an empty tag
    // set rather than an error, or the artist is written to the resumable cache as failed and
    // never retried on a later run either.
    const res = await getText(u, {
        headers: { "User-Agent": BROWSER_UA },
        tries: 2,
        fatal: [404, 502],
        backoffMs: 1500,
    });
    if (!res.ok) {
        return res.status === 404 || res.status === 502 ? { tags: [], note: "no page" } : { error: res.error };
    }

    const seen = new Set<string>();
    const tags: string[] = [];
    for (const m of res.body.matchAll(/href="\/tag\/([^"?#]+)"/g)) {
        const tag = decodeURIComponent(m[1]!.replace(/\+/g, " ")).trim().toLowerCase();
        if (tag && !seen.has(tag)) {
            seen.add(tag);
            tags.push(tag);
        }
    }

    return { tags, weighted: false };
}

export interface LastfmEnrichOptions extends EnrichOptions {
    apiKey?: string;
}

export async function enrichLastfm(opts: LastfmEnrichOptions): Promise<EnrichResult & { mode: "api" | "html" }> {
    const dir = opts.dataDir;
    const key = opts.apiKey ?? env.spotify.getLastfmApiKey();
    const cache = join(dir, "lf_artists.jsonl");
    const idx = loadArtistIndex(dir, opts.profile);

    const order = [
        ...Object.entries(idx.lastYear),
        ...Object.entries(idx.all).filter(([uri]) => !(uri in idx.lastYear)),
    ];
    const done = cachedKeys(cache);
    let todo = order.filter(([uri]) => !done.has(uri));
    if (opts.limit) {
        todo = todo.slice(0, opts.limit);
    }

    const mode = key ? "api" : "html";
    log.info({ mode, total: order.length, cached: done.size, todo: todo.length }, "lastfm crawl starting");

    const pacer = new Pacer(key ? 250 : 1000);
    for (const [i, entry] of todo.entries()) {
        const [uri, name] = entry;
        await pacer.wait();
        let lf: unknown;
        try {
            lf = key ? await viaApi(name, key) : await viaHtml(name);
        } catch (err) {
            log.debug({ uri, name, err }, "lastfm lookup threw");
            lf = { error: String(err) };
        }

        appendJsonl(cache, { uri, name, lf });

        if ((i + 1) % 25 === 0 || i + 1 === todo.length) {
            opts.onProgress?.(i + 1, todo.length);
        }
    }

    return { total: order.length, cached: done.size, fetched: todo.length, mode };
}
