import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
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

const manifestClipSchema = z.object({
    id: z.string(),
    title: z.string(),
    /** The clip's page on the site. */
    pageUrl: z.string(),
    mediaUrl: z.string(),
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
}

export function manifestPath(dir: string): string {
    return join(dir, CLIPS_MANIFEST_FILE);
}

/** The folder's manifest, or an empty one. A file that does not parse throws, so a write never replaces it. */
export function readManifest(dir: string): ClipsManifest {
    const path = manifestPath(dir);

    if (!existsSync(path)) {
        return { version: 1, updatedAt: new Date().toISOString(), providers: {} };
    }

    const parsed = manifestSchema.safeParse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));

    if (!parsed.success) {
        throw new Error(`${path} is not a clips manifest (${parsed.error.issues[0]?.message}); move it away first`);
    }

    return parsed.data;
}

export function writeManifest(dir: string, manifest: ClipsManifest): string {
    const path = manifestPath(dir);
    manifest.updatedAt = new Date().toISOString();
    atomicWriteFileSync(path, `${SafeJSON.stringify(manifest, null, 2)}\n`);
    return path;
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
 * successful download; a source that could not be read keeps the one found before.
 */
export function recordClips({
    section,
    rows,
    sources,
}: {
    section: ProviderSection;
    rows: ClipDownloadRow[];
    sources: Map<string, ClipSource | null>;
}): void {
    const now = new Date().toISOString();

    for (const { clip, ...row } of rows) {
        const before = section.clips[clip.id];
        const keepFile = row.status === "failed" && before !== undefined && before.status !== "failed";
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
            file: keepFile ? before.file : row.status === "failed" ? null : basename(row.output),
            bytes: keepFile ? before.bytes : row.bytes,
            // A skipped file was not read, so the quality recorded with it stays.
            quality: (keepFile ? before.quality : row.quality) ?? before?.quality ?? null,
            status: keepFile ? before.status : row.status,
            ...(row.error && !keepFile ? { error: row.error } : {}),
            recordedAt: now,
            source: placeFromKnownPlaylist(section, sources.get(clip.id) ?? before?.source ?? null),
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

/** Start and end on one axis for clips of one stream: VOD offsets when both have them, else stream time. */
function interval(clip: ManifestClip, useOffsets: boolean): { start: number; end: number } {
    const source = clip.source;

    if (useOffsets && source?.vodOffsetSec != null && source.vodEndOffsetSec != null) {
        return { start: source.vodOffsetSec, end: source.vodEndOffsetSec };
    }

    return { start: Date.parse(source?.startAt ?? "") / 1000, end: Date.parse(source?.endAt ?? "") / 1000 };
}

/** Pairs of clips from one stream that overlap, by provider, stream and start. */
export function findOverlaps(manifest: ClipsManifest): ClipOverlap[] {
    const overlaps: ClipOverlap[] = [];

    for (const provider of CLIP_PROVIDER_IDS) {
        const clips = Object.values(manifest.providers[provider]?.clips ?? {}).filter((clip) => clip.source);
        const byStream = Map.groupBy(clips, (clip) => clip.source?.streamId ?? "");

        for (const [streamId, group] of byStream) {
            const useOffsets = group.every((clip) => clip.source?.vodOffsetSec != null);
            const sorted = group
                .map((clip) => ({ clip, ...interval(clip, useOffsets) }))
                .filter((entry) => Number.isFinite(entry.start) && Number.isFinite(entry.end))
                .sort((x, y) => x.start - y.start);

            for (const [index, first] of sorted.entries()) {
                for (const second of sorted.slice(index + 1)) {
                    if (second.start >= first.end) {
                        break;
                    }

                    const overlapSec = Math.min(first.end, second.end) - second.start;
                    const lengths = [first.end - first.start, second.end - second.start];
                    const duplicate = overlapSec >= Math.max(...lengths) * 0.9;
                    overlaps.push({
                        provider,
                        streamId,
                        a: first.clip,
                        b: second.clip,
                        overlapSec: Math.round(overlapSec * 10) / 10,
                        duplicate,
                        contained: !duplicate && overlapSec >= Math.min(...lengths) * 0.9,
                    });
                }
            }
        }
    }

    return overlaps;
}
