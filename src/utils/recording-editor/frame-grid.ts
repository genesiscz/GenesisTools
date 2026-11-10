import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
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
const timesOf = new Map<string, { identity: string; times: number[] }>();
/** How long ffprobe may list a movie's frames; it blocks the process meanwhile, so a hung probe must end. */
const FRAME_TIMES_TIMEOUT_MS = 60_000;

/**
 * Each video frame's own presentation time (microseconds), in decode order, from the container. Kept per path and
 * file identity (inode, size, modification time, as `movieContentKey` checks it), so a movie written again under the
 * same path (an export replaced) is listed again instead of read on its old timeline.
 */
export function framePresentationUs(video: string): number[] {
    const stat = statSync(video);
    const identity = `${stat.ino}:${stat.size}:${Math.round(stat.mtimeMs)}`;
    const known = timesOf.get(video);

    if (known?.identity === identity) {
        return known.times;
    }

    const probe = spawnSync(
        "ffprobe",
        ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", video],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: FRAME_TIMES_TIMEOUT_MS }
    );

    if (probe.status !== 0) {
        const why = probe.error ? `${probe.error.message}; ` : "";
        throw new Error(
            `ffprobe could not list the frames of ${video}: ${why}${(probe.stderr ?? "").trim().slice(-300)}`
        );
    }

    const times = probe.stdout
        .trim()
        .split("\n")
        .map((line) => Math.round(Number.parseFloat(line.split(",")[0]) * 1_000_000))
        .filter((us) => Number.isFinite(us))
        .sort((a, b) => a - b);
    log.debug({ video, frames: times.length }, "frame times read with ffprobe");
    timesOf.set(video, { identity, times });
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
 * recording shares the frame before it. It decodes from the start (about a twentieth of the stretch's end on this Mac),
 * and each read stops at its own last frame. A run of neighbouring frames is one term, so a dense stretch is one read
 * through one decoder: readGridPictures streams it, so its size never sets how many pictures exist at once.
 */
export function gridRead(options: {
    video: string;
    fromUs: number;
    toUs: number;
    fps: number;
    extra?: string;
}): GridRead {
    // A rate of 0, a negative one or NaN never advances the grid below and would fill memory with slots.
    if (!Number.isFinite(options.fps) || options.fps <= 0) {
        throw new Error(`frames are read a positive number of times a second, not ${options.fps}`);
    }

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
        const frames = part.reduce((all, [a, b]) => all + b - a + 1, 0);
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
                // ffmpeg stops after the read's last frame instead of decoding the rest of the movie.
                ...(frames > 0 ? ["-frames:v", String(frames)] : []),
            ],
            frames,
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

/** One picture of a plan's reads: the ordinal of its output frame (what `slots[k].frame` names) and its PNG bytes. */
export interface GridPicture {
    frame: number;
    png: Uint8Array;
}

/**
 * Runs a plan's reads as PNG pictures and yields them one at a time, in frame order. ffmpeg writes into a pipe and
 * waits while the caller works on a picture, so a read of any length holds about a pipe's worth of pictures at once,
 * and a dense stretch is decoded once. Splitting it into reads of a few frames each made every read decode the movie
 * from its start again. `timeoutMs` bounds each wait for ffmpeg, never the caller's own work. A read that ends short of
 * its frames ends the stream, as the later slots no longer line up.
 */
export async function* readGridPictures(
    plan: GridRead,
    options: { video: string; timeoutMs: number }
): AsyncGenerator<GridPicture> {
    let first = 0;

    for (const read of plan.reads) {
        const command = ["ffmpeg", "-nostdin", "-v", "error", ...read.args, "-f", "image2pipe", "-c:v", "png", "-"];
        const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
        const stderr = new Response(child.stderr).text();
        const reader = child.stdout.getReader();
        const pictures = pngSplitter();
        let stalled = false;
        let count = 0;

        try {
            for (;;) {
                const timer = setTimeout(() => {
                    stalled = true;
                    child.kill();
                }, options.timeoutMs);
                const chunk = await reader.read().finally(() => clearTimeout(timer));

                if (chunk.done) {
                    break;
                }

                for (const png of pictures.push(chunk.value)) {
                    yield { frame: first + count, png };
                    count++;
                }
            }

            const status = await child.exited;

            if (stalled) {
                throw new Error(`ffmpeg gave no picture of ${options.video} for ${options.timeoutMs} ms`);
            }

            if (status !== 0) {
                throw new Error(
                    `ffmpeg could not read ${options.video} (exit ${status}): ${(await stderr).trim().slice(-500)}`
                );
            }

            if (pictures.pending() > 0) {
                throw new Error(`ffmpeg's pictures of ${options.video} ended inside a picture`);
            }
        } finally {
            reader.releaseLock();

            if (child.exitCode === null) {
                child.kill();
            }
        }

        if (count < read.frames) {
            log.warn({ video: options.video, frames: count, planned: read.frames }, "a grid read ended short");
            return;
        }

        first += read.frames;
    }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Splits a stream of PNG files written back to back (ffmpeg's image2pipe) into whole files: each ends with its IEND
 * chunk. `push` gives the files a chunk completes; `pending` is the bytes of a file not complete yet.
 */
function pngSplitter(): { push(chunk: Uint8Array): Uint8Array[]; pending(): number } {
    let buffer = new Uint8Array(1 << 20);
    let size = 0;
    // Where the next chunk header of the file at the buffer's start begins (after its 8-byte signature).
    let at = PNG_SIGNATURE.length;
    return {
        push(chunk) {
            if (size + chunk.length > buffer.length) {
                const grown = new Uint8Array(Math.max(buffer.length * 2, size + chunk.length));
                grown.set(buffer.subarray(0, size));
                buffer = grown;
            }

            buffer.set(chunk, size);
            size += chunk.length;
            const files: Uint8Array[] = [];

            for (;;) {
                if (size >= PNG_SIGNATURE.length && PNG_SIGNATURE.some((byte, index) => buffer[index] !== byte)) {
                    throw new Error("ffmpeg's picture stream is not PNG");
                }

                if (at + 8 > size) {
                    break;
                }

                const length = new DataView(buffer.buffer, buffer.byteOffset + at, 4).getUint32(0);
                const end = at + 12 + length;

                if (end > size) {
                    break;
                }

                const type = String.fromCharCode(...buffer.subarray(at + 4, at + 8));
                at = end;

                if (type === "IEND") {
                    files.push(buffer.slice(0, end));
                    buffer.copyWithin(0, end, size);
                    size -= end;
                    at = PNG_SIGNATURE.length;
                }
            }

            return files;
        },
        pending: () => size,
    };
}
