import { existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { slugify } from "@genesiscz/utils/string";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import type { Clip, ClipProvider } from "./types";

/** A clip is at most a few minutes long; a remux that runs past this has stalled on the CDN. */
const REMUX_TIMEOUT_MS = 10 * 60_000;

export type ClipDownloadStatus = "saved" | "exists" | "failed";

export interface ClipDownloadRow {
    clip: Clip;
    output: string;
    status: ClipDownloadStatus;
    bytes: number;
    error?: string;
}

/** `<channel>-<YYYY-MM-DD>-<title>-<clip id>.mp4`, so a rerun finds the file it saved and skips it. */
export function clipFileName(provider: ClipProvider, clip: Clip): string {
    const day = clip.createdAt.slice(0, 10);
    const parts = [clip.channel, day, slugify(clip.title), provider.clipFileId(clip)];
    return `${parts.filter(Boolean).join("-")}.mp4`;
}

/** Runs `task` over the items with at most `jobs` at once; results keep the item order. Stops taking items on abort. */
export async function mapPool<T, R>({
    items,
    jobs,
    signal,
    task,
}: {
    items: T[];
    jobs: number;
    signal?: AbortSignal;
    task: (item: T, index: number) => Promise<R>;
}): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;

    async function worker(): Promise<void> {
        while (next < items.length && !signal?.aborted) {
            const index = next++;
            results[index] = await task(items[index], index);
        }
    }

    await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, worker));
    return results.filter((result) => result !== undefined);
}

/**
 * Copies the clip into an MP4 with `ffmpeg -c copy` (no re-encode), from Kick's HLS playlist or Twitch's MP4 alike.
 * ffmpeg writes `<out>.part`, which becomes `<out>` only after ffmpeg exits 0, so a stopped run never leaves a cut
 * file under the final name.
 */
export async function downloadClip({
    provider,
    clip,
    outDir,
    force,
    signal,
}: {
    provider: ClipProvider;
    clip: Clip;
    outDir: string;
    force: boolean;
    signal?: AbortSignal;
}): Promise<ClipDownloadRow> {
    const output = join(outDir, clipFileName(provider, clip));

    if (!force && existsSync(output) && statSync(output).size > 0) {
        return { clip, output, status: "exists", bytes: statSync(output).size };
    }

    const part = `${output}.part`;

    try {
        const mediaUrl = await provider.clipMediaUrl(clip, signal);
        const command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            mediaUrl,
            "-c",
            "copy",
            "-bsf:a",
            "aac_adtstoasc",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            part,
        ];
        await runVideoCommand({ command, signal, timeoutMs: REMUX_TIMEOUT_MS });
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }

        logger.warn({ error, provider: provider.id, clip: clip.id }, "Clip download failed");
        const message = error instanceof Error ? error.message.trim().split("\n").slice(-1)[0] : String(error);
        return { clip, output, status: "failed", bytes: 0, error: message };
    }

    renameSync(part, output);
    const bytes = statSync(output).size;
    logger.debug({ provider: provider.id, clip: clip.id, output, bytes }, "Clip saved");
    return { clip, output, status: "saved", bytes };
}

/** Downloads the clips with `jobs` copies at once, in list order; `onRow` hears each one as it finishes. */
export async function downloadClips({
    provider,
    clips,
    outDir,
    jobs,
    force,
    signal,
    onRow,
}: {
    provider: ClipProvider;
    clips: Clip[];
    outDir: string;
    jobs: number;
    force: boolean;
    signal?: AbortSignal;
    onRow?: (row: ClipDownloadRow, done: number) => void;
}): Promise<ClipDownloadRow[]> {
    let done = 0;
    return mapPool({
        items: clips,
        jobs,
        signal,
        task: async (clip) => {
            const row = await downloadClip({ provider, clip, outDir, force, signal });
            done++;
            onRow?.(row, done);
            return row;
        },
    });
}
