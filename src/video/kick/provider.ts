import { logger } from "@genesiscz/utils/logger";
import { chooseQuality } from "@genesiscz/utils/video/choose-quality";
import { mapPool } from "../clips/download";
import { readStreamSpan, readVodPlayback, type StreamSpan } from "../clips/hls";
import type { Clip, ClipProvider, ClipSource, PlacedClips, Vod, VodPlayback } from "../clips/types";
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
 * Kick's API gives no clip offset (`vod_starts_at` is always 0), but clip and VOD playlists both carry the stream
 * time of every segment, also for a clip cut from the VOD later. The offset is the difference; when the VOD playlist
 * is closed, the stream start stands in for it.
 */
function placeBySpan({
    streamId,
    span,
    vod,
    playback,
}: {
    streamId: string;
    span: StreamSpan;
    vod: Vod | null;
    playback: VodPlayback | null;
}): ClipSource {
    const origin = playback?.startAt ?? vod?.startedAt ?? null;
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
        offsetFrom: playback?.startAt ? "vod-playlist" : vod ? "stream-start" : null,
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
    const sources = new Map<string, ClipSource | null>();

    await mapPool({
        items: clips,
        jobs,
        signal,
        task: async (clip) => {
            const streamId = clip.streamId;

            if (!streamId) {
                sources.set(clip.id, null);
                return;
            }

            try {
                const span = await readStreamSpan({ url: clip.mediaUrl, fetchText: fetchKickText, signal });
                const vod = infoByStream.get(streamId)?.vod ?? null;
                const playback = playbackByStream.get(streamId) ?? null;
                sources.set(clip.id, span ? placeBySpan({ streamId, span, vod, playback }) : null);
            } catch (error) {
                signal?.throwIfAborted();
                logger.warn({ error, clip: clip.id }, "Kick clip playlist unreadable; the clip keeps no place");
            }
        },
    });

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
