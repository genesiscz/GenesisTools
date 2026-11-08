import { spawnSync } from "node:child_process";
import { logger } from "@genesiscz/utils/logger";

/**
 * R8: read a stretch of a movie on the EDITOR's time base.
 *
 * The editor (AVFoundation) shows at time t the latest frame whose own presentation time is at or before t. ffmpeg's
 * command line re-times a simulator recording (bursts near 120 fps, near-equal times, a decode clock that starts 1.95 s
 * before 0): on its filter clock the frame the editor shows at 43.5 s sits at 41.55 s, the first seconds agree, and an
 * input seek lands anywhere between, depending on the seek point (measured on a scratch copy, round 8). So the frames
 * are picked by their index in decode order (`select` on `n`), the order ffprobe's own presentation times follow, and
 * each grid time gets the frame the editor would show then.
 */

const { log } = logger.scoped("recording-editor-frames");
const timesOf = new Map<string, number[]>();

/** Each video frame's own presentation time (microseconds), in decode order, from the container (cached per path). */
export function framePresentationUs(video: string): number[] {
    const known = timesOf.get(video);

    if (known) {
        return known;
    }

    const probe = spawnSync(
        "ffprobe",
        ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", video],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );

    if (probe.status !== 0) {
        throw new Error(`ffprobe could not list the frames of ${video}: ${(probe.stderr ?? "").trim().slice(-300)}`);
    }

    const times = probe.stdout
        .trim()
        .split("\n")
        .map((line) => Math.round(Number.parseFloat(line.split(",")[0]) * 1_000_000))
        .filter((us) => Number.isFinite(us))
        .sort((a, b) => a - b);
    log.debug({ video, frames: times.length }, "frame times read with ffprobe");
    timesOf.set(video, times);
    return times;
}

/** A plan to read grid times: the ffmpeg arguments from the input on, and the output frame each grid time takes. */
export interface GridRead {
    args: string[];
    /** One per grid time from `fromUs`: its time and the ordinal of the output frame that shows then. */
    slots: Array<{ atUs: number; frame: number }>;
}

/**
 * Reads `fromUs` to `toUs` (editor time) `fps` times a second, with `extra` filters after the selection (scale,
 * format). Output frame `slots[k].frame` is what the editor shows at `slots[k].atUs`; a time inside a gap of the
 * recording shares the frame before it. It decodes from the start (about a twentieth of the stretch's end on this Mac).
 */
export function gridRead(options: {
    video: string;
    fromUs: number;
    toUs: number;
    fps: number;
    extra?: string;
}): GridRead {
    const times = framePresentationUs(options.video);
    const stepUs = 1_000_000 / options.fps;
    const indices: number[] = [];
    const slots: Array<{ atUs: number; frame: number }> = [];
    let index = 0;

    for (let atUs = options.fromUs; atUs < options.toUs - 1; atUs += stepUs) {
        while (index + 1 < times.length && times[index + 1] <= atUs) {
            index++;
        }

        if (indices[indices.length - 1] !== index) {
            indices.push(index);
        }

        slots.push({ atUs: Math.round(atUs), frame: indices.length - 1 });
    }

    // Runs of neighbouring indices as between(n,a,b), so a dense read stays a short expression.
    const runs: Array<[number, number]> = [];

    for (const at of indices) {
        const last = runs[runs.length - 1];

        if (last && at === last[1] + 1) {
            last[1] = at;
        } else {
            runs.push([at, at]);
        }
    }

    const select = runs.map(([a, b]) => (a === b ? `eq(n\\,${a})` : `between(n\\,${a}\\,${b})`)).join("+") || "0";
    return {
        args: [
            "-i",
            options.video,
            "-map",
            "0:v:0",
            "-vf",
            `select='${select}'${options.extra ? `,${options.extra}` : ""}`,
            "-fps_mode",
            "passthrough",
        ],
        slots,
    };
}
