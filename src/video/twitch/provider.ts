import { formatTimecode } from "@genesiscz/utils/format";
import { logger } from "@genesiscz/utils/logger";
import { mapPool } from "../clips/download";
import { readVodPlayback } from "../clips/hls";
import type { Clip, ClipProvider, ClipSource, PlacedClips, Vod } from "../clips/types";
import {
    fetchTwitchClip,
    fetchTwitchText,
    fetchTwitchVod,
    listTwitchClips,
    listTwitchVods,
    parseTwitchTarget,
    TWITCH_CLIP_SORTS,
    type TwitchClipSort,
    twitchClipMediaUrl,
    twitchVodPlaylistUrl,
} from "./api";

/** Twitch clip file names end with `-tw_<slug>.mp4`; slugify never writes `_`, so the title cannot fake it. */
const FILE_CLIP_SLUG = /-tw_([A-Za-z0-9_-]+)\.mp4$/;

function isTwitchSort(value: string): value is TwitchClipSort {
    return TWITCH_CLIP_SORTS.some((sort) => sort === value);
}

/** `1h2m3s`, the form of Twitch's `?t=` parameter. */
function twitchTime(sec: number): string {
    const [hours, minutes, seconds] = formatTimecode(sec).split(":").map(Number);
    return `${hours}h${minutes}m${seconds}s`;
}

function shiftIso(iso: string, sec: number): string {
    return new Date(Date.parse(iso) + sec * 1000).toISOString();
}

/** Twitch names each clip's VOD and its offset there, so placing a clip reads no playlist. */
function placeByOffset(clip: Clip, vod: Vod | null): ClipSource | null {
    if (!clip.streamId) {
        return null;
    }

    const offset = clip.vodOffsetSec;
    const end = offset === null ? null : offset + clip.durationSec;
    return {
        streamId: clip.streamId,
        vodId: clip.streamId,
        vodPageUrl: `https://www.twitch.tv/videos/${clip.streamId}`,
        vodUrlAtClip: offset === null ? null : `https://www.twitch.tv/videos/${clip.streamId}?t=${twitchTime(offset)}`,
        startAt: vod && offset !== null ? shiftIso(vod.startedAt, offset) : null,
        endAt: vod && end !== null ? shiftIso(vod.startedAt, end) : null,
        vodOffsetSec: offset,
        vodEndOffsetSec: end,
        offsetFrom: offset === null ? null : "site",
    };
}

async function placeTwitchClips({
    clips,
    jobs,
    signal,
}: {
    clips: Clip[];
    jobs: number;
    signal?: AbortSignal;
}): Promise<PlacedClips> {
    const vodById = new Map<string, Vod>();

    for (const channel of new Set(clips.map((clip) => clip.channel))) {
        try {
            for (const vod of await listTwitchVods(channel, signal)) {
                vodById.set(vod.id, vod);
            }
        } catch (error) {
            signal?.throwIfAborted();
            logger.warn({ error, channel }, "Twitch VOD list failed; clips keep their offsets without stream times");
        }
    }

    const missing = [...new Set(clips.map((clip) => clip.streamId))].filter(
        (id): id is string => id !== null && !vodById.has(id)
    );
    await mapPool({
        items: missing,
        jobs,
        signal,
        task: async (id) => {
            try {
                vodById.set(id, await fetchTwitchVod(id, signal));
            } catch (error) {
                signal?.throwIfAborted();
                logger.warn({ error, vod: id }, "Twitch VOD unreadable (deleted?)");
            }
        },
    });

    const sources = new Map(
        clips.map((clip) => [clip.id, placeByOffset(clip, clip.streamId ? (vodById.get(clip.streamId) ?? null) : null)])
    );
    const used = new Set(clips.map((clip) => clip.streamId));
    const vods = [...vodById.values()].filter((vod) => used.has(vod.id)).map((vod) => ({ vod, playback: null }));
    return { sources, vods };
}

export const twitchProvider: ClipProvider = {
    id: "twitch",
    label: "Twitch",
    sorts: TWITCH_CLIP_SORTS,
    defaultRange: "week",
    exampleClipsUrl: "https://www.twitch.tv/somechannel/clips?filter=clips&range=7d",
    parseTarget: parseTwitchTarget,
    listClips: ({ sort, ...options }) => {
        if (!isTwitchSort(sort)) {
            throw new Error(`Twitch has no clip sort "${sort}"; it has ${TWITCH_CLIP_SORTS.join(", ")}`);
        }

        return listTwitchClips({ ...options, sort });
    },
    fetchClip: fetchTwitchClip,
    clipMediaUrl: (clip, signal) => twitchClipMediaUrl(clip.id, signal),
    clipFileId: (clip) => `tw_${clip.id}`,
    clipIdFromFileName: (name) => name.match(FILE_CLIP_SLUG)?.[1] ?? null,
    listVods: listTwitchVods,
    fetchVod: fetchTwitchVod,
    vodPlayback: async ({ vod, quality, signal }) => {
        const masterUrl = await twitchVodPlaylistUrl(vod.id, signal);
        return readVodPlayback({ masterUrl, quality, fetchText: fetchTwitchText, signal });
    },
    placeClips: placeTwitchClips,
};
