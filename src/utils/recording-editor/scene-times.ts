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
 * `stepUs` before it to the scene time at the movie's own rate. A scene that cannot be read keeps its coarse time.
 * One ffmpeg run per scene, on a 160 pixel wide grey copy.
 */
export async function refineSceneTimes(options: {
    video: string;
    width: number;
    height: number;
    scenesUs: readonly number[];
    stepUs: number;
    timeoutMs?: number;
}): Promise<number[]> {
    const width = WAIT_SAMPLE_WIDTH;
    const height = Math.max(2, Math.round((width * options.height) / options.width / 2) * 2);
    const refined: number[] = [];

    for (const sceneUs of options.scenesUs) {
        // 50 ms more: the frame the editor shows at the step before is the latest one at or before it.
        const fromUs = Math.max(0, sceneUs - options.stepUs - 50_000);

        try {
            const frames = await readFrames({
                video: options.video,
                fromUs,
                toUs: sceneUs,
                width,
                height,
                timeoutMs: options.timeoutMs,
            });
            refined.push(changeMoment(frames) ?? sceneUs);
        } catch (error) {
            log.warn(
                { error, video: options.video, sceneUs },
                "a scene's frames could not be read; its coarse time stays"
            );
            refined.push(sceneUs);
        }
    }

    return refined;
}

/** The movie's own frames from `fromUs` to `toUs` (both in), grey and small, with their source times. */
async function readFrames(options: {
    video: string;
    fromUs: number;
    toUs: number;
    width: number;
    height: number;
    timeoutMs?: number;
}): Promise<TimedFrame[]> {
    const seconds = (us: number) => (us / 1_000_000).toFixed(6);
    const frameBytes = options.width * options.height;
    // -copyts keeps each frame's own time after the seek; showinfo prints it (pts_time) on stderr.
    const command = [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-copyts",
        "-ss",
        seconds(options.fromUs),
        "-i",
        options.video,
        "-to",
        seconds(options.toUs + 1000),
        "-map",
        "0:v:0",
        "-vf",
        `scale=${options.width}:${options.height}:flags=area,format=gray,showinfo`,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
    ];
    log.debug({ command }, "reading a scene's frames");
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 60_000);

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
        const count = Math.min(times.length, Math.floor(data.length / frameBytes));
        return Array.from({ length: count }, (_, index) => ({
            us: times[index] ?? 0,
            pixels: data.subarray(index * frameBytes, (index + 1) * frameBytes),
        })).filter((frame) => frame.us >= options.fromUs - 1000 && frame.us <= options.toUs + 1000);
    } finally {
        clearTimeout(timer);
    }
}
