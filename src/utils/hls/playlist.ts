/** HLS (RFC 8216) playlist parsing: the subset a downloader needs. URIs come back absolute. */

export interface HlsVariant {
    uri: string;
    bandwidth: number;
    width?: number;
    height?: number;
    /** `EXT-X-STREAM-INF` AUDIO group id, when the variant names one. */
    audioGroup?: string;
}

export interface HlsMasterPlaylist {
    kind: "master";
    variants: HlsVariant[];
    /** Audio groups whose renditions are separate playlists (a URI on `EXT-X-MEDIA:TYPE=AUDIO`). */
    separateAudioGroups: string[];
}

export interface HlsSegment {
    sequence: number;
    uri: string;
    durationSec: number;
}

export interface HlsMediaPlaylist {
    kind: "media";
    targetDurationSec: number;
    mediaSequence: number;
    segments: HlsSegment[];
    /** `EXT-X-ENDLIST` is present: no segment will be added. */
    ended: boolean;
    /** Only from the tag: a live playlist that ended keeps listing just its last window, so ENDLIST does not set it. */
    playlistType?: "EVENT" | "VOD";
    /** `EXT-X-MAP` URI: the fMP4 init segment that goes before the first fragment. */
    initUri?: string;
    /** `EXT-X-KEY` METHOD other than NONE. */
    encryption?: string;
    usesByteRanges: boolean;
}

export type HlsPlaylist = HlsMasterPlaylist | HlsMediaPlaylist;

export function isPlaylistText(text: string): boolean {
    return text.trimStart().startsWith("#EXTM3U");
}

export function parseAttributes(list: string): Record<string, string> {
    const attributes: Record<string, string> = {};

    for (const match of list.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
        const raw = match[2];
        attributes[match[1]] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
    }

    return attributes;
}

function tagValue(line: string): string {
    return line.slice(line.indexOf(":") + 1);
}

export function parsePlaylist(text: string, baseUrl: string): HlsPlaylist {
    if (!isPlaylistText(text)) {
        throw new Error("Not an HLS playlist: the text does not start with #EXTM3U");
    }

    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    if (lines.some((line) => line.startsWith("#EXT-X-STREAM-INF"))) {
        return parseMaster(lines, baseUrl);
    }

    return parseMedia(lines, baseUrl);
}

function parseMaster(lines: string[], baseUrl: string): HlsMasterPlaylist {
    const variants: HlsVariant[] = [];
    const separateAudioGroups = new Set<string>();
    let pending: Record<string, string> | null = null;

    for (const line of lines) {
        if (line.startsWith("#EXT-X-MEDIA:")) {
            const media = parseAttributes(tagValue(line));

            if (media.TYPE === "AUDIO" && media.URI && media["GROUP-ID"]) {
                separateAudioGroups.add(media["GROUP-ID"]);
            }

            continue;
        }

        if (line.startsWith("#EXT-X-STREAM-INF:")) {
            pending = parseAttributes(tagValue(line));
            continue;
        }

        if (line.startsWith("#") || !pending) {
            continue;
        }

        const [width, height] = (pending.RESOLUTION ?? "").split("x").map(Number);
        variants.push({
            uri: new URL(line, baseUrl).href,
            bandwidth: Number(pending.BANDWIDTH) || 0,
            width: Number.isFinite(width) && width > 0 ? width : undefined,
            height: Number.isFinite(height) && height > 0 ? height : undefined,
            audioGroup: pending.AUDIO,
        });
        pending = null;
    }

    return { kind: "master", variants, separateAudioGroups: [...separateAudioGroups] };
}

function parseMedia(lines: string[], baseUrl: string): HlsMediaPlaylist {
    const playlist: HlsMediaPlaylist = {
        kind: "media",
        targetDurationSec: 0,
        mediaSequence: 0,
        segments: [],
        ended: false,
        usesByteRanges: false,
    };
    let duration: number | null = null;

    for (const line of lines) {
        if (line.startsWith("#EXT-X-TARGETDURATION:")) {
            playlist.targetDurationSec = Number(tagValue(line)) || 0;
        } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
            playlist.mediaSequence = Number(tagValue(line)) || 0;
        } else if (line.startsWith("#EXT-X-ENDLIST")) {
            playlist.ended = true;
        } else if (line.startsWith("#EXT-X-PLAYLIST-TYPE:")) {
            const type = tagValue(line);

            if (type === "EVENT" || type === "VOD") {
                playlist.playlistType = type;
            }
        } else if (line.startsWith("#EXT-X-MAP:")) {
            const uri = parseAttributes(tagValue(line)).URI;

            if (uri) {
                playlist.initUri = new URL(uri, baseUrl).href;
            }
        } else if (line.startsWith("#EXT-X-KEY:")) {
            const method = parseAttributes(tagValue(line)).METHOD;

            if (method && method !== "NONE") {
                playlist.encryption = method;
            }
        } else if (line.startsWith("#EXT-X-BYTERANGE")) {
            playlist.usesByteRanges = true;
        } else if (line.startsWith("#EXTINF:")) {
            duration = Number.parseFloat(tagValue(line)) || 0;
        } else if (!line.startsWith("#") && duration !== null) {
            playlist.segments.push({
                sequence: playlist.mediaSequence + playlist.segments.length,
                uri: new URL(line, baseUrl).href,
                durationSec: duration,
            });
            duration = null;
        }
    }

    return playlist;
}

/**
 * A segment URI with its sequence number cut out, so a segment that already left the live window can still be named.
 * `width` is the zero-padded length of the number, or 0 when it is not padded.
 */
export interface SegmentUriTemplate {
    prefix: string;
    suffix: string;
    width: number;
}

export function segmentUri(template: SegmentUriTemplate, sequence: number): string {
    const digits = template.width > 0 ? String(sequence).padStart(template.width, "0") : String(sequence);
    return `${template.prefix}${digits}${template.suffix}`;
}

/**
 * Finds the digit run in a segment's path that equals its media sequence number, and keeps the one that also names
 * every other listed segment. Null when no run fits (the CDN names segments by time or by hash).
 */
export function deriveSegmentTemplate(segments: HlsSegment[]): SegmentUriTemplate | null {
    const first = segments[0];

    if (!first) {
        return null;
    }

    const queryAt = first.uri.indexOf("?");
    const pathEnd = queryAt === -1 ? first.uri.length : queryAt;
    const candidates = [...first.uri.slice(0, pathEnd).matchAll(/\d+/g)]
        .filter((match) => Number(match[0]) === first.sequence)
        .reverse();

    for (const match of candidates) {
        const at = match.index ?? 0;
        const run = match[0];
        const template: SegmentUriTemplate = {
            prefix: first.uri.slice(0, at),
            suffix: first.uri.slice(at + run.length),
            width: run.length > 1 && run.startsWith("0") ? run.length : 0,
        };
        const fitsAll = segments.slice(1, 8).every((segment) => segmentUri(template, segment.sequence) === segment.uri);

        if (fitsAll) {
            return template;
        }
    }

    return null;
}
