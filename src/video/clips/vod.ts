import { existsSync, renameSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatBytes, formatTimecode } from "@genesiscz/utils/format";
import { logger } from "@genesiscz/utils/logger";
import { slugify } from "@genesiscz/utils/string";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import type { Vod, VodPlayback } from "./types";

/** Free space left on the disk after the estimated file, so a whole VOD never fills it. */
const DISK_RESERVE_BYTES = 2 * 1024 ** 3;

export interface VodPartResult {
    output: string;
    status: "saved" | "exists";
    bytes: number;
}

function stamp(sec: number): string {
    return formatTimecode(sec).replaceAll(":", "-");
}

/** `<channel>-<YYYY-MM-DD>-<title>-<VOD id>[-<from>_<to>]-<quality>.mp4`; a rerun of the same cut finds its file. */
export function vodPartFileName({
    vod,
    fromSec,
    toSec,
    quality,
}: {
    vod: Vod;
    fromSec: number;
    toSec: number;
    quality: string;
}): string {
    const whole = fromSec <= 0 && toSec >= vod.durationSec - 5;
    const range = whole ? "" : `${stamp(fromSec)}_${stamp(toSec)}`;
    const parts = [
        vod.channel,
        vod.startedAt.slice(0, 10),
        slugify(vod.title).slice(0, 60),
        vod.id.split("-")[0],
        range,
        quality,
    ];
    return `${parts.filter(Boolean).join("-")}.mp4`;
}

/**
 * Cuts `fromSec`..`toSec` of the VOD into an MP4 with `ffmpeg -ss … -t … -c copy`, so the cut starts at the
 * keyframe at or before `fromSec`. Writes `<out>.part` and renames it after ffmpeg exits 0. Refuses a cut whose
 * estimated size (variant bitrate times length) does not fit on the disk.
 */
export async function downloadVodPart({
    vod,
    playback,
    fromSec,
    toSec,
    outDir,
    force,
    signal,
}: {
    vod: Vod;
    playback: VodPlayback;
    fromSec: number;
    toSec: number;
    outDir: string;
    force: boolean;
    signal?: AbortSignal;
}): Promise<VodPartResult> {
    const output = join(outDir, vodPartFileName({ vod, fromSec, toSec, quality: playback.variantName }));

    if (!force && existsSync(output) && statSync(output).size > 0) {
        return { output, status: "exists", bytes: statSync(output).size };
    }

    const lengthSec = toSec - fromSec;
    const estimate = (playback.bandwidth / 8) * lengthSec;
    const disk = statfsSync(outDir);
    const free = disk.bavail * disk.bsize;

    if (estimate > 0 && estimate + DISK_RESERVE_BYTES > free) {
        throw new Error(
            `The cut needs about ${formatBytes(estimate)} and the disk has ${formatBytes(free)} free; cut a shorter range (--from, --to) or pick a lower --quality`
        );
    }

    const part = `${output}.part`;
    const command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        String(fromSec),
        "-i",
        playback.variantUrl,
        "-t",
        String(lengthSec),
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
    // A CDN copy runs far faster than real time; the length itself is a deadline no healthy copy reaches.
    await runVideoCommand({ command, signal, timeoutMs: Math.max(10 * 60_000, lengthSec * 1000) });
    renameSync(part, output);
    const bytes = statSync(output).size;
    logger.debug({ provider: vod.provider, vod: vod.id, output, fromSec, toSec, bytes }, "VOD part saved");
    return { output, status: "saved", bytes };
}
