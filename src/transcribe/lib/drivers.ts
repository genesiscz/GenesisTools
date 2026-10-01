/**
 * Classify a transcribe input into a local file or one of three URL drivers.
 * YouTube and X need their own drivers because the page is not the media file.
 * Everything else that is already a media URL is the direct driver.
 */

const YOUTUBE_ID = /^[a-zA-Z0-9_-]{11}$/;

const MEDIA_EXTENSIONS = new Set([
    ".mp3",
    ".wav",
    ".m4a",
    ".aac",
    ".ogg",
    ".flac",
    ".wma",
    ".aiff",
    ".webm",
    ".opus",
    ".qta",
    ".mov",
    ".mp4",
    ".m4v",
    ".mkv",
    ".m3u8",
]);

/** Containers the transcriber accepts without an ffmpeg pass. Video goes through mono MP3 first. */
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus", ".aiff"]);

export interface YoutubeSource {
    driver: "youtube";
    videoId: string;
}

export interface XSource {
    driver: "x";
    statusId: string;
    url: string;
}

export interface DirectSource {
    driver: "direct";
    url: string;
}

export interface LocalSource {
    driver: "local";
}

export interface UnsupportedSource {
    driver: "unsupported";
    url: string;
    reason: string;
}

export type ClassifiedSource = YoutubeSource | XSource | DirectSource | LocalSource | UnsupportedSource;

export type RemoteSource = XSource | DirectSource;

export function isAudioExtension(ext: string): boolean {
    return AUDIO_EXTENSIONS.has(ext.toLowerCase());
}

export function classifySource(input: string): ClassifiedSource {
    const trimmed = input.trim();

    if (!/^https?:\/\//i.test(trimmed)) {
        if (YOUTUBE_ID.test(trimmed)) {
            return { driver: "youtube", videoId: trimmed };
        }

        return { driver: "local" };
    }

    let url: URL;

    try {
        url = new URL(trimmed);
    } catch {
        return { driver: "local" };
    }

    const host = url.hostname.toLowerCase().replace(/^www\./, "");

    if (isYoutubeHost(host)) {
        const videoId = youtubeIdFromUrl(url, host);

        if (!videoId) {
            return {
                driver: "unsupported",
                url: trimmed,
                reason: "That YouTube URL has no video id. Pass a watch, shorts, or youtu.be link.",
            };
        }

        return { driver: "youtube", videoId };
    }

    if (isXHost(host)) {
        const statusId = xStatusId(url);

        if (!statusId) {
            return {
                driver: "unsupported",
                url: trimmed,
                reason: "That X link is not a post. Pass the status URL, for example https://x.com/user/status/123.",
            };
        }

        return { driver: "x", statusId, url: trimmed };
    }

    return { driver: "direct", url: trimmed };
}

export function xSyndicationUrl(statusId: string): string {
    return `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(statusId)}&token=0`;
}

export interface MediaVariant {
    url: string;
    bitrate: number;
}

/**
 * Length of the video in the post, from syndication metadata.
 * `duration_millis` is the field Twitter actually sends. No media is downloaded.
 */
export function xDurationSec(payload: unknown): number | null {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    const record = payload as {
        mediaDetails?: unknown;
        video?: { durationMs?: unknown };
    };
    const fromVideo = positiveMillis(record.video?.durationMs);

    if (fromVideo !== null) {
        return fromVideo;
    }

    if (!Array.isArray(record.mediaDetails)) {
        return null;
    }

    for (const item of record.mediaDetails) {
        if (!item || typeof item !== "object") {
            continue;
        }

        const millis = (item as { video_info?: { duration_millis?: unknown } }).video_info?.duration_millis;
        const seconds = positiveMillis(millis);

        if (seconds !== null) {
            return seconds;
        }
    }

    return null;
}

function positiveMillis(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return null;
    }

    return value / 1000;
}

/** Lowest-bitrate progressive MP4. Speech transcription does not need the largest rendition. */
export function pickMp4Variant(payload: unknown): MediaVariant | null {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    const details = (payload as { mediaDetails?: unknown }).mediaDetails;

    if (!Array.isArray(details)) {
        return null;
    }

    let best: MediaVariant | null = null;

    for (const item of details) {
        if (!item || typeof item !== "object") {
            continue;
        }

        const variants = (item as { video_info?: { variants?: unknown } }).video_info?.variants;

        if (!Array.isArray(variants)) {
            continue;
        }

        for (const variant of variants) {
            const picked = asMp4(variant);

            if (!picked) {
                continue;
            }

            if (!best || picked.bitrate < best.bitrate) {
                best = picked;
            }
        }

        // The renditions of ONE video: a post with several videos must not mix one video's
        // lowest bitrate with another's. The first video with an MP4 rendition is the one.
        if (best) {
            return best;
        }
    }

    return best;
}

export function extensionOf(url: string): string {
    try {
        const path = new URL(url).pathname;
        const dot = path.lastIndexOf(".");

        if (dot === -1) {
            return "";
        }

        return path.slice(dot).toLowerCase();
    } catch {
        return "";
    }
}

export function isMediaExtension(ext: string): boolean {
    return MEDIA_EXTENSIONS.has(ext.toLowerCase());
}

export function isHls(url: string): boolean {
    return extensionOf(url) === ".m3u8";
}

/** True when a response body is worth saving as media. Extensionless URLs must say so in Content-Type. */
export function contentTypeIsMedia(contentType: string | null): boolean {
    const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

    return (
        type.startsWith("audio/") ||
        type.startsWith("video/") ||
        type === "application/mp4" ||
        type === "application/vnd.apple.mpegurl" ||
        type === "application/x-mpegurl"
    );
}

function asMp4(variant: unknown): MediaVariant | null {
    if (!variant || typeof variant !== "object") {
        return null;
    }

    const record = variant as { content_type?: unknown; bitrate?: unknown; url?: unknown };

    if (record.content_type !== "video/mp4" || typeof record.url !== "string" || !record.url.startsWith("https://")) {
        return null;
    }

    const bitrate = typeof record.bitrate === "number" && record.bitrate > 0 ? record.bitrate : Number.MAX_SAFE_INTEGER;

    return { url: record.url, bitrate };
}

function isYoutubeHost(host: string): boolean {
    return (
        host === "youtu.be" ||
        host === "youtube.com" ||
        host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com" ||
        host.endsWith(".youtube-nocookie.com")
    );
}

function isXHost(host: string): boolean {
    return host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com");
}

function youtubeIdFromUrl(url: URL, host: string): string | null {
    if (host === "youtu.be") {
        const id = url.pathname.split("/").filter(Boolean)[0] ?? "";

        return YOUTUBE_ID.test(id) ? id : null;
    }

    const fromQuery = url.searchParams.get("v") ?? "";

    if (YOUTUBE_ID.test(fromQuery)) {
        return fromQuery;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    const marker = parts.findIndex((part) => part === "shorts" || part === "embed" || part === "live" || part === "v");
    const id = marker === -1 ? "" : (parts[marker + 1] ?? "");

    return YOUTUBE_ID.test(id) ? id : null;
}

function xStatusId(url: URL): string | null {
    const match = url.pathname.match(/\/status(?:es)?\/(\d+)/);

    return match?.[1] ?? null;
}
