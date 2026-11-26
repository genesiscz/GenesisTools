import { statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatBytes, formatTimecode } from "@genesiscz/utils/format";
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
import type { Vod, VodPlayback } from "./types";

/** Free space left on the disk after the estimated file, so a whole VOD never fills it. */
const DISK_RESERVE_BYTES = 2 * 1024 ** 3;
/**
 * The bitrate assumed when the playlist names none (a VOD URL that is already a media playlist): above what Kick and
 * Twitch serve for 1080p60 (about 6 to 8 Mbit/s), so the estimate errs on the large side.
 */
const UNKNOWN_BITRATE_BPS = 12_000_000;

export interface VodPartResult {
    output: string;
    status: "saved" | "exists";
    bytes: number;
}

/** `1-02-03`, with milliseconds when the boundary has them (`1-02-03.250`), so two different cuts never share a name. */
function stamp(sec: number): string {
    const totalMs = Math.round(sec * 1000);
    const base = formatTimecode(Math.floor(totalMs / 1000)).replaceAll(":", "-");
    const ms = totalMs % 1000;
    return ms === 0 ? base : `${base}.${String(ms).padStart(3, "0")}`;
}

/**
 * `<channel>-<YYYY-MM-DD>-<title>-<VOD id>[-<from>_<to>]-<quality>.mp4`; a rerun of the same cut finds its file. The
 * range is left out only for the whole VOD (`fromSec` 0 and `toSec` at the playlist's end).
 */
export function vodPartFileName({
    vod,
    fromSec,
    toSec,
    playbackDurationSec,
    quality,
}: {
    vod: Vod;
    fromSec: number;
    toSec: number;
    playbackDurationSec: number;
    quality: string;
}): string {
    const whole = fromSec <= 0 && toSec >= playbackDurationSec;
    return mp4FileName([
        fileNamePart(vod.channel),
        fileNamePart(vod.startedAt.slice(0, 10)),
        slugify(vod.title).slice(0, 60),
        fileNamePart(vod.id),
        whole ? "" : `${stamp(fromSec)}_${stamp(toSec)}`,
        fileNamePart(quality),
    ]);
}

/**
 * Cuts `fromSec`..`toSec` of the VOD into an MP4 with `ffmpeg -ss … -t … -c copy`, so the cut starts at the
 * keyframe at or before `fromSec`. ffmpeg writes into a private folder and the file takes its final name only after
 * ffmpeg exits 0 (see `writeThenPublish`); a failed or cancelled cut leaves nothing behind. Refuses a cut whose
 * estimated size (variant bitrate times length, a high bitrate when the playlist names none) does not fit on the disk
 * with 2 GB to spare.
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
    const name = vodPartFileName({
        vod,
        fromSec,
        toSec,
        playbackDurationSec: playback.durationSec,
        quality: playback.variantName,
    });
    const output = join(outDir, name);
    const present = force ? 0 : regularFileBytes(output);

    if (present > 0) {
        return { output, status: "exists", bytes: present };
    }

    const lengthSec = toSec - fromSec;
    const bitsPerSec = playback.bandwidth > 0 ? playback.bandwidth : UNKNOWN_BITRATE_BPS;
    const estimate = (bitsPerSec / 8) * lengthSec;
    const disk = statfsSync(outDir);
    const free = disk.bavail * disk.bsize;

    if (estimate + DISK_RESERVE_BYTES > free) {
        const assumed = playback.bandwidth > 0 ? "" : " (the playlist names no bitrate, so 12 Mbit/s is assumed)";
        throw new Error(
            `The cut needs about ${formatBytes(estimate)}${assumed} plus 2 GB to spare, and the disk has ${formatBytes(free)} free; cut a shorter range (--from, --to) or pick a lower --quality`
        );
    }

    const input = requireProviderMediaUrl(playback.variantUrl, vod.provider);
    const status = await writeThenPublish({
        output,
        force,
        write: (part) =>
            runVideoCommand({
                command: copyToMp4Command({ input, output: part, cut: { fromSec, lengthSec } }),
                signal,
                // A CDN copy runs far faster than real time; the length itself is a deadline no healthy copy reaches.
                timeoutMs: Math.max(10 * 60_000, lengthSec * 1000),
            }),
    });
    const bytes = statSync(output).size;
    logger.debug({ provider: vod.provider, vod: vod.id, output, fromSec, toSec, bytes, status }, "VOD part saved");
    return { output, status, bytes };
}
