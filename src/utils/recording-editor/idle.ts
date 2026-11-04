import { logger } from "@genesiscz/utils/logger";
import { runVideoCommand } from "@genesiscz/utils/video/process";

const { log } = logger.scoped("recording-editor-idle");

/** Quieter than this is silence; a screen recording's system audio idles at -60 dB or lower. */
const SILENCE_DB = -45;

/** Every video frame's start, in microseconds. A screen recording writes a frame only when the screen changes. */
export async function frameTimesUs(video: string): Promise<number[]> {
    const text = await runVideoCommand({
        command: [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts_time",
            "-of",
            "csv=p=0",
            video,
        ],
        timeoutMs: 10 * 60_000,
    });
    return text
        .split("\n")
        .map((line) => Number.parseFloat(line))
        .filter(Number.isFinite)
        .map((seconds) => Math.round(seconds * 1_000_000))
        .sort((a, b) => a - b);
}

/** How far a frame may differ and still count as unchanged: a clock, a blinking caret, encoder noise. */
const FREEZE_NOISE_DB = -50;

/** Reads `<key>_start` / `<key>_end` pairs a metadata print wrote; an open start lasts to the end of the movie. */
function metadataRanges(text: string, key: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    const escaped = key.replaceAll(".", "\\.");
    const startPattern = new RegExp(`${escaped}_start=([\\d.]+)`);
    const endPattern = new RegExp(`${escaped}_end=([\\d.]+)`);
    let start: number | undefined;

    for (const line of text.split("\n")) {
        const begin = startPattern.exec(line);
        const end = endPattern.exec(line);

        if (begin) {
            start = Math.round(Number(begin[1]) * 1_000_000);
        } else if (end && start !== undefined) {
            ranges.push([start, Math.round(Number(end[1]) * 1_000_000)]);
            start = undefined;
        }
    }

    if (start !== undefined) {
        ranges.push([start, Number.POSITIVE_INFINITY]);
    }

    return ranges;
}

/**
 * The stretches where the picture does not change for at least `minUs`. A screen recording keeps writing frames
 * (the menu bar clock, the cursor), so frame gaps alone found nothing in one; freezedetect on a small copy compares
 * the pictures with a noise margin.
 */
export async function frozenRangesUs(video: string, minUs: number): Promise<Array<[number, number]>> {
    const text = await runVideoCommand({
        command: [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            video,
            "-map",
            "0:v:0",
            "-vf",
            `scale=480:-2,freezedetect=n=${FREEZE_NOISE_DB}dB:d=${minUs / 1_000_000},metadata=mode=print:file=-`,
            "-f",
            "null",
            "-",
        ],
        timeoutMs: 10 * 60_000,
    });
    return metadataRanges(text, "lavfi.freezedetect.freeze");
}

/** The movie's silent stretches of at least `minUs`, or undefined when it has no audio track. */
export async function silentRangesUs(video: string, minUs: number): Promise<Array<[number, number]> | undefined> {
    const streams = await runVideoCommand({
        command: [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            video,
        ],
    });

    if (!streams.trim()) {
        return undefined;
    }

    // silencedetect reports on stderr, which runVideoCommand drops; ametadata prints its tags to stdout instead.
    const text = await runVideoCommand({
        command: [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            video,
            "-map",
            "0:a:0",
            "-af",
            `silencedetect=n=${SILENCE_DB}dB:d=${minUs / 1_000_000},ametadata=mode=print:file=-`,
            "-f",
            "null",
            "-",
        ],
        timeoutMs: 10 * 60_000,
    });
    return metadataRanges(text, "lavfi.silence");
}

/**
 * The stretches to cut: no new video frame, or no change in the picture (`frozenUs`), for at least `minUs`,
 * overlapped with silence (all of it when the movie has no audio), each shortened by `keepUs` at both ends so a cut
 * never lands on the change before or after it.
 */
export function idleRanges(options: {
    frameTimesUs: readonly number[];
    frozenUs?: ReadonlyArray<readonly [number, number]>;
    silentUs?: ReadonlyArray<readonly [number, number]>;
    durationUs: number;
    minUs: number;
    keepUs: number;
}): Array<[number, number]> {
    const { frameTimesUs: frames, frozenUs = [], silentUs, durationUs, minUs, keepUs } = options;
    const gaps: Array<[number, number]> = [];
    const times = [...frames, durationUs];

    for (let index = 1; index < times.length; index++) {
        if (times[index] - times[index - 1] >= minUs) {
            gaps.push([times[index - 1], times[index]]);
        }
    }

    const still = mergeRanges([
        ...gaps,
        ...frozenUs.map(([from, to]): [number, number] => [from, Math.min(to, durationUs)]),
    ]);

    const quiet = silentUs
        ? still.flatMap(([from, to]) =>
              silentUs.flatMap(([silentFrom, silentTo]): Array<[number, number]> => {
                  const start = Math.max(from, silentFrom);
                  const end = Math.min(to, silentTo);
                  return end - start >= minUs ? [[start, end]] : [];
              })
          )
        : still;

    return quiet
        .map(([from, to]): [number, number] => [from + keepUs, Math.min(durationUs, to) - keepUs])
        .filter(([from, to]) => to - from > 0);
}

/** Sorted, with overlapping and touching ranges joined. */
function mergeRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
    const merged: Array<[number, number]> = [];

    for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
        const last = merged.at(-1);

        if (last && from <= last[1]) {
            last[1] = Math.max(last[1], to);
        } else {
            merged.push([from, to]);
        }
    }

    return merged;
}

/** Probes a movie and returns its idle stretches; logs what it found. */
export async function findIdle(options: {
    video: string;
    durationUs: number;
    minUs: number;
    keepUs: number;
}): Promise<Array<[number, number]>> {
    const [frames, frozen, silent] = await Promise.all([
        frameTimesUs(options.video),
        frozenRangesUs(options.video, options.minUs),
        silentRangesUs(options.video, options.minUs),
    ]);
    const ranges = idleRanges({ frameTimesUs: frames, frozenUs: frozen, silentUs: silent, ...options });
    log.debug(
        {
            video: options.video,
            frames: frames.length,
            frozen: frozen.length,
            silent: silent?.length ?? "no audio",
            idle: ranges.length,
        },
        "idle stretches found"
    );
    return ranges;
}
