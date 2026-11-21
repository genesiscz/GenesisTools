import { logger } from "@genesiscz/utils/logger";
import { chooseQuality } from "@genesiscz/utils/video/choose-quality";
import { mapPool } from "../clips/download";
import { readStreamSpan, readVodPlayback, type StreamSpan } from "../clips/hls";
import type { Clip, ClipProvider, ClipSource, OffsetSource, PlacedClips, Vod, VodPlayback } from "../clips/types";
import {
    fetchKickClip,
    fetchKickText,
    fetchKickVod,
    KICK_CLIP_SORTS,
    type KickClipSort,
    type KickVodInfo,
    listKickClips,
    listKickVods,
    parseKickTarget,
} from "./api";

/** The 26 character ULID of a clip id (`clip_<ULID>`), which ends every Kick clip file name. */
const FILE_CLIP_ID = /-([0-9A-HJKMNP-TV-Z]{26})\.mp4$/i;

function isKickSort(value: string): value is KickClipSort {
    return KICK_CLIP_SORTS.some((sort) => sort === value);
}

function playlistOf(info: KickVodInfo): string {
    if (info.playlistUrl) {
        return info.playlistUrl;
    }

    const { vod } = info;
    throw new Error(
        `Kick VOD ${vod.pageUrl ?? vod.streamId} is ${vod.live ? "still live" : vod.access}; Kick serves no playlist for it without a login`
    );
}

/**
 * The VOD's first stream time, fitted from Kick's `vod_starts_at` of its clips. That value is the exact offset rounded
 * down to a whole second, so each clip puts the start inside a one-second window, and the clips of one VOD together
 * narrow it: measured 2026-11-21 on three public VODs (66, 97 and 146 clips), the window was 0.07 to 0.15 s and its
 * middle within 0.05 s of the playlist's own start. One clip alone is within 0.5 s. Null without a site offset; when
 * the windows do not meet, the median of their middles.
 */
export function fitVodStart(clips: Array<{ startAt: string; siteOffsetSec: number }>): string | null {
    const latest = clips.map((clip) => Date.parse(clip.startAt) / 1000 - clip.siteOffsetSec);

    if (latest.length === 0) {
        return null;
    }

    const high = Math.min(...latest);
    const low = Math.max(...latest) - 1;
    const middles = latest.map((value) => value - 0.5).sort((a, b) => a - b);
    const start = low <= high ? (low + high) / 2 : middles[Math.floor(middles.length / 2)];
    return new Date(Math.round(start * 1000)).toISOString();
}

/**
 * Clip and VOD playlists both carry the stream time of every segment, also for a clip cut from the VOD later, so the
 * offset is their difference (`vod-playlist`). A subscriber-only VOD closes its playlist; then the start fitted from
 * Kick's `vod_starts_at` stands in (`site`, see `fitVodStart`). Without either, the stream start does (`stream-start`),
 * which put 80 clips 3.6 to 4.8 s early.
 */
export function placeBySpan({
    streamId,
    span,
    fittedStartAt,
    vod,
    playback,
}: {
    streamId: string;
    span: StreamSpan;
    fittedStartAt: string | null;
    vod: Vod | null;
    playback: VodPlayback | null;
}): ClipSource {
    const [origin, offsetFrom]: [string | null, OffsetSource | null] = playback?.startAt
        ? [playback.startAt, "vod-playlist"]
        : fittedStartAt
          ? [fittedStartAt, "site"]
          : vod
            ? [vod.startedAt, "stream-start"]
            : [null, null];
    const offset = origin ? (Date.parse(span.startAt) - Date.parse(origin)) / 1000 : null;
    return {
        streamId,
        vodId: vod?.id ?? null,
        vodPageUrl: vod?.pageUrl ?? null,
        vodUrlAtClip: null,
        startAt: span.startAt,
        endAt: span.endAt,
        vodOffsetSec: offset === null ? null : Math.round(offset * 1000) / 1000,
        vodEndOffsetSec: offset === null ? null : Math.round((offset + span.durationSec) * 1000) / 1000,
        offsetFrom,
    };
}

async function placeKickClips({
    clips,
    jobs,
    signal,
}: {
    clips: Clip[];
    jobs: number;
    signal?: AbortSignal;
}): Promise<PlacedClips> {
    const infoByStream = new Map<string, KickVodInfo>();

    for (const channel of new Set(clips.map((clip) => clip.channel))) {
        try {
            for (const info of await listKickVods(channel, signal)) {
                infoByStream.set(info.vod.streamId, info);
            }
        } catch (error) {
            signal?.throwIfAborted();
            logger.warn({ error, channel }, "Kick VOD list failed; the clips get stream times only");
        }
    }

    const streams = new Set(clips.map((clip) => clip.streamId).filter((id) => id !== null));
    const used = [...infoByStream.values()].filter((info) => streams.has(info.vod.streamId));
    const vods = await mapPool({
        items: used,
        jobs,
        signal,
        task: async (info) => {
            if (!info.playlistUrl) {
                return { vod: info.vod, playback: null };
            }

            try {
                const playback = await readVodPlayback({
                    masterUrl: info.playlistUrl,
                    fetchText: fetchKickText,
                    signal,
                });
                return { vod: info.vod, playback };
            } catch (error) {
                signal?.throwIfAborted();
                logger.warn(
                    { error, vod: info.vod.id },
                    "Kick VOD playlist unreadable; offsets count from the stream start"
                );
                return { vod: info.vod, playback: null };
            }
        },
    });
    const playbackByStream = new Map(vods.map((entry) => [entry.vod.streamId, entry.playback]));
    const spans = new Map<string, StreamSpan | null>();

    await mapPool({
        items: clips.filter((clip) => clip.streamId !== null),
        jobs,
        signal,
        task: async (clip) => {
            try {
                spans.set(clip.id, await readStreamSpan({ url: clip.mediaUrl, fetchText: fetchKickText, signal }));
            } catch (error) {
                signal?.throwIfAborted();
                logger.warn({ error, clip: clip.id }, "Kick clip playlist unreadable; the clip keeps no place");
            }
        },
    });

    const fittedByStream = new Map<string, string | null>();

    for (const [streamId, group] of Map.groupBy(clips, (clip) => clip.streamId)) {
        if (streamId) {
            const fitted = group.flatMap((clip) => {
                const span = spans.get(clip.id);
                return span && clip.vodOffsetSec !== null
                    ? [{ startAt: span.startAt, siteOffsetSec: clip.vodOffsetSec }]
                    : [];
            });
            fittedByStream.set(streamId, fitVodStart(fitted));
        }
    }

    const sources = new Map<string, ClipSource | null>();

    for (const clip of clips) {
        const streamId = clip.streamId;
        const span = spans.get(clip.id);

        if (!streamId || span === null) {
            sources.set(clip.id, null);
        } else if (span) {
            sources.set(
                clip.id,
                placeBySpan({
                    streamId,
                    span,
                    fittedStartAt: fittedByStream.get(streamId) ?? null,
                    vod: infoByStream.get(streamId)?.vod ?? null,
                    playback: playbackByStream.get(streamId) ?? null,
                })
            );
        }
    }

    return { sources, vods };
}

export const kickProvider: ClipProvider = {
    id: "kick",
    label: "Kick",
    sorts: KICK_CLIP_SORTS,
    defaultRange: "all",
    exampleClipsUrl: "https://kick.com/somechannel/clips?sort=date&range=day",
    parseTarget: parseKickTarget,
    listClips: ({ sort, ...options }) => {
        if (!isKickSort(sort)) {
            throw new Error(`Kick has no clip sort "${sort}"; it has ${KICK_CLIP_SORTS.join(", ")}`);
        }

        return listKickClips({ ...options, sort });
    },
    fetchClip: fetchKickClip,
    clipQualities: false,
    // Kick's clip playlist is one media playlist in the stream's own quality; no other rendition exists.
    clipMedia: async ({ clip, quality }) => {
        chooseQuality({ options: ["source"], quality, names: (name) => [name], height: () => null });
        return { url: clip.mediaUrl, quality: "source", best: true };
    },
    clipFileId: (clip) => clip.id.replace(/^clip_/, ""),
    clipIdFromFileName: (name) => {
        const ulid = name.match(FILE_CLIP_ID)?.[1];
        return ulid ? `clip_${ulid.toUpperCase()}` : null;
    },
    listVods: async (channel, signal) => (await listKickVods(channel, signal)).map((info) => info.vod),
    fetchVod: async (id, signal) => (await fetchKickVod(id, signal)).vod,
    vodPlayback: async ({ vod, quality, signal }) => {
        const listed = (await listKickVods(vod.channel, signal)).find((info) => info.vod.streamId === vod.streamId);
        const masterUrl = playlistOf(listed ?? (await fetchKickVod(vod.id, signal)));
        return readVodPlayback({ masterUrl, quality, fetchText: fetchKickText, signal });
    },
    placeClips: placeKickClips,
};
