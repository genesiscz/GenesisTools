/**
 * `harvest --artists`: the artist catalogue that lets Discover name songs you never played.
 *
 * Takes the top picks of every Discover method that carry an artist URI, skips the ones the
 * catalogue already holds, reads the rest and merges them into the catalogue on disk. By default
 * the reads go to Spotify's public embed pages (no browser, no login, top tracks only); with `auto`
 * they go through the signed-in web player, which adds play counts, covers and releases.
 *
 * Every decision lives here; the CLI only parses flags and renders the result.
 */
import { autoHarvestArtists } from "@app/spotify/lib/browser/harvest";
import { loadCatalog, saveHarvestedArtists } from "@app/spotify/lib/catalog";
import { fetchEmbedArtists } from "@app/spotify/lib/embed";
import { int } from "@app/spotify/lib/format";
import { catalogPath } from "@app/spotify/lib/paths";
import { catalogCandidates, RECOMMEND_METHODS } from "@app/spotify/lib/reports/recommend";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "spotify:catalog-harvest" });

export interface CatalogHarvestOptions {
    profile?: string;
    /** How many picks of each Discover method to cover. */
    perMethod: number;
    /** Read through the signed-in web player. Also upgrades artists that so far only have embed data. */
    auto: boolean;
    /** Fetch artists that are already in the catalogue again. */
    refresh: boolean;
    /** CDP endpoint of the signed-in browser; only `auto` uses it. */
    browserUrl: string;
    onLog: (line: string) => void;
}

export interface CatalogHarvestResult {
    /**
     * `no-candidates`: no pick carries an artist URI. The URIs come from the Liked Songs library, so
     * without one there is nothing to fetch. `up-to-date`: the catalogue already holds every pick.
     * `fetched`: the missing picks were read and merged into the catalogue.
     */
    status: "no-candidates" | "up-to-date" | "fetched";
    /** Discover picks that carry an artist URI. */
    candidates: number;
    /** Picks the catalogue already had, which were not fetched again. */
    cached: number;
    requested: number;
    fetched: number;
    errors: { uri: string; error: string }[];
    /** The catalogue file. */
    out: string;
}

export async function harvestArtistCatalog(o: CatalogHarvestOptions): Promise<CatalogHarvestResult> {
    const candidates = catalogCandidates({
        profile: o.profile,
        methods: RECOMMEND_METHODS.map((m) => m.id),
        perMethod: o.perMethod,
    });
    const idle = { requested: 0, fetched: 0, errors: [], out: catalogPath() };

    if (!candidates.length) {
        log.info({ profile: o.profile }, "no Discover pick carries an artist URI; nothing to fetch");

        return { status: "no-candidates", candidates: 0, cached: 0, ...idle };
    }

    // A snapshot is enough to decide what to fetch. The save re-reads the file under a lock.
    const catalog = loadCatalog();
    const todo = candidates.filter((uri) => {
        const entry = catalog.artists[uri];

        return o.refresh || !entry || (o.auto && entry.source === "embed");
    });
    const cached = candidates.length - todo.length;

    if (!todo.length) {
        return { status: "up-to-date", candidates: candidates.length, cached, ...idle };
    }

    o.onLog(`${int(todo.length)} artists to fetch, ${int(cached)} already in the catalogue`);
    log.info({ profile: o.profile, todo: todo.length, cached, auto: o.auto }, "artist harvest starting");

    const harvested = o.auto
        ? await autoHarvestArtists({ browserUrl: o.browserUrl, onLog: o.onLog, artistUris: todo }).then((r) => ({
              ...r,
              artists: r.artists.map((a) => ({ ...a, source: "web-player" as const })),
          }))
        : await fetchEmbedArtists({ artistUris: todo, onLog: o.onLog });
    const path = await saveHarvestedArtists({ harvested: harvested.artists, fetchedAt: new Date() });

    return {
        status: "fetched",
        candidates: candidates.length,
        cached,
        requested: harvested.requested,
        fetched: harvested.fetched,
        errors: harvested.errors,
        out: path,
    };
}
