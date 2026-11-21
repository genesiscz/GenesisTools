import { mapPool } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { chooseQuality } from "@genesiscz/utils/video/choose-quality";
import { readStreamSpan, readVodPlayback, type StreamSpan } from "../clips/hls";
import type { Clip, ClipProvider, ClipSource, OffsetSource, PlacedClips, Vod, VodPlayback } from "../clips/types";
import {
    fetchKickClip,
    fetchKickText,
    fetchKickVod,
    isKickVodId,
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
    const latest = clips
        .map((clip) => Date.parse(clip.startAt) / 1000 - clip.siteOffsetSec)
        .filter((value) => Number.isFinite(value));

    if (latest.length === 0) {
        return null;
    }

    // A loop, not Math.min(...latest): a backfill of every clip can pass more values than a call takes arguments.
    let high = Number.POSITIVE_INFINITY;
    let low = Number.NEGATIVE_INFINITY;

    for (const value of latest) {
        high = Math.min(high, value);
        low = Math.max(low, value - 1);
    }

    const start =
        low <= high
            ? (low + high) / 2
            : latest.map((value) => value - 0.5).sort((a, b) => a - b)[Math.floor(latest.length / 2)];
    const at = new Date(Math.round(start * 1000));
    return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

/** A clip whose playlist carries no stream time keeps Kick's whole-second offset, with no stream time (`site`). */
function placeBySiteOffset({
    clip,
    streamId,
    vod,
}: {
    clip: Clip;
    streamId: string;
    vod: Vod | null;
}): ClipSource | null {
    if (clip.vodOffsetSec === null) {
        return null;
    }

    return {
        streamId,
        vodId: vod?.id ?? null,
        vodPageUrl: vod?.pageUrl ?? null,
        vodUrlAtClip: null,
        startAt: null,
        endAt: null,
        vodOffsetSec: clip.vodOffsetSec,
        vodEndOffsetSec: clip.vodOffsetSec + clip.durationSec,
        offsetFrom: "site",
    };
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

/** The VODs of the clips' streams from the channels' VOD lists, each with its default variant when Kick serves it. */
async function readKickVods({
    clips,
    jobs,
    signal,
}: {
    clips: Clip[];
    jobs: number;
    signal?: AbortSignal;
}): Promise<Array<{ vod: Vod; playback: VodPlayback | null }>> {
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
    return mapPool({
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
}

async function placeKickClips({
    clips,
    jobs,
    signal,
    vod: known,
}: {
    clips: Clip[];
    jobs: number;
    signal?: AbortSignal;
    vod?: { vod: Vod; playback: VodPlayback };
}): Promise<PlacedClips> {
    // A cut already read its VOD and the variant it cuts: that variant's start is the origin of the cut's offsets.
    const vods = known ? [known] : await readKickVods({ clips, jobs, signal });
    const vodByStream = new Map(vods.map((entry) => [entry.vod.streamId, entry]));
    const spans = new Map<string, StreamSpan | null>();

    await mapPool({
        items: clips.filter((clip) => clip.streamId !== null),
        jobs,
        signal,
        task: async (clip) => {
            try {
                if (!clip.mediaUrl) {
                    throw new Error(`Kick names no playlist for clip ${clip.id}`);
                }

                spans.set(clip.id, await readStreamSpan({ url: clip.mediaUrl, fetchText: fetchKickText, signal }));
            } catch (error) {
                signal?.throwIfAborted();
                logger.warn({ error, clip: clip.id }, "Kick clip playlist unreadable; the clip keeps no place");
            }
        },
    });

    const fittedByStream = new Map<string, string | null>();

    for (const [streamId, group] of Map.groupBy(clips, (clip) => clip.streamId)) {
        // A stream whose VOD playlist gave its start is placed from that; no fit is needed.
        if (streamId && !vodByStream.get(streamId)?.playback?.startAt) {
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

        if (!streamId) {
            sources.set(clip.id, null);
        } else if (span === null) {
            sources.set(clip.id, placeBySiteOffset({ clip, streamId, vod: vodByStream.get(streamId)?.vod ?? null }));
        } else if (span) {
            sources.set(
                clip.id,
                placeBySpan({
                    streamId,
                    span,
                    fittedStartAt: fittedByStream.get(streamId) ?? null,
                    vod: vodByStream.get(streamId)?.vod ?? null,
                    playback: vodByStream.get(streamId)?.playback ?? null,
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
    clipTimesFromPlaylist: true,
    // Kick's clip playlist is one media playlist in the stream's own quality; no other rendition exists.
    clipMedia: async ({ clip, quality }) => {
        chooseQuality({ options: ["source"], quality, names: (name) => [name], height: () => null });

        if (!clip.mediaUrl) {
            throw new Error(`Kick names no playlist for clip ${clip.id}`);
        }

        return { url: clip.mediaUrl, quality: "source", best: true };
    },
    clipFileId: (clip) => clip.id.replace(/^clip_/, ""),
    clipIdFromFileName: (name) => {
        const ulid = name.match(FILE_CLIP_ID)?.[1];
        return ulid ? `clip_${ulid.toUpperCase()}` : null;
    },
    listVods: async (channel, signal) => (await listKickVods(channel, signal)).map((info) => info.vod),
    fetchVod: async (id, signal) => (await fetchKickVod(id, signal)).vod,
    vodOfClip: async (clip, signal) => {
        if (!clip.streamId) {
            throw new Error(`Kick names no stream for clip ${clip.id}`);
        }

        const listed = (await listKickVods(clip.channel, signal)).find((info) => info.vod.streamId === clip.streamId);

        if (!listed) {
            // Kick's clip names only the numeric stream id, and the VOD detail route takes only the VOD's uuid.
            throw new Error(
                `The VOD list of ${clip.channel} has no VOD of stream ${clip.streamId} (clip ${clip.id}); Kick finds an older VOD only by its URL: pass it as [vod]`
            );
        }

        return listed.vod;
    },
    vodPlayback: async ({ vod, quality, signal }) => {
        const listed = (await listKickVods(vod.channel, signal)).find((info) => info.vod.streamId === vod.streamId);
        // The list gives a playlist only from the stream's own record; the VOD detail also has the video's. A VOD the
        // list calls closed stays closed; one it lists open without a playlist is asked for in detail.
        const closed = listed !== undefined && listed.vod.access !== "public";
        const info =
            listed?.playlistUrl || closed || !isKickVodId(vod.id)
                ? (listed ?? { vod, playlistUrl: null })
                : await fetchKickVod(vod.id, signal);
        return readVodPlayback({ masterUrl: playlistOf(info), quality, fetchText: fetchKickText, signal });
    },
    placeClips: placeKickClips,
};
