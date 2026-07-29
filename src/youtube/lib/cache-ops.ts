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

    // The DB reference is cleared either way — a row pointing at a file someone
    // already removed is exactly the stale state this is here to clean up — but
    // only a real unlink counts toward the totals reported to the user.
    for (const video of videos) {
        if (opts.audio && video.audioPath) {
            const cleared = deletePath(video.audioPath, video.audioSizeBytes);
            opts.yt.db.setVideoBinaryPath(video.id, "audio", null);
            freedBytes += cleared.bytes;

            if (cleared.removed) {
                deletedCount++;
            }
        }

        if (opts.video && video.videoPath) {
            const cleared = deletePath(video.videoPath, video.videoSizeBytes);
            opts.yt.db.setVideoBinaryPath(video.id, "video", null);
            freedBytes += cleared.bytes;

            if (cleared.removed) {
                deletedCount++;
            }
        }

        if (opts.thumbs && video.thumbPath) {
            const cleared = deletePath(video.thumbPath, null);
            opts.yt.db.setVideoBinaryPath(video.id, "thumb", null);
            freedBytes += cleared.bytes;

            if (cleared.removed) {
                deletedCount++;
            }
        }
    }

    return { deletedCount, freedBytes };
}

/**
 * Unlinks `path` when it is still on disk.
 *
 * Reports `removed: false, bytes: 0` for an already-gone file rather than the
 * stored size: `cache clear` and `/api/v1/cache/clear` print both totals straight
 * to the user, and charging the DB's remembered size for a file nothing deleted
 * claimed space back that was never reclaimed.
 */
export function deletePath(path: string, knownBytes: number | null): { removed: boolean; bytes: number } {
    if (!existsSync(path)) {
        return { removed: false, bytes: 0 };
    }

    const bytes = knownBytes ?? statSync(path).size;
    unlinkSync(path);

    return { removed: true, bytes };
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
