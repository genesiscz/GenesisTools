import { existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { slugify } from "@genesiscz/utils/string";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import type { KickClip } from "./api";

/** A clip is at most a few minutes long; a remux that runs past this has stalled on the CDN. */
const REMUX_TIMEOUT_MS = 10 * 60_000;

export type ClipDownloadStatus = "saved" | "exists" | "failed";

export interface ClipDownloadRow {
    clip: KickClip;
    output: string;
    status: ClipDownloadStatus;
    bytes: number;
    error?: string;
}

/** `<channel>-<YYYY-MM-DD>-<title>-<id>.mp4`, so a rerun finds the file it saved and skips it. */
export function clipFileName(clip: KickClip): string {
    const day = clip.createdAt.slice(0, 10);
    const parts = [clip.channel, day, slugify(clip.title), clip.id.replace(/^clip_/, "")];
    return `${parts.filter(Boolean).join("-")}.mp4`;
}

/**
 * Remuxes the clip's byte-range HLS playlist into an MP4 with `ffmpeg -c copy` (no re-encode). ffmpeg writes
 * `<out>.part`, which becomes `<out>` only after ffmpeg exits 0, so a stopped run never leaves a cut file under the
 * final name.
 */
export async function downloadKickClip({
    clip,
    outDir,
    force,
    signal,
}: {
    clip: KickClip;
    outDir: string;
    force: boolean;
    signal?: AbortSignal;
}): Promise<ClipDownloadRow> {
    const output = join(outDir, clipFileName(clip));

    if (!force && existsSync(output) && statSync(output).size > 0) {
        return { clip, output, status: "exists", bytes: statSync(output).size };
    }

    const part = `${output}.part`;
    const command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        clip.playlistUrl,
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

    try {
        await runVideoCommand({ command, signal, timeoutMs: REMUX_TIMEOUT_MS });
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }

        logger.warn({ error, clip: clip.id, playlist: clip.playlistUrl }, "Kick clip remux failed");
        const message = error instanceof Error ? error.message.trim().split("\n").slice(-1)[0] : String(error);
        return { clip, output, status: "failed", bytes: 0, error: message };
    }

    renameSync(part, output);
    const bytes = statSync(output).size;
    logger.debug({ clip: clip.id, output, bytes }, "Kick clip saved");
    return { clip, output, status: "saved", bytes };
}

/** Downloads the clips with `jobs` remuxes at once, in list order; `onRow` hears each one as it finishes. */
export async function downloadKickClips({
    clips,
    outDir,
    jobs,
    force,
    signal,
    onRow,
}: {
    clips: KickClip[];
    outDir: string;
    jobs: number;
    force: boolean;
    signal?: AbortSignal;
    onRow?: (row: ClipDownloadRow, done: number) => void;
}): Promise<ClipDownloadRow[]> {
    const rows: ClipDownloadRow[] = new Array(clips.length);
    let next = 0;
    let done = 0;

    async function worker(): Promise<void> {
        while (next < clips.length && !signal?.aborted) {
            const index = next++;
            const row = await downloadKickClip({ clip: clips[index], outDir, force, signal });
            rows[index] = row;
            done++;
            onRow?.(row, done);
        }
    }

    await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, clips.length)) }, worker));
    return rows.filter(Boolean);
}
