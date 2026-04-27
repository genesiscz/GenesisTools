import { existsSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import logger from "@app/logger";
import type { CacheLayout } from "@app/youtube/lib/cache.types";
import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import type { VideoId } from "@app/youtube/lib/video.types";

export const DEFAULT_CACHE_DIR = join(homedir(), ".genesis-tools", "youtube", "cache");

export function videoDir(layout: CacheLayout, handle: ChannelHandle, id: VideoId): string {
    const safeHandle = handle.replace(/^@/, "").replace(/[^a-zA-Z0-9_-]/g, "_");

    return join(layout.cacheDir, "channels", safeHandle, "videos", id);
}

export function audioPath(layout: CacheLayout, handle: ChannelHandle, id: VideoId, ext: string): string {
    return join(videoDir(layout, handle, id), "audio", `${id}.${ext}`);
}

export function videoFilePath(layout: CacheLayout, handle: ChannelHandle, id: VideoId, ext: string): string {
    return join(videoDir(layout, handle, id), "video", `${id}.${ext}`);
}

export function thumbPath(layout: CacheLayout, handle: ChannelHandle, id: VideoId): string {
    return join(videoDir(layout, handle, id), "thumbs", `${id}.jpg`);
}

export function ensureBinaryDir(filePath: string): void {
    const dir = dirname(filePath);

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

export async function deleteIfExists(filePath: string): Promise<void> {
    if (!existsSync(filePath)) {
        return;
    }

    try {
        await unlink(filePath);
    } catch (error) {
        if (!isEnoentError(error)) {
            logger.warn({ error, filePath }, "failed to delete cached binary");
        }
    }
}

function isEnoentError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
