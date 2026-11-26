import { statSync } from "node:fs";
import { join } from "node:path";
import { mapPool } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { slugify } from "@genesiscz/utils/string";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import {
    copyToMp4Command,
    fileNamePart,
    mp4FileName,
    regularFileBytes,
    requireProviderMediaUrl,
    writeThenPublish,
} from "./files";
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
 * quality is in the name only when a better one is offered, so a lower quality never takes the best one's file. Every
 * part from the site's answer is cut to letters, digits, `_` and `-`, so the name stays one file in the folder.
 */
export function clipFileName(provider: ClipProvider, clip: Clip, quality?: string | null): string {
    const day = clip.createdAt.slice(0, 10);
    return mp4FileName([
        fileNamePart(clip.channel),
        fileNamePart(day),
        slugify(clip.title),
        fileNamePart(quality ?? ""),
        fileNamePart(provider.clipFileId(clip)),
    ]);
}

/** True when `quality` asks for the best one, which is also the default. */
function asksBest(quality: string | undefined): boolean {
    return !quality || quality.trim().toLowerCase() === "best";
}

function lastLine(error: unknown): string {
    return error instanceof Error ? (error.message.trim().split("\n").slice(-1)[0] ?? "") : String(error);
}

/**
 * Copies the clip into an MP4 with `ffmpeg -c copy` (no re-encode), from Kick's HLS playlist or Twitch's MP4 alike.
 * ffmpeg writes into a private folder and the file takes its final name only after ffmpeg exits 0 (see
 * `writeThenPublish`), so a stopped run never leaves a cut file under the final name. Every failure but a cancel,
 * file system errors included, comes back as a `failed` row, so one clip never stops the batch.
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
    // The folder stands in for the file until the name is made, so a refused name is a failed row too.
    let output = outDir;
    let media: ClipMedia | null = null;

    try {
        output = join(outDir, clipFileName(provider, clip));

        // Another quality's file name is known only once the site has named the quality it serves.
        if (!asksBest(quality)) {
            media = await provider.clipMedia({ clip, quality, signal });
            output = join(outDir, clipFileName(provider, clip, media.best ? null : media.quality));
        }

        const present = force ? 0 : regularFileBytes(output);

        if (present > 0) {
            return { clip, output, status: "exists", bytes: present, quality: media?.quality ?? null };
        }

        const chosen = media ?? (await provider.clipMedia({ clip, signal }));
        media = chosen;
        const input = requireProviderMediaUrl(chosen.url, provider.id);
        const status = await writeThenPublish({
            output,
            force,
            write: (part) =>
                runVideoCommand({
                    command: copyToMp4Command({ input, output: part }),
                    signal,
                    timeoutMs: REMUX_TIMEOUT_MS,
                }),
        });
        const bytes = statSync(output).size;
        logger.debug(
            { provider: provider.id, clip: clip.id, output, bytes, status, quality: chosen.quality },
            "Clip saved"
        );
        return { clip, output, status, bytes, quality: chosen.quality };
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }

        logger.warn({ error, provider: provider.id, clip: clip.id }, "Clip download failed");
        return { clip, output, status: "failed", bytes: 0, quality: media?.quality ?? null, error: lastLine(error) };
    }
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
