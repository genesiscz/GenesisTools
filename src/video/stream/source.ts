import { type HlsMediaPlaylist, type HlsPlaylist, type HlsVariant, parsePlaylist } from "@genesiscz/utils/hls/playlist";
import { logger } from "@genesiscz/utils/logger";

/** A browser user agent for a bare playlist URL: some CDNs refuse Bun's own. */
const FALLBACK_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

const PLAYLIST_TIMEOUT_MS = 20_000;

export interface StreamSource {
    playlistUrl: string;
    headers: Record<string, string>;
    /** The page that played it, from the HAR. */
    page?: string;
}

export class PlaylistHttpError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
        this.name = "PlaylistHttpError";
    }
}

/** The URL without its query, which often carries a token: safe for logs and messages. */
export function safeUrl(url: string): string {
    const queryAt = url.indexOf("?");
    return queryAt === -1 ? url : `${url.slice(0, queryAt)}?…`;
}

/** Headers that carry the user's credentials; a HAR captured them for one origin. */
const CREDENTIAL_HEADERS = ["cookie", "authorization"];

function originOf(url: string): string | null {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

/**
 * The source's headers for a request to `url`: all of them on the playlist's own origin, and without the cookies and
 * the Authorization header anywhere else, so a playlist that points at another host (a second CDN, or a hostile one)
 * never receives credentials captured for the first.
 */
export function headersFor(url: string, source: Pick<StreamSource, "playlistUrl" | "headers">): Record<string, string> {
    const target = originOf(url);

    if (target !== null && target === originOf(source.playlistUrl)) {
        return source.headers;
    }

    const scoped = { ...source.headers };

    for (const name of CREDENTIAL_HEADERS) {
        delete scoped[name];
    }

    return scoped;
}

export function withDefaultHeaders(headers: Record<string, string>): Record<string, string> {
    return headers["user-agent"] ? headers : { ...headers, "user-agent": FALLBACK_USER_AGENT };
}

export async function fetchPlaylist({
    url,
    headers,
    signal,
}: {
    url: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
}): Promise<HlsPlaylist> {
    const timeout = AbortSignal.timeout(PLAYLIST_TIMEOUT_MS);
    const response = await fetch(url, {
        headers,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    if (!response.ok) {
        throw new PlaylistHttpError(`Playlist ${safeUrl(url)} answered HTTP ${response.status}`, response.status);
    }

    return parsePlaylist(await response.text(), response.url || url);
}

export function parseHeaderFlags(flags: string[]): Record<string, string> {
    const headers: Record<string, string> = {};

    for (const flag of flags) {
        const colon = flag.indexOf(":");

        if (colon < 1) {
            throw new Error(`--header must look like "Name: value", got "${flag}"`);
        }

        headers[flag.slice(0, colon).trim().toLowerCase()] = flag.slice(colon + 1).trim();
    }

    return headers;
}

/** `best` (highest bandwidth, the default), `worst`, or a height such as `720` or `720p`. */
export function chooseVariant(variants: HlsVariant[], quality: string): HlsVariant {
    const byBandwidth = [...variants].sort((a, b) => b.bandwidth - a.bandwidth);
    const wanted = quality.toLowerCase();

    if (wanted === "best") {
        return byBandwidth[0];
    }

    if (wanted === "worst") {
        return byBandwidth[byBandwidth.length - 1];
    }

    const height = Number(wanted.replace(/p$/, ""));
    const match = byBandwidth.find((variant) => variant.height === height);

    if (!match) {
        const offered = byBandwidth.map((variant) => (variant.height ? `${variant.height}p` : variant.uri)).join(", ");
        throw new Error(`--quality ${quality} matches no variant. Offered: best, worst, ${offered}`);
    }

    return match;
}

export interface ResolvedMedia {
    mediaUrl: string;
    playlist: HlsMediaPlaylist;
    variant?: HlsVariant;
}

/** Follows a master playlist to the chosen variant's media playlist, and refuses what the downloader cannot stitch. */
export async function resolveMedia({
    source,
    quality,
    signal,
}: {
    source: StreamSource;
    quality: string;
    signal?: AbortSignal;
}): Promise<ResolvedMedia> {
    const first = await fetchPlaylist({ url: source.playlistUrl, headers: source.headers, signal });
    let resolved: ResolvedMedia;

    if (first.kind === "master") {
        if (first.variants.length === 0) {
            throw new Error(`The master playlist ${safeUrl(source.playlistUrl)} lists no variant`);
        }

        const variant = chooseVariant(first.variants, quality);

        if (variant.audioGroup && first.separateAudioGroups.includes(variant.audioGroup)) {
            throw new Error(
                "This stream keeps its audio in a separate playlist, which this downloader does not merge yet. Try yt-dlp on the master playlist URL."
            );
        }

        const media = await fetchPlaylist({ url: variant.uri, headers: headersFor(variant.uri, source), signal });

        if (media.kind !== "media") {
            throw new Error(`The variant ${safeUrl(variant.uri)} is another master playlist`);
        }

        resolved = { mediaUrl: variant.uri, playlist: media, variant };
    } else {
        resolved = { mediaUrl: source.playlistUrl, playlist: first };
    }

    if (resolved.playlist.encryption) {
        throw new Error(
            `The segments are encrypted (${resolved.playlist.encryption}); this downloader does not decrypt.`
        );
    }

    if (resolved.playlist.usesByteRanges) {
        throw new Error("The playlist addresses segments by byte range; this downloader does not support that.");
    }

    logger.debug(
        {
            media: safeUrl(resolved.mediaUrl),
            height: resolved.variant?.height,
            ended: resolved.playlist.ended,
            segments: resolved.playlist.segments.length,
            mediaSequence: resolved.playlist.mediaSequence,
        },
        "HLS media playlist resolved"
    );
    return resolved;
}
