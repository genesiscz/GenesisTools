import { logger } from "@genesiscz/utils/logger";
import { WAIT_SAMPLE_WIDTH } from "./waits";

const { log } = logger.scoped("recording-editor-scenes");

/**
 * A scene change at the frame it happens on. events() compares the picture 4 times a second, so a coarse scene sits
 * up to 0.25 s after the change; editors placed effects 1 to 2 s off on a tab tap (round 7, item 8). Each coarse
 * scene is read again at the movie's own frames over the step before it, and the change's first frame is its time.
 */

/** One decoded grey frame and its source time. */
export interface TimedFrame {
    us: number;
    pixels: Uint8Array;
}

/** The share of the whole change a frame must reach to be the change's first frame. */
const MOMENT_SHARE = 0.2;
/** Below this mean grey difference (0 to 255) the window holds no change. */
const MOMENT_MIN_DIFF = 1;

function meanDiff(a: Uint8Array, b: Uint8Array): number {
    let sum = 0;

    for (let index = 0; index < a.length; index++) {
        sum += Math.abs(a[index] - b[index]);
    }

    return a.length ? sum / a.length : 0;
}

/**
 * The time of the first frame that moved a fifth of the way from the window's first frame to its last (a cut, a
 * slide's first visible step, a fade's start); undefined when the window holds no change.
 */
export function changeMoment(frames: readonly TimedFrame[]): number | undefined {
    const first = frames[0];
    const last = frames.at(-1);

    if (!first || !last || frames.length < 2) {
        return undefined;
    }

    const total = meanDiff(first.pixels, last.pixels);

    if (total < MOMENT_MIN_DIFF) {
        return undefined;
    }

    return frames.find((frame) => meanDiff(first.pixels, frame.pixels) >= total * MOMENT_SHARE)?.us;
}

/**
 * Each coarse scene time (the first sample after the change) moved to the frame the change starts on, read from
 * `stepUs` before it to the scene time at the movie's own frames. A scene that cannot be read keeps its coarse time.
 *
 * One ffmpeg run reads every scene's window from the movie's start, without a seek (R8 10): on a simulator recording
 * (bursts near 120 fps, gaps, B-frames) a seek gave its frames evenly spaced times that ran up to 2 s behind the
 * picture, and a constant-rate output repeated frames, so the times printed no longer matched the frames read.
 */
export async function refineSceneTimes(options: {
    video: string;
    width: number;
    height: number;
    scenesUs: readonly number[];
    stepUs: number;
    timeoutMs?: number;
}): Promise<number[]> {
    if (options.scenesUs.length === 0) {
        return [];
    }

    const width = WAIT_SAMPLE_WIDTH;
    const height = Math.max(2, Math.round((width * options.height) / options.width / 2) * 2);
    // 50 ms more: the frame the editor shows at the step before is the latest one at or before it.
    const windows = options.scenesUs.map((sceneUs): [number, number] => [
        Math.max(0, sceneUs - options.stepUs - 50_000),
        sceneUs,
    ]);
    let frames: TimedFrame[];

    try {
        frames = await readFrames({ video: options.video, windows, width, height, timeoutMs: options.timeoutMs });
    } catch (error) {
        log.warn({ error, video: options.video }, "the scenes' frames could not be read; their coarse times stay");
        return [...options.scenesUs];
    }

    return windows.map(([fromUs, toUs], index) => {
        const inside = frames.filter((frame) => frame.us >= fromUs - 1000 && frame.us <= toUs + 1000);
        return changeMoment(inside) ?? options.scenesUs[index];
    });
}

/**
 * The movie's own frames inside `windows` ([from, to] source microseconds), grey and small, with their own times.
 * Decodes from the start (no seek) and keeps every frame as it is (passthrough), so frame N of the output is the
 * frame showinfo printed as N.
 */
async function readFrames(options: {
    video: string;
    windows: ReadonlyArray<[number, number]>;
    width: number;
    height: number;
    timeoutMs?: number;
}): Promise<TimedFrame[]> {
    const seconds = (us: number) => (us / 1_000_000).toFixed(6);
    const frameBytes = options.width * options.height;
    const select = options.windows
        .map(([fromUs, toUs]) => `between(t,${seconds(fromUs - 1000)},${seconds(toUs + 1000)})`)
        .join("+");
    const endUs = Math.max(...options.windows.map(([, toUs]) => toUs)) + 100_000;
    const command = [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-t",
        seconds(endUs),
        "-i",
        options.video,
        "-map",
        "0:v:0",
        "-vf",
        // setpts=N after showinfo: the frames' own times are printed, and the output's are strictly increasing.
        `select='${select}',scale=${options.width}:${options.height}:flags=area,format=gray,showinfo,setpts=N`,
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
    ];
    log.debug({ command }, "reading the scenes' frames");
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    // A whole decode up to the last scene: about 6 s for 90 s of a 1206 x 2622 recording on this Mac.
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 600_000);

    try {
        const [bytes, stderr, status] = await Promise.all([
            new Response(child.stdout).arrayBuffer(),
            new Response(child.stderr).text(),
            child.exited,
        ]);

        if (status !== 0) {
            throw new Error(`ffmpeg could not read ${options.video} (exit ${status}): ${stderr.trim().slice(-300)}`);
        }

        const times = [...stderr.matchAll(/pts_time:\s*(-?[\d.]+)/g)].map((match) =>
            Math.round(Number(match[1]) * 1_000_000)
        );
        const data = new Uint8Array(bytes);
        const count = Math.floor(data.length / frameBytes);

        if (count !== times.length) {
            throw new Error(`ffmpeg printed ${times.length} frame times for ${count} frames of ${options.video}`);
        }

        return times.map((us, index) => ({ us, pixels: data.subarray(index * frameBytes, (index + 1) * frameBytes) }));
    } finally {
        clearTimeout(timer);
    }
}
