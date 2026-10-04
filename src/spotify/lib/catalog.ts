/**
 * The artist catalogue: what Spotify's own artist pages list for the artists Discover picked,
 * harvested from the signed-in web player by `harvest --artists --auto`. It is the only source
 * here that knows songs you have never played, so Discover can recommend them.
 *
 * One JSON file for the tool (`catalogPath()`), shared by every profile: artist pages are public
 * data. A harvest adds or refreshes the artists it fetched and keeps every other entry, so runs
 * for different methods and profiles build one catalogue and nothing is fetched twice.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { catalogPath } from "@app/spotify/lib/paths";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

const log = logger.child({ component: "spotify:catalog" });

/**
 * The lock only covers a read, a merge and a write, so it is held for milliseconds. The wait is
 * generous anyway: giving up here would throw away a crawl that took minutes.
 */
const CATALOG_LOCK_TIMEOUT_MS = 30_000;

export interface CatalogTrack {
    uri: string;
    name: string;
    /** Global stream count, the same number the library harvest records. */
    playcount: number | null;
    albumUri: string | null;
    cover: string | null;
}

export interface CatalogRelease {
    uri: string;
    name: string;
    /** ALBUM, SINGLE, EP, COMPILATION as Spotify labels it. */
    type: string | null;
    year: number | null;
    tracks: number | null;
    cover: string | null;
}

export interface CatalogArtist {
    uri: string;
    name: string | null;
    fetchedAt: string;
    /**
     * `web-player`: read through the signed-in browser (`--auto`), with play counts, covers and
     * releases. `embed`: the public embed page, top tracks only. Entries written before this
     * field existed came from the web player.
     */
    source?: "web-player" | "embed";
    topTracks: CatalogTrack[];
    popularReleases: CatalogRelease[];
}

export interface ArtistCatalog {
    version: 1;
    artists: Record<string, CatalogArtist>;
}

export const emptyCatalog = (): ArtistCatalog => ({ version: 1, artists: {} });

export function loadCatalog(path = catalogPath()): ArtistCatalog {
    if (!existsSync(path)) {
        return emptyCatalog();
    }

    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"));
        if (isCatalog(parsed)) {
            return parsed;
        }

        log.warn({ path }, "artist catalogue has an unexpected shape; treating it as empty");
    } catch (error) {
        log.warn({ path, error }, "could not read the artist catalogue; treating it as empty");
    }

    return emptyCatalog();
}

function isCatalog(value: unknown): value is ArtistCatalog {
    return (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version === 1 &&
        "artists" in value &&
        typeof value.artists === "object" &&
        value.artists !== null
    );
}

/** The poorer embed data never replaces what the web player returned. */
const richer = (entry: CatalogArtist | undefined) => entry !== undefined && entry.source !== "embed";

/**
 * Adds or replaces the harvested artists; everything else in the catalogue stays. An `embed`
 * entry does not replace a `web-player` one: it would drop the play counts, covers and releases.
 */
export function mergeCatalog(
    catalog: ArtistCatalog,
    harvested: Omit<CatalogArtist, "fetchedAt">[],
    fetchedAt: Date
): ArtistCatalog {
    const artists = { ...catalog.artists };
    for (const a of harvested) {
        if (a.source === "embed" && richer(artists[a.uri])) {
            continue;
        }

        artists[a.uri] = { ...a, fetchedAt: fetchedAt.toISOString() };
    }

    return { version: 1, artists };
}

/**
 * Atomic (temp file plus rename), because the file is every earlier harvest's work: a plain write
 * truncates first, and an interruption between truncate and write would leave it empty.
 */
export function saveCatalog(catalog: ArtistCatalog, path = catalogPath()): string {
    atomicWriteFileSync(path, `${SafeJSON.stringify(catalog, null, 2)}\n`);
    log.info({ path, artists: Object.keys(catalog.artists).length }, "artist catalogue written");

    return path;
}

/**
 * Merges freshly harvested artists into the catalogue AS IT IS ON DISK NOW, under a lock, and
 * writes it atomically. A harvest crawls for minutes. Merging into the copy it read before the
 * crawl would drop what another harvest (another profile, or a web-player run) wrote meanwhile,
 * and would let a slow embed run put its poorer entry over a web-player one that landed during
 * the crawl. Re-reading at save time lets `mergeCatalog` see both.
 */
export async function saveHarvestedArtists({
    harvested,
    fetchedAt,
    path = catalogPath(),
}: {
    harvested: Omit<CatalogArtist, "fetchedAt">[];
    fetchedAt: Date;
    path?: string;
}): Promise<string> {
    mkdirSync(dirname(path), { recursive: true });

    return withFileLock(
        `${path}.lock`,
        async () => saveCatalog(mergeCatalog(loadCatalog(path), harvested, fetchedAt), path),
        CATALOG_LOCK_TIMEOUT_MS
    );
}
