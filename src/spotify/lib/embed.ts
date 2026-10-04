/**
 * Artist top tracks without a browser, a login or a token: the public page Spotify serves for its
 * "embed this artist" iframe (`open.spotify.com/embed/artist/<id>`). Its `__NEXT_DATA__` carries the
 * artist's top tracks (title, URI) in the same order as the app's "Popular" list.
 *
 * It does NOT carry global play counts, per-track covers or popular releases. `harvest --artists
 * --auto` reads those through the signed-in web player, and an embed entry never replaces one
 * (`mergeCatalog`). The official Web API is no alternative: Spotify removed artist top tracks for
 * development-mode apps in February 2026 (references/official-web-api.md in the spotify skill).
 */
import type { CatalogArtist } from "@app/spotify/lib/catalog";
import { getText, Pacer } from "@app/spotify/lib/io";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";

const log = logger.child({ component: "spotify:embed" });

/** Spotify serves a bare error page to unknown clients, so ask like a browser does. */
const BROWSER_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

/** A plain public page, but still Spotify's: one request a second, like the web-player harvest. */
const PACE_MS = 1000;

const EmbedPageSchema = z.object({
    props: z.object({
        pageProps: z.object({
            state: z.object({
                data: z.object({
                    entity: z.object({
                        name: z.string(),
                        uri: z.string(),
                        trackList: z.array(z.object({ uri: z.string(), title: z.string() })),
                    }),
                }),
            }),
        }),
    }),
});

export function embedUrl(artistUri: string): string {
    return `https://open.spotify.com/embed/artist/${artistUri.replace(/^spotify:artist:/, "")}`;
}

/** The catalogue entry an embed page describes, or null when the page is not an artist embed. */
export function parseEmbedArtist(html: string): Omit<CatalogArtist, "fetchedAt"> | null {
    const json = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];
    if (!json) {
        return null;
    }

    let data: unknown;
    try {
        data = SafeJSON.parse(json, { strict: true });
    } catch (error) {
        log.debug({ error }, "embed page JSON did not parse");
        return null;
    }

    const parsed = EmbedPageSchema.safeParse(data);
    if (!parsed.success) {
        return null;
    }

    const entity = parsed.data.props.pageProps.state.data.entity;

    return {
        uri: entity.uri,
        name: entity.name,
        source: "embed",
        topTracks: entity.trackList.map((t) => ({
            uri: t.uri,
            name: t.title,
            playcount: null,
            albumUri: null,
            cover: null,
        })),
        popularReleases: [],
    };
}

export interface EmbedHarvestResult {
    requested: number;
    fetched: number;
    errors: { uri: string; error: string }[];
    artists: Omit<CatalogArtist, "fetchedAt">[];
}

export async function fetchEmbedArtists({
    artistUris,
    onLog,
}: {
    artistUris: string[];
    onLog: (line: string) => void;
}): Promise<EmbedHarvestResult> {
    const pacer = new Pacer(PACE_MS);
    const artists: Omit<CatalogArtist, "fetchedAt">[] = [];
    const errors: { uri: string; error: string }[] = [];

    for (const [i, uri] of artistUris.entries()) {
        await pacer.wait();
        const res = await getText(embedUrl(uri), {
            headers: { "user-agent": BROWSER_UA, "accept-language": "en" },
            tries: 3,
            fatal: [404],
            timeoutMs: 15_000,
        });

        if (!res.ok) {
            errors.push({ uri, error: res.error });
            continue;
        }

        const artist = parseEmbedArtist(res.body);
        if (artist) {
            artists.push(artist);
        } else {
            errors.push({ uri, error: "the embed page carried no artist track list" });
        }

        if ((i + 1) % 25 === 0) {
            onLog(`${i + 1}/${artistUris.length} artist pages read`);
        }
    }

    log.info(
        { requested: artistUris.length, fetched: artists.length, errors: errors.length },
        "embed harvest finished"
    );

    return { requested: artistUris.length, fetched: artists.length, errors, artists };
}
