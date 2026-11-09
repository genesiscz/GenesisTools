import { logger } from "@genesiscz/utils/logger";
import { audibleTracksOf, mixedTracksFilter, type PlayedAudio } from "@genesiscz/utils/recording-editor/loudness";
import { runVideoCommand } from "@genesiscz/utils/video/process";

const { log } = logger.scoped("recording-editor-idle");

/*
 * Every time here is on the editor's clock: the frame times the container lists (`frameTimesUs`). ffmpeg's filter
 * clock runs a simulator recording about 1.95 s behind it after the first seconds (R8, the header of frame-grid.ts),
 * so each freezedetect bound moves to the frame it names before it meets the frame gaps.
 */

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

/** The tag every frame gets before the print, so ffmpeg prints the header (and the filter time) of every frame. */
const FRAME_TAG = "gt.f";

const FRAME_HEADER = /^frame:\s*\d+\s+pts:\s*\S+\s+pts_time:(\S+)/;
const FREEZE_BOUND = /^lavfi\.freezedetect\.freeze_(start|end)=(\S+)$/;

interface FreezeBound {
    edge: "start" | "end";
    /** On ffmpeg's filter clock. */
    us: number;
    /** The ordinal of the frame whose metadata carried the bound. */
    frame: number;
}

/**
 * Reads a freezedetect metadata print as it arrives: the filter time of every frame and the freeze bounds. It keeps
 * one number per frame, never the text.
 */
export class FreezePrint {
    private readonly decoder = new TextDecoder();
    private rest = "";
    private readonly filterUs: number[] = [];
    private readonly bounds: FreezeBound[] = [];

    write(chunk: Uint8Array | string): void {
        const text = this.rest + (typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true }));
        const lines = text.split("\n");
        this.rest = lines.pop() ?? "";

        for (const line of lines) {
            this.read(line);
        }
    }

    /**
     * The frozen stretches on the editor clock. Each bound takes the presentation time (`presentationUs`, the list
     * `frameTimesUs` gives) of the first frame at or past its filter time, which is the frame freezedetect named; an
     * open freeze lasts to the end of the movie. ffmpeg hands its filters the frames in presentation order, so frame N
     * of the print is the Nth listed time; a print with another frame count keeps ffmpeg's own times.
     */
    rangesUs(presentationUs: readonly number[]): Array<[number, number]> {
        this.read(this.rest + this.decoder.decode());
        this.rest = "";

        if (this.filterUs.length !== presentationUs.length) {
            log.warn(
                { printed: this.filterUs.length, listed: presentationUs.length },
                "ffmpeg printed another frame count than the container lists; freeze times stay on its filter clock"
            );
            return freezeRanges(this.bounds, (bound) => bound.us);
        }

        let frame = 0;
        return freezeRanges(this.bounds, (bound) => {
            while (frame < bound.frame && !(this.filterUs[frame] >= bound.us)) {
                frame++;
            }

            return presentationUs[frame];
        });
    }

    private read(line: string): void {
        const header = FRAME_HEADER.exec(line);

        if (header) {
            this.filterUs.push(Math.round(Number(header[1]) * 1_000_000));
            return;
        }

        const bound = FREEZE_BOUND.exec(line.trim());
        const us = bound ? Math.round(Number(bound[2]) * 1_000_000) : Number.NaN;

        if (bound && Number.isFinite(us) && this.filterUs.length > 0) {
            this.bounds.push({ edge: bound[1] === "start" ? "start" : "end", us, frame: this.filterUs.length - 1 });
        }
    }
}

/** The bounds as ranges, each timed by `timeOf` (called on every bound, in order); an open start lasts to the end. */
function freezeRanges(bounds: readonly FreezeBound[], timeOf: (bound: FreezeBound) => number): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let start: number | undefined;

    for (const bound of bounds) {
        const us = timeOf(bound);

        if (bound.edge === "start") {
            start = us;
        } else if (start !== undefined) {
            ranges.push([start, us]);
            start = undefined;
        }
    }

    if (start !== undefined) {
        ranges.push([start, Number.POSITIVE_INFINITY]);
    }

    return ranges;
}

/** The frozen stretches a whole metadata print names, on the editor clock (`FreezePrint.rangesUs`). */
export function editorFrozenRanges(metadataText: string, presentationUs: readonly number[]): Array<[number, number]> {
    const print = new FreezePrint();
    print.write(metadataText);
    return print.rangesUs(presentationUs);
}

/**
 * The stretches where the picture does not change for at least `minUs`, on the editor clock. A screen recording keeps
 * writing frames (the menu bar clock, the cursor), so frame gaps alone found nothing in one; freezedetect on a small
 * copy compares the pictures with a noise margin. `presentationUs` is the movie's frame list from `frameTimesUs`.
 */
export async function frozenRangesUs(options: {
    video: string;
    minUs: number;
    presentationUs: readonly number[];
}): Promise<Array<[number, number]>> {
    const print = new FreezePrint();
    const detect = `freezedetect=n=${FREEZE_NOISE_DB}dB:d=${options.minUs / 1_000_000}`;
    await runVideoCommand({
        command: [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            options.video,
            "-map",
            "0:v:0",
            "-vf",
            `scale=480:-2,${detect},metadata=mode=add:key=${FRAME_TAG}:value=1,metadata=mode=print:file=-`,
            "-f",
            "null",
            "-",
        ],
        timeoutMs: 10 * 60_000,
        // A header line per frame: a long simulator recording (near 120 frames a second) outgrows a buffered read.
        onStdout: (chunk) => print.write(chunk),
    });
    return print.rangesUs(options.presentationUs);
}

/**
 * The stretches of at least `minUs` where the audio the export plays is silent, all its tracks mixed as the export
 * mixes them; undefined when it plays none (no audio track, the audio left out, or every track muted).
 */
export async function silentRangesUs(options: {
    video: string;
    minUs: number;
    audio?: PlayedAudio;
}): Promise<Array<[number, number]> | undefined> {
    const tracks = await audibleTracksOf(options.video, options.audio);

    if (tracks.length === 0) {
        return undefined;
    }

    const text = await runVideoCommand({
        command: silenceDetectArgs({ video: options.video, minUs: options.minUs, tracks }),
        timeoutMs: 10 * 60_000,
    });
    return metadataRanges(text, "lavfi.silence");
}

/** The ffmpeg command that prints the silences of `tracks` (`a:N`), mixed, as metadata lines on stdout. */
export function silenceDetectArgs(options: { video: string; minUs: number; tracks: readonly number[] }): string[] {
    // silencedetect reports on stderr, which runVideoCommand drops; ametadata prints its tags to stdout instead.
    const detect = `silencedetect=n=${SILENCE_DB}dB:d=${options.minUs / 1_000_000},ametadata=mode=print:file=-`;
    return [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-i",
        options.video,
        "-filter_complex",
        `${mixedTracksFilter(options.tracks)}${detect}[out]`,
        "-map",
        "[out]",
        "-f",
        "null",
        "-",
    ];
}

/**
 * The stretches to cut: no new video frame, or no change in the picture (`frozenUs`), for at least `minUs`,
 * overlapped with silence (all of it when the export plays no audio), each shortened by `keepUs` at both ends so a cut
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

/**
 * Probes a movie and returns its idle stretches; logs what it found. `audio` is the edit's (`project.audio`), so the
 * silence is judged on what the export plays; absent, every audio track counts.
 */
export async function findIdle(options: {
    video: string;
    durationUs: number;
    minUs: number;
    keepUs: number;
    audio?: PlayedAudio;
}): Promise<Array<[number, number]>> {
    const pictures = frameTimesUs(options.video).then(async (frames) => ({
        frames,
        frozen: await frozenRangesUs({ video: options.video, minUs: options.minUs, presentationUs: frames }),
    }));
    const [{ frames, frozen }, silent] = await Promise.all([
        pictures,
        silentRangesUs({ video: options.video, minUs: options.minUs, audio: options.audio }),
    ]);
    const ranges = idleRanges({ frameTimesUs: frames, frozenUs: frozen, silentUs: silent, ...options });
    log.debug(
        {
            video: options.video,
            frames: frames.length,
            frozen: frozen.length,
            silent: silent?.length ?? "no audio played",
            idle: ranges.length,
        },
        "idle stretches found"
    );
    return ranges;
}
