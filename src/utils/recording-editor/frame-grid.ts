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
/** Listing the packets of a long recording takes a few seconds; a probe still running after this is stuck. */
export const FRAME_PROBE_TIMEOUT_MS = 60_000;

/** Each video frame's own presentation time (microseconds), in decode order, from the container (cached per path). */
export function framePresentationUs(video: string): number[] {
    const known = timesOf.get(video);

    if (known) {
        return known;
    }

    const probe = spawnSync(
        "ffprobe",
        ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", video],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: FRAME_PROBE_TIMEOUT_MS, killSignal: "SIGKILL" }
    );

    if (probe.error && "code" in probe.error && probe.error.code === "ETIMEDOUT") {
        throw new Error(`ffprobe did not list the frames of ${video} within ${FRAME_PROBE_TIMEOUT_MS / 1000} s`);
    }

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

/** ffmpeg's expression parser runs out of memory near a hundred terms, so a read is split into runs of this many. */
const TERMS_PER_READ = 32;

/**
 * A plan to read grid times: one or more ffmpeg reads (the arguments from the input on, run in order, their output
 * frames following each other), and the output frame each grid time takes.
 */
export interface GridRead {
    reads: Array<{ args: string[]; frames: number }>;
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

    const reads: GridRead["reads"] = [];

    for (let at = 0; at < Math.max(1, runs.length); at += TERMS_PER_READ) {
        const part = runs.slice(at, at + TERMS_PER_READ);
        const select = part.map(([a, b]) => (a === b ? `eq(n\\,${a})` : `between(n\\,${a}\\,${b})`)).join("+") || "0";
        reads.push({
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
            frames: part.reduce((all, [a, b]) => all + b - a + 1, 0),
        });
    }

    return { reads, slots };
}

/**
 * Runs a plan's reads as grey raw frames of `frameBytes` each (its `extra` filters must end in `format=gray`) and gives
 * the picture of every grid time, in order (a time in a gap shares its frame).
 */
export async function readGridGray(
    plan: GridRead,
    options: { video: string; frameBytes: number; timeoutMs: number }
): Promise<Uint8Array[]> {
    const frames: Uint8Array[] = [];

    for (const read of plan.reads) {
        const command = ["ffmpeg", "-nostdin", "-v", "error", ...read.args, "-f", "rawvideo", "-pix_fmt", "gray", "-"];
        const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
        const timer = setTimeout(() => child.kill(), options.timeoutMs);

        try {
            const [bytes, status, stderr] = await Promise.all([
                new Response(child.stdout).arrayBuffer().then((buffer) => new Uint8Array(buffer)),
                child.exited,
                new Response(child.stderr).text(),
            ]);

            if (status !== 0) {
                throw new Error(
                    `ffmpeg could not read ${options.video} (exit ${status}): ${stderr.trim().slice(-500)}`
                );
            }

            for (let at = 0; at + options.frameBytes <= bytes.length; at += options.frameBytes) {
                frames.push(bytes.subarray(at, at + options.frameBytes));
            }
        } finally {
            clearTimeout(timer);
        }
    }

    log.debug({ video: options.video, reads: plan.reads.length, frames: frames.length }, "grid frames read");
    const out: Uint8Array[] = [];

    for (const slot of plan.slots) {
        const frame = frames[slot.frame];

        if (!frame) {
            break;
        }

        out.push(frame);
    }

    return out;
}
