import { existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { slugify } from "@genesiscz/utils/string";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import type { Clip, ClipMedia, ClipProvider } from "./types";

/** A clip is at most a few minutes long; a remux that runs past this has stalled on the CDN. */
const REMUX_TIMEOUT_MS = 10 * 60_000;

export type ClipDownloadStatus = "saved" | "exists" | "failed";

export interface ClipDownloadRow {
    clip: Clip;
    output: string;
    status: ClipDownloadStatus;
    bytes: number;
    /** The quality saved (`1080p60`, `source`); null when an existing file was skipped unread. */
    quality: string | null;
    error?: string;
}

/**
 * `<channel>-<YYYY-MM-DD>-<title>[-<quality>]-<clip id>.mp4`, so a rerun finds the file it saved and skips it. The
 * quality is in the name only when a better one is offered, so a lower quality never takes the best one's file.
 */
export function clipFileName(provider: ClipProvider, clip: Clip, quality?: string | null): string {
    const day = clip.createdAt.slice(0, 10);
    const parts = [clip.channel, day, slugify(clip.title), quality ?? "", provider.clipFileId(clip)];
    return `${parts.filter(Boolean).join("-")}.mp4`;
}

/** True when `quality` asks for the best one, which is also the default. */
function asksBest(quality: string | undefined): boolean {
    return !quality || quality.trim().toLowerCase() === "best";
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
    quality,
    outDir,
    force,
    signal,
}: {
    provider: ClipProvider;
    clip: Clip;
    quality?: string;
    outDir: string;
    force: boolean;
    signal?: AbortSignal;
}): Promise<ClipDownloadRow> {
    let output = join(outDir, clipFileName(provider, clip));
    let media: ClipMedia | null = null;
    const part = () => `${output}.part`;

    try {
        // Another quality's file name is known only once the site has named the quality it serves.
        if (!asksBest(quality)) {
            media = await provider.clipMedia({ clip, quality, signal });
            output = join(outDir, clipFileName(provider, clip, media.best ? null : media.quality));
        }

        if (!force && existsSync(output) && statSync(output).size > 0) {
            return { clip, output, status: "exists", bytes: statSync(output).size, quality: media?.quality ?? null };
        }

        media ??= await provider.clipMedia({ clip, signal });
        const command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            media.url,
            "-c",
            "copy",
            "-bsf:a",
            "aac_adtstoasc",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            part(),
        ];
        await runVideoCommand({ command, signal, timeoutMs: REMUX_TIMEOUT_MS });
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }

        logger.warn({ error, provider: provider.id, clip: clip.id }, "Clip download failed");
        const message = error instanceof Error ? error.message.trim().split("\n").slice(-1)[0] : String(error);
        return { clip, output, status: "failed", bytes: 0, quality: media?.quality ?? null, error: message };
    }

    renameSync(part(), output);
    const bytes = statSync(output).size;
    logger.debug({ provider: provider.id, clip: clip.id, output, bytes, quality: media.quality }, "Clip saved");
    return { clip, output, status: "saved", bytes, quality: media.quality };
}

/** Downloads the clips with `jobs` copies at once, in list order; `onRow` hears each one as it finishes. */
export async function downloadClips({
    provider,
    clips,
    quality,
    outDir,
    jobs,
    force,
    signal,
    onRow,
}: {
    provider: ClipProvider;
    clips: Clip[];
    quality?: string;
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
            const row = await downloadClip({ provider, clip, quality, outDir, force, signal });
            done++;
            onRow?.(row, done);
            return row;
        },
    });
}
