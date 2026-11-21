import { basename, join } from "node:path";
import { type JsonDocument, jsonDocument, prettyJson } from "@genesiscz/utils/storage/locked-document";
import { z } from "zod";
import type { ClipDownloadRow } from "./download";
import { CLIP_PROVIDER_IDS, type ClipProviderId, type ClipSource, type Vod, type VodPlayback } from "./types";

/** One file per download folder: every clip saved there, the VODs they came from and the VOD parts cut there. */
export const CLIPS_MANIFEST_FILE = "clips-manifest.json";

const clipSourceSchema = z.object({
    streamId: z.string(),
    vodId: z.string().nullable(),
    vodPageUrl: z.string().nullable(),
    vodUrlAtClip: z.string().nullable(),
    startAt: z.string().nullable(),
    endAt: z.string().nullable(),
    vodOffsetSec: z.number().nullable(),
    vodEndOffsetSec: z.number().nullable(),
    offsetFrom: z.enum(["site", "vod-playlist", "stream-start"]).nullable(),
});

/** One saved file of a clip; a clip may have several, one per quality. */
const manifestFileSchema = z.object({
    bytes: z.number(),
    /** Null for a file only read by `--backfill`. */
    quality: z.string().nullable(),
    recordedAt: z.string(),
});

const manifestClipSchema = z.object({
    id: z.string(),
    title: z.string(),
    /** The clip's page on the site. */
    pageUrl: z.string(),
    /** Kick's HLS playlist; Twitch's MP4 without its token; null when the site names none. */
    mediaUrl: z.string().nullable(),
    thumbnailUrl: z.string().nullable(),
    channel: z.string(),
    channelName: z.string(),
    creator: z.string().nullable(),
    category: z.string().nullable(),
    mature: z.boolean(),
    createdAt: z.string(),
    durationSec: z.number(),
    views: z.number(),
    likes: z.number(),
    /** The MP4's name inside the folder; null while no download has succeeded. */
    file: z.string().nullable(),
    bytes: z.number(),
    /** The quality of `file` (`1080p60`, `source`); absent in records written before qualities were recorded. */
    quality: z.string().nullish(),
    /** Every saved file of the clip by file name, each with its own quality; absent in records written before. */
    files: z.record(z.string(), manifestFileSchema).default({}),
    status: z.enum(["saved", "exists", "failed"]),
    error: z.string().optional(),
    recordedAt: z.string(),
    /** Where the clip sits in its stream and VOD; null when the site names no stream. */
    source: clipSourceSchema.nullable(),
});

const manifestVodSchema = z.object({
    id: z.string(),
    streamId: z.string(),
    title: z.string(),
    channel: z.string(),
    startedAt: z.string(),
    durationSec: z.number(),
    live: z.boolean(),
    access: z.string(),
    pageUrl: z.string().nullable(),
    /** Stream time of the VOD's first frame, from its playlist; null when the playlist is closed or has no times. */
    playlistStartAt: z.string().nullable(),
    checkedAt: z.string(),
});

const manifestVodPartSchema = z.object({
    file: z.string(),
    vodId: z.string(),
    streamId: z.string(),
    vodPageUrl: z.string().nullable(),
    fromSec: z.number(),
    toSec: z.number(),
    quality: z.string(),
    bytes: z.number(),
    savedAt: z.string(),
    /** Set when the part was cut around a clip (`download-vod --clip`). */
    clipId: z.string().nullable(),
});

const providerSectionSchema = z.object({
    /** By clip id. */
    clips: z.record(z.string(), manifestClipSchema),
    /** By stream id, which is what a clip names. */
    vods: z.record(z.string(), manifestVodSchema),
    /** By file name. */
    vodParts: z.record(z.string(), manifestVodPartSchema),
});

const manifestSchema = z.object({
    version: z.literal(1),
    updatedAt: z.string(),
    /** One section per site, so a folder can hold Kick and Twitch clips side by side. */
    providers: z.partialRecord(z.enum(CLIP_PROVIDER_IDS), providerSectionSchema),
});

export type ClipsManifest = z.infer<typeof manifestSchema>;
export type ProviderSection = z.infer<typeof providerSectionSchema>;
export type ManifestClip = z.infer<typeof manifestClipSchema>;
export type ManifestVodPart = z.infer<typeof manifestVodPartSchema>;

export interface ClipOverlap {
    provider: ClipProviderId;
    streamId: string;
    a: ManifestClip;
    b: ManifestClip;
    overlapSec: number;
    /** The overlap covers at least 90% of the longer clip: the same span, clipped twice. */
    duplicate: boolean;
    /** Not a duplicate, but the shorter clip lies (90% or more) inside the other one. */
    contained: boolean;
    /** The clip that lies inside the other, measured on the same span as `contained`; null when not contained. */
    containedId: string | null;
}

export function manifestPath(dir: string): string {
    return join(dir, CLIPS_MANIFEST_FILE);
}

/**
 * The folder's manifest as a locked JSON document: every change reads the file again under its lock
 * (`clips-manifest.json.lock`), so a Kick download, a Twitch download and a VOD cut into one folder at once keep each
 * other's records. A file that does not parse is never replaced.
 */
function manifestDocument(dir: string): JsonDocument<ClipsManifest> {
    const path = manifestPath(dir);
    return jsonDocument({
        path,
        empty: () => ({ version: 1, updatedAt: new Date().toISOString(), providers: {} }),
        decode: (raw) => manifestSchema.parse(raw),
        encode: prettyJson,
        strictJson: true,
        onUnreadable: "refuse",
        beforeWrite: (manifest) => {
            manifest.updatedAt = new Date().toISOString();
        },
        unreadableError: (problem) => {
            const reason = problem.cause instanceof z.ZodError ? problem.cause.issues[0]?.message : problem.kind;
            return new Error(`${path} is not a clips manifest (${reason}); move it away first`, { cause: problem });
        },
    });
}

/** The folder's manifest, or an empty one. A file that does not parse throws. */
export function readManifest(dir: string): ClipsManifest {
    return manifestDocument(dir).read();
}

/** Applies `change` to the folder's current manifest under its lock and writes it; returns the written manifest. */
export function updateManifestFile({
    dir,
    change,
    signal,
}: {
    dir: string;
    change: (manifest: ClipsManifest) => void;
    signal?: AbortSignal;
}): Promise<ClipsManifest> {
    return manifestDocument(dir).mutate(
        (manifest) => {
            change(manifest);
            return manifest;
        },
        { signal }
    );
}

export function providerSection(manifest: ClipsManifest, provider: ClipProviderId): ProviderSection {
    const section = manifest.providers[provider] ?? { clips: {}, vods: {}, vodParts: {} };
    manifest.providers[provider] = section;
    return section;
}

/**
 * A VOD playlist read once keeps its start in `vods` after the site closes it (Kick turned a public VOD
 * subscriber-only within a day, seen 2026-11-21), so a clip of that stream placed a less exact way is placed from
 * that start again, to the millisecond.
 */
function placeFromKnownPlaylist(section: ProviderSection, source: ClipSource | null): ClipSource | null {
    const playlistStartAt = source ? section.vods[source.streamId]?.playlistStartAt : null;

    if (!source?.startAt || !source.endAt || !playlistStartAt || source.offsetFrom === "vod-playlist") {
        return source;
    }

    const offset = (Date.parse(source.startAt) - Date.parse(playlistStartAt)) / 1000;
    const length = (Date.parse(source.endAt) - Date.parse(source.startAt)) / 1000;
    return {
        ...source,
        vodOffsetSec: Math.round(offset * 1000) / 1000,
        vodEndOffsetSec: Math.round((offset + length) * 1000) / 1000,
        offsetFrom: "vod-playlist",
    };
}

/**
 * Records each download row. A failed row refreshes the clip's metadata but keeps the file of an earlier
 * successful download; a source that could not be read keeps the one found before. Each saved file keeps its own
 * quality in `files`, so a lower quality saved beside the best one never lends the best file its quality.
 */
export function recordClips({
    section,
    rows,
    sources,
    rebaseOnPlaylistStart,
}: {
    section: ProviderSection;
    rows: ClipDownloadRow[];
    sources: Map<string, ClipSource | null>;
    /** The provider's `clipTimesFromPlaylist`: only then does a recorded VOD playlist start re-place a clip. */
    rebaseOnPlaylistStart: boolean;
}): void {
    const now = new Date().toISOString();

    for (const { clip, ...row } of rows) {
        const before = section.clips[clip.id];
        const files = { ...(before?.files ?? {}) };

        // A record written before `files` knows one file and its quality.
        if (before?.file && !files[before.file]) {
            files[before.file] = {
                bytes: before.bytes,
                quality: before.quality ?? null,
                recordedAt: before.recordedAt,
            };
        }

        const name = basename(row.output);

        if (row.status !== "failed") {
            // A skipped file was not read, so the quality recorded for that same file stays.
            files[name] = { bytes: row.bytes, quality: row.quality ?? files[name]?.quality ?? null, recordedAt: now };
        }

        const keepFile = row.status === "failed" && before !== undefined && before.status !== "failed";
        const file = keepFile ? before.file : row.status === "failed" ? null : name;
        section.clips[clip.id] = {
            id: clip.id,
            title: clip.title,
            pageUrl: clip.pageUrl,
            mediaUrl: clip.mediaUrl,
            thumbnailUrl: clip.thumbnailUrl,
            channel: clip.channel,
            channelName: clip.channelName,
            creator: clip.creator,
            category: clip.category,
            mature: clip.mature,
            createdAt: clip.createdAt,
            durationSec: clip.durationSec,
            views: clip.views,
            likes: clip.likes,
            file,
            bytes: keepFile ? before.bytes : row.bytes,
            quality: file ? (files[file]?.quality ?? null) : null,
            files,
            status: keepFile ? before.status : row.status,
            ...(row.error && !keepFile ? { error: row.error } : {}),
            recordedAt: now,
            source: rebaseOnPlaylistStart
                ? placeFromKnownPlaylist(section, sources.get(clip.id) ?? before?.source ?? null)
                : (sources.get(clip.id) ?? before?.source ?? null),
        };
    }
}

export function recordVods(section: ProviderSection, vods: Array<{ vod: Vod; playback: VodPlayback | null }>): void {
    const now = new Date().toISOString();

    for (const { vod, playback } of vods) {
        section.vods[vod.streamId] = {
            id: vod.id,
            streamId: vod.streamId,
            title: vod.title,
            channel: vod.channel,
            startedAt: vod.startedAt,
            durationSec: vod.durationSec,
            live: vod.live,
            access: vod.access,
            pageUrl: vod.pageUrl,
            playlistStartAt: playback?.startAt ?? section.vods[vod.streamId]?.playlistStartAt ?? null,
            checkedAt: now,
        };
    }
}

interface Span {
    start: number;
    end: number;
}

interface PlacedEntry {
    clip: ManifestClip;
    span: Span;
}

function offsetSpan(clip: ManifestClip): Span | null {
    const source = clip.source;
    return source?.vodOffsetSec != null && source.vodEndOffsetSec != null
        ? { start: source.vodOffsetSec, end: source.vodEndOffsetSec }
        : null;
}

function wallSpan(clip: ManifestClip): Span | null {
    const start = Date.parse(clip.source?.startAt ?? "") / 1000;
    const end = Date.parse(clip.source?.endAt ?? "") / 1000;
    return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

/** Calls `visit` for every pair of entries whose spans overlap; a sweep over the starts, no copy of the list. */
function sweepOverlaps(entries: PlacedEntry[], visit: (first: PlacedEntry, second: PlacedEntry) => void): void {
    const sorted = entries.toSorted((x, y) => x.span.start - y.span.start);

    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            if (sorted[j].span.start >= sorted[i].span.end) {
                break;
            }

            visit(sorted[i], sorted[j]);
        }
    }
}

function overlapOf({
    provider,
    streamId,
    first,
    second,
}: {
    provider: ClipProviderId;
    streamId: string;
    first: PlacedEntry;
    second: PlacedEntry;
}): ClipOverlap {
    const overlapSec = Math.min(first.span.end, second.span.end) - second.span.start;
    const firstLength = first.span.end - first.span.start;
    const secondLength = second.span.end - second.span.start;
    const duplicate = overlapSec >= Math.max(firstLength, secondLength) * 0.9;
    const contained = !duplicate && overlapSec >= Math.min(firstLength, secondLength) * 0.9;
    return {
        provider,
        streamId,
        a: first.clip,
        b: second.clip,
        overlapSec: Math.round(overlapSec * 10) / 10,
        duplicate,
        contained,
        containedId: contained ? (firstLength <= secondLength ? first.clip.id : second.clip.id) : null,
    };
}

/**
 * Pairs of clips from one stream that overlap. Each pair is compared on one axis: VOD offsets when both clips have
 * them, else stream time when both have it; a clip with neither changes no other pair.
 */
export function findOverlaps(manifest: ClipsManifest): ClipOverlap[] {
    const overlaps: ClipOverlap[] = [];

    for (const provider of CLIP_PROVIDER_IDS) {
        const clips = Object.values(manifest.providers[provider]?.clips ?? {}).filter((clip) => clip.source);
        const byStream = Map.groupBy(clips, (clip) => clip.source?.streamId ?? "");

        for (const [streamId, group] of byStream) {
            const byOffset = group.flatMap((clip) => {
                const span = offsetSpan(clip);
                return span ? [{ clip, span }] : [];
            });
            const withOffset = new Set(byOffset.map((entry) => entry.clip.id));
            sweepOverlaps(byOffset, (first, second) => {
                overlaps.push(overlapOf({ provider, streamId, first, second }));
            });

            const byWall = group.flatMap((clip) => {
                const span = wallSpan(clip);
                return span ? [{ clip, span }] : [];
            });
            sweepOverlaps(byWall, (first, second) => {
                if (!withOffset.has(first.clip.id) || !withOffset.has(second.clip.id)) {
                    overlaps.push(overlapOf({ provider, streamId, first, second }));
                }
            });
        }
    }

    return overlaps;
}
