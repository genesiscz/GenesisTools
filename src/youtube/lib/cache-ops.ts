import { existsSync, statSync, unlinkSync } from "node:fs";
import type { Video } from "@app/youtube/lib/types";
import type { Youtube } from "@app/youtube/lib/youtube";

export interface CacheStatsBase {
    channels: number;
    videos: number;
    transcripts: number;
    audioBytes: number;
    videoBytes: number;
}

export function listCacheVideos(yt: Youtube): Video[] {
    return yt.videos.list({ includeShorts: true, includeLive: true, limit: 1_000_000 });
}

export function buildCacheStatsBase(opts: { yt: Youtube; channels: number; videos: Video[] }): CacheStatsBase {
    const transcripts = opts.videos.reduce((count, video) => count + opts.yt.db.listTranscripts(video.id).length, 0);

    return {
        channels: opts.channels,
        videos: opts.videos.length,
        transcripts,
        audioBytes: sumBytes(opts.videos.map((video) => video.audioSizeBytes)),
        videoBytes: sumBytes(opts.videos.map((video) => video.videoSizeBytes)),
    };
}

export function clearVideoBinaries(opts: { yt: Youtube; audio: boolean; video: boolean; thumbs: boolean }): {
    deletedCount: number;
    freedBytes: number;
} {
    const videos = listCacheVideos(opts.yt);
    let deletedCount = 0;
    let freedBytes = 0;

    for (const video of videos) {
        if (opts.audio && video.audioPath) {
            freedBytes += deletePath(video.audioPath, video.audioSizeBytes);
            opts.yt.db.setVideoBinaryPath(video.id, "audio", null);
            deletedCount++;
        }

        if (opts.video && video.videoPath) {
            freedBytes += deletePath(video.videoPath, video.videoSizeBytes);
            opts.yt.db.setVideoBinaryPath(video.id, "video", null);
            deletedCount++;
        }

        if (opts.thumbs && video.thumbPath) {
            freedBytes += deletePath(video.thumbPath, null);
            opts.yt.db.setVideoBinaryPath(video.id, "thumb", null);
            deletedCount++;
        }
    }

    return { deletedCount, freedBytes };
}

export function deletePath(path: string, knownBytes: number | null): number {
    const bytes = knownBytes ?? (existsSync(path) ? statSync(path).size : 0);

    if (existsSync(path)) {
        unlinkSync(path);
    }

    return bytes;
}

export function sumBytes(values: Array<number | null>): number {
    return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

export function ttlDays(raw: string): number | undefined {
    const match = raw.match(/^(\d+)\s+days?$/);

    if (!match?.[1]) {
        return undefined;
    }

    return parseInt(match[1], 10);
}
