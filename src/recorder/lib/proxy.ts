import { existsSync, readdirSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { imageSize } from "@genesiscz/utils/macos/ocr-boxes";
import { concatList } from "@genesiscz/utils/recording-editor/ffmpeg";
import { framesMovieEndUs, readFrameFolder, type SourceFrame } from "@genesiscz/utils/recording-editor/source";
import { audioFileDurationUs } from "@genesiscz/utils/recording-editor/voiceovers";
import type { AudioSource } from "@genesiscz/utils/screen-recorder/control";
import { type RecordingManifest, readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { z } from "zod";
import { RECORDING_MOVIES } from "./library";

const { log } = logger.scoped("recorder-proxy");

/** An audio piece of a frames recording: `audio/<epoch ms>-d<display>-audio-<source>.m4a`. */
const AUDIO_PIECE = /^(\d+(?:\.\d+)?)-d(\d+)-audio-(mic|system)\.m4a$/;
/** H.264 needs even sides; frames of a display with an odd size lose one pixel. */
const EVEN_SIZE = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

/**
 * The video filter for the frame sizes of a recording's displays: one size keeps the frames as they are (even sides);
 * several sizes (displays of different shapes) fit each frame into the largest width and height with black bars,
 * because one H.264 stream cannot change its size and ffmpeg would stretch every later frame to the first one's.
 */
export function proxyVideoFilter(sizes: ReadonlyArray<{ width: number; height: number }>): string {
    const canvas = proxyCanvas(sizes);

    if (!canvas.letterboxed) {
        return EVEN_SIZE;
    }

    const { width, height } = canvas;
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
}

/**
 * The proxy's picture for the frame sizes of a recording's displays, as proxyVideoFilter makes it: one size fills the
 * picture; several are each fitted into the largest width and height (even sides) and centred with black bars.
 */
export function proxyCanvas(sizes: ReadonlyArray<{ width: number; height: number }>): {
    width: number;
    height: number;
    letterboxed: boolean;
} {
    const distinct = new Set(sizes.map((size) => `${size.width}x${size.height}`));

    if (distinct.size <= 1) {
        return { width: sizes[0]?.width ?? 0, height: sizes[0]?.height ?? 0, letterboxed: false };
    }

    const even = (value: number) => Math.ceil(value / 2) * 2;
    return {
        width: even(Math.max(...sizes.map((size) => size.width))),
        height: even(Math.max(...sizes.map((size) => size.height))),
        letterboxed: true,
    };
}

/**
 * A box of a frame (fractions of it, from its top left) as fractions of the proxy's picture, so it covers the same
 * text in the movie: the frame's own fractions when one size fills the picture, else moved and scaled by its bars.
 */
export function boxInProxy(
    box: { x: number; y: number; width: number; height: number },
    frame: { width: number; height: number },
    canvas: { width: number; height: number; letterboxed: boolean }
): { x: number; y: number; width: number; height: number } {
    if (!canvas.letterboxed) {
        return { ...box };
    }

    const scale = Math.min(canvas.width / frame.width, canvas.height / frame.height);
    const shown = { width: frame.width * scale, height: frame.height * scale };
    const left = (canvas.width - shown.width) / 2;
    const top = (canvas.height - shown.height) / 2;
    return {
        x: (left + box.x * shown.width) / canvas.width,
        y: (top + box.y * shown.height) / canvas.height,
        width: (box.width * shown.width) / canvas.width,
        height: (box.height * shown.height) / canvas.height,
    };
}

/**
 * A box of the proxy's picture (fractions of it, from its top left) as fractions of a frame shown in it: the inverse of
 * boxInProxy, so a box made over one picture can be placed in another. A box over the bars falls outside 0...1.
 */
export function boxInFrame(
    box: { x: number; y: number; width: number; height: number },
    frame: { width: number; height: number },
    canvas: { width: number; height: number; letterboxed: boolean }
): { x: number; y: number; width: number; height: number } {
    if (!canvas.letterboxed) {
        return { ...box };
    }

    const scale = Math.min(canvas.width / frame.width, canvas.height / frame.height);
    const shown = { width: frame.width * scale, height: frame.height * scale };
    const left = (canvas.width - shown.width) / 2;
    const top = (canvas.height - shown.height) / 2;
    return {
        x: (box.x * canvas.width - left) / shown.width,
        y: (box.y * canvas.height - top) / shown.height,
        width: (box.width * canvas.width) / shown.width,
        height: (box.height * canvas.height) / shown.height,
    };
}

/** The pixel size of each display's first frame (frames of one display share a size); a missing file is left out. */
export function frameSizesOf(
    frames: readonly SourceFrame[]
): Map<number | undefined, { width: number; height: number }> {
    const firstOf = new Map<number | undefined, string>();

    for (const frame of frames) {
        if (!firstOf.has(frame.displayId)) {
            firstOf.set(frame.displayId, frame.path);
        }
    }

    return new Map(
        [...firstOf].filter(([, path]) => existsSync(path)).map(([id, path]) => [id, imageSize(path)] as const)
    );
}

export interface ProxyResult {
    path: string;
    frames: number;
    /** The sound parts the movie mixes, each source once at each moment (`audioOncePerSource`). */
    audioPieces: number;
    /** The display of the whole movie, when one display is shown throughout. */
    displayId?: number;
    /** Which display the movie shows when (`proxy.json`). */
    plan: DisplayPlan;
}

/** Which display a frames recording of several displays shows: one display, or per window the one that changed most. */
export const PROXY_DISPLAY_POLICIES = ["most-change"] as const;
export type ProxyDisplay = number | (typeof PROXY_DISPLAY_POLICIES)[number];

export interface DisplayRange {
    fromUs: number;
    /** Exclusive; the last range ends at Infinity on read and at the last frame's time in `proxy.json`. */
    toUs: number;
    displayId: number;
}

export const displayPlanSchema = z.object({
    version: z.literal(1),
    policy: z.enum(["most-change", "display"]),
    windowSec: z.number(),
    ranges: z.array(z.object({ fromUs: z.number(), toUs: z.number(), displayId: z.number() })),
});
export type DisplayPlan = z.infer<typeof displayPlanSchema>;
const audioRowSchema = z.object({ file: z.string(), at: z.string() });

export const PROXY_PLAN_FILE = "proxy.json";
const DEFAULT_WINDOW_SEC = 10;

/**
 * Per window of `windowUs`, the display whose frames changed most: the sum of their change percents (a frame without
 * one counts 1, since a frame is kept only when the screen changed). A window without frames, or a tie, keeps the
 * display before it, so the movie does not flicker between screens. Consecutive windows of one display merge.
 */
export function planMostChange(frames: readonly SourceFrame[], windowUs: number): DisplayRange[] {
    if (!Number.isSafeInteger(windowUs) || windowUs <= 0) {
        throw new Error("proxy window must round to a positive number of microseconds");
    }

    const displays = [...new Set(frames.map((frame) => frame.displayId).filter((id) => id !== undefined))];

    if (displays.length === 0) {
        return [];
    }

    const endUs = Math.max(...frames.map((frame) => frame.atUs)) + 1;
    const ranges: DisplayRange[] = [];
    let current = frames.find((frame) => frame.displayId !== undefined)?.displayId ?? displays[0];

    const windows = new Map<number, Map<number, number>>();

    for (const frame of frames) {
        if (frame.displayId === undefined) {
            continue;
        }

        const fromUs = Math.floor(frame.atUs / windowUs) * windowUs;
        const score = windows.get(fromUs) ?? new Map<number, number>();
        const weight = frame.changePercent && frame.changePercent > 0 ? frame.changePercent : 1;
        score.set(frame.displayId, (score.get(frame.displayId) ?? 0) + weight);
        windows.set(fromUs, score);
    }

    for (const [fromUs, score] of [...windows].sort(([a], [b]) => a - b)) {
        const previous = ranges.at(-1);

        if (previous) {
            previous.toUs = fromUs;
        } else if (fromUs > 0) {
            ranges.push({ fromUs: 0, toUs: fromUs, displayId: current });
        }

        const best = Math.max(0, ...score.values());

        if (best > 0 && (score.get(current) ?? 0) < best) {
            current = [...score].find(([, value]) => value === best)?.[0] ?? current;
        }

        const last = ranges.at(-1);

        if (last && last.displayId === current) {
            last.toUs = fromUs + windowUs;
        } else {
            ranges.push({ fromUs, toUs: fromUs + windowUs, displayId: current });
        }
    }

    const last = ranges.at(-1);

    if (last) {
        last.toUs = Math.ceil(endUs / windowUs) * windowUs;
    }

    return ranges;
}

/** `ranges` with each override laid over them: inside an override its display wins. */
export function overrideRanges(ranges: readonly DisplayRange[], overrides: readonly DisplayRange[]): DisplayRange[] {
    let result = [...ranges];

    for (const over of overrides) {
        const cut: DisplayRange[] = [];

        for (const range of result) {
            if (range.toUs <= over.fromUs || range.fromUs >= over.toUs) {
                cut.push(range);
                continue;
            }

            if (range.fromUs < over.fromUs) {
                cut.push({ ...range, toUs: over.fromUs });
            }

            if (range.toUs > over.toUs) {
                cut.push({ ...range, fromUs: over.toUs });
            }
        }

        result = [...cut, over].sort((a, b) => a.fromUs - b.fromUs);
    }

    return result.reduce<DisplayRange[]>((merged, range) => {
        const last = merged.at(-1);

        if (last && last.displayId === range.displayId && last.toUs >= range.fromUs) {
            last.toUs = Math.max(last.toUs, range.toUs);
        } else {
            merged.push({ ...range });
        }

        return merged;
    }, []);
}

/**
 * The frames the movie shows for a plan: in each range the frames of its display, led by the frame of that display that
 * was still on its screen when the range starts. The first frame is moved to 0, so movie time is recording time. An
 * empty range (a plan saved with a switch past the last frame) shows nothing, so it never pulls in a frame at its start.
 */
export function framesForPlan(frames: readonly SourceFrame[], ranges: readonly DisplayRange[]): SourceFrame[] {
    const shown: SourceFrame[] = [];
    const live = ranges.filter((range) => range.toUs > range.fromUs);

    for (const [index, range] of live.entries()) {
        const toUs = index === live.length - 1 ? Number.POSITIVE_INFINITY : range.toUs;
        const own = frames.filter((frame) => frame.displayId === range.displayId);
        const lead = own.findLast((frame) => frame.atUs <= range.fromUs) ?? own.find((frame) => frame.atUs < toUs);

        if (lead) {
            shown.push({ ...lead, atUs: range.fromUs });
        }

        shown.push(...own.filter((frame) => frame !== lead && frame.atUs > range.fromUs && frame.atUs < toUs));
    }

    const ordered = shown.sort((a, b) => a.atUs - b.atUs);
    return ordered.length > 0 ? [{ ...ordered[0], atUs: 0 }, ...ordered.slice(1)] : ordered;
}

/** What a proxy shows: a display policy with overrides, or exactly a saved plan. */
export interface ProxyOptions {
    /** One display, or `most-change` (default): per window the display whose frames changed most. */
    display?: ProxyDisplay;
    /** The window of `most-change`, in seconds. Default 10. */
    windowSec?: number;
    /** Ranges that show a given display whatever the policy picks. */
    overrides?: DisplayRange[];
    /** Exactly this plan (a copy of an earlier proxy.json, to put it back): no policy pick and no overrides. */
    plan?: Pick<DisplayPlan, "policy" | "windowSec" | "ranges">;
}

/** A display plan from untrusted JSON (a copy of proxy.json), or a readable error. */
export function parseDisplayPlan(raw: unknown): DisplayPlan {
    return displayPlanSchema.parse(raw);
}

/**
 * The display ranges a proxy shows and the plan it saves: the policy's pick (one display, or the most change per
 * window) with the overrides laid over it, or exactly `options.plan`, whose displays must all have frames.
 */
export function chosenPlan(frames: readonly SourceFrame[], options: ProxyOptions): DisplayPlan {
    const displays = new Set(frames.map((frame) => frame.displayId).filter((id) => id !== undefined));
    const endUs = frames.length > 0 ? frames[frames.length - 1].atUs + 1 : 1;

    if (options.plan) {
        const windowUs = Math.round(options.plan.windowSec * 1_000_000);
        if (!Number.isSafeInteger(windowUs) || windowUs <= 0) {
            throw new Error("proxy plan window must round to positive microseconds");
        }

        if (options.display !== undefined || (options.overrides?.length ?? 0) > 0) {
            throw new Error("a plan is the whole display plan; give it without a display or switches");
        }

        const missing = options.plan.ranges.find((range) => !displays.has(range.displayId));

        if (missing) {
            throw new Error(
                `the plan shows display ${missing.displayId}, which has no frames; there are ${[...displays].join(", ") || "none"}`
            );
        }

        return { version: 1, ...options.plan, ranges: options.plan.ranges.map((range) => ({ ...range })) };
    }

    const windowSec = options.windowSec ?? DEFAULT_WINDOW_SEC;
    const single = typeof options.display === "number" ? options.display : undefined;

    if (single !== undefined && !displays.has(single)) {
        throw new Error(`there are no frames of display ${single}; there are ${[...displays].join(", ") || "none"}`);
    }

    const base =
        single !== undefined
            ? [{ fromUs: 0, toUs: endUs, displayId: single }]
            : planMostChange(frames, Math.round(windowSec * 1_000_000));
    const ranges = overrideRanges(base, options.overrides ?? []);
    return {
        version: 1,
        policy: single !== undefined ? "display" : "most-change",
        windowSec,
        // A switch past the last frame leaves a piece of the plan after the end: clamped, it would start after it ends.
        ranges: ranges
            .map((range) => ({ ...range, toUs: Math.min(range.toUs, endUs) }))
            .filter((range) => range.toUs > range.fromUs),
    };
}

/** The display plan a proxy was made with, or undefined for a proxy from before plans (or none). */
export function readDisplayPlan(folder: string): DisplayPlan | undefined {
    const path = join(folder, PROXY_PLAN_FILE);

    if (!existsSync(path)) {
        return undefined;
    }

    const parsed = displayPlanSchema.safeParse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));
    return parsed.success ? parsed.data : undefined;
}

/** An audio file of a meeting: `audio.jsonl` rows `{ file, at }` (wall time of the piece's start). */
function meetingAudioPieces(folder: string, startedMs: number): Array<{ path: string; delayMs: number }> {
    const index = join(folder, "audio.jsonl");

    if (!existsSync(index)) {
        return [];
    }

    return readFileSync(index, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .flatMap((line) => {
            try {
                const row = audioRowSchema.safeParse(SafeJSON.parse(line, { strict: true }));
                return row.success ? [row.data] : [];
            } catch (err) {
                log.warn({ err, index }, "skipping malformed audio index row");
                return [];
            }
        })
        .map((row) => ({ path: join(folder, row.file), delayMs: Math.max(0, Date.parse(row.at) - startedMs) }))
        .filter((piece) => existsSync(piece.path));
}

/** A sound file the proxy can mix, placed `delayMs` after the recording's start. */
export interface ProxyAudioPiece {
    path: string;
    delayMs: number;
    /** What a frames recording's piece recorded; a meeting's pieces have none and play as they are. */
    source?: AudioSource;
    displayId?: number;
    /** The file's length; absent when neither recording.json nor ffprobe knew it, and then the piece hides nothing. */
    durationMs?: number;
}

/** What the proxy mixes of one piece: the whole file, or its `part` (ms of the file), placed at `delayMs`. */
export interface ProxyAudioSegment {
    path: string;
    delayMs: number;
    part?: { fromMs: number; toMs: number };
}

/**
 * A part of a duplicate piece this short is the start and stop jitter of the captures of one run (30 ms in a recording
 * of two displays), not sound the kept piece missed.
 */
const AUDIO_JITTER_MS = 50;

/**
 * The parts of the audio pieces that play each source once at each moment. Every display capture of a frames
 * recording records the same sound, so the pieces of one source overlap: the longest keeps its whole span (then the
 * earliest, then the lowest display id), and a shorter piece adds only what no piece before it covers, such as the
 * run-on of a capture whose twin lost its display. Pieces of different sources (mic and system) and pieces in sequence
 * all play. The choice does not follow the display plan, so a display switch remakes the proxy with the same sound.
 */
export function audioOncePerSource(pieces: readonly ProxyAudioPiece[]): ProxyAudioSegment[] {
    const segments: ProxyAudioSegment[] = [];
    const bySource = new Map<AudioSource, Array<ProxyAudioPiece & { durationMs: number }>>();

    for (const piece of pieces) {
        const { source, durationMs } = piece;

        if (source === undefined || durationMs === undefined) {
            segments.push({ path: piece.path, delayMs: piece.delayMs });
            continue;
        }

        bySource.set(source, [...(bySource.get(source) ?? []), { ...piece, durationMs }]);
    }

    for (const same of bySource.values()) {
        const covered: Array<[number, number]> = [];
        const ranked = same.sort(
            (a, b) => b.durationMs - a.durationMs || a.delayMs - b.delayMs || (a.displayId ?? 0) - (b.displayId ?? 0)
        );

        for (const piece of ranked) {
            const fromMs = piece.delayMs;
            const toMs = piece.delayMs + piece.durationMs;

            for (const [partFrom, partTo] of uncoveredParts(fromMs, toMs, covered)) {
                if (partFrom === fromMs && partTo === toMs) {
                    segments.push({ path: piece.path, delayMs: fromMs });
                } else if (partTo - partFrom >= AUDIO_JITTER_MS) {
                    segments.push({
                        path: piece.path,
                        delayMs: partFrom,
                        part: { fromMs: partFrom - fromMs, toMs: partTo - fromMs },
                    });
                }
            }

            covered.push([fromMs, toMs]);
        }
    }

    return segments.sort((a, b) => a.delayMs - b.delayMs);
}

/** The parts of `[fromMs, toMs)` that no span of `covered` holds. */
function uncoveredParts(
    fromMs: number,
    toMs: number,
    covered: ReadonlyArray<readonly [number, number]>
): Array<[number, number]> {
    const parts: Array<[number, number]> = [];
    let atMs = fromMs;

    for (const [coverFrom, coverTo] of [...covered].sort((a, b) => a[0] - b[0])) {
        if (coverFrom >= toMs) {
            break;
        }

        if (coverFrom > atMs) {
            parts.push([atMs, coverFrom]);
        }

        atMs = Math.max(atMs, coverTo);
    }

    if (atMs < toMs) {
        parts.push([atMs, toMs]);
    }

    return parts;
}

const trackLengthSchema = z.object({ path: z.string(), durationMs: z.number().positive() });

/** Each audio piece's length by file name, from recording.json's `settings.tracks`. */
function trackLengths(manifest: RecordingManifest | undefined): Map<string, number> {
    const tracks = manifest?.settings.tracks;
    const lengths = new Map<string, number>();

    for (const track of Array.isArray(tracks) ? tracks : []) {
        const parsed = trackLengthSchema.safeParse(track);

        if (parsed.success) {
            lengths.set(basename(parsed.data.path), parsed.data.durationMs);
        }
    }

    return lengths;
}

/** A piece's length by ffprobe, for a piece recording.json does not list; undefined when ffprobe cannot read it. */
async function probedLengthMs(path: string): Promise<number | undefined> {
    try {
        return (await audioFileDurationUs(path)) / 1000;
    } catch (err) {
        log.warn({ err, path }, "audio piece of unknown length; it is mixed whole");
        return undefined;
    }
}

/** The audio pieces of a frames recording (`audio/`), each with its source, display and length. */
async function libraryAudioPieces(
    folder: string,
    manifest: RecordingManifest | undefined,
    startedMs: number
): Promise<ProxyAudioPiece[]> {
    const audioDir = join(folder, "audio");

    if (!existsSync(audioDir) || !Number.isFinite(startedMs)) {
        return [];
    }

    const lengths = trackLengths(manifest);
    const named = readdirSync(audioDir).flatMap((name) => {
        const match = AUDIO_PIECE.exec(name);
        return match ? [{ name, match }] : [];
    });
    return Promise.all(
        named.map(async ({ name, match }) => {
            const path = join(audioDir, name);
            const source: AudioSource = match[3] === "mic" ? "mic" : "system";
            return {
                path,
                delayMs: Math.max(0, Number(match[1]) - startedMs),
                source,
                displayId: Number(match[2]),
                durationMs: lengths.get(name) ?? (await probedLengthMs(path)),
            };
        })
    );
}

/** The ffmpeg filter that places one segment (input `index + 1`) at its time, as `[a<index>]`. */
function audioSegmentFilter(segment: ProxyAudioSegment, index: number): string {
    const trim = segment.part
        ? `atrim=start=${(segment.part.fromMs / 1000).toFixed(3)}:end=${(segment.part.toMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS,`
        : "";
    return `[${index + 1}:a]${trim}adelay=${Math.round(segment.delayMs)}:all=1[a${index}]`;
}

/** The editor's proxy movie in a frames recording's folder. */
export const PROXY_FILE = "proxy.mp4";

/**
 * Makes `proxy.mp4` for a frames recording so the editor can open it: each kept frame of one display shown until the
 * next one (the recording's own timing), with the audio pieces placed at their start times and mixed. The frames and
 * the audio files stay; the proxy is only what the editor plays and cuts.
 */
export async function makeProxy(folder: string, options: ProxyOptions = {}): Promise<ProxyResult> {
    const manifest = readRecordingManifest(folder);
    const frames = readFrameFolder(folder);

    if (frames.length === 0) {
        const movie = RECORDING_MOVIES.find((name) => name !== PROXY_FILE && existsSync(join(folder, name)));

        if (movie) {
            throw new Error(
                `${folder} has its movie (${movie}); a proxy is only for a frames recording, and the editor opens this one as it is (${toolCommand("recorder edit", folder)})`
            );
        }

        throw new Error(`${folder} has no frames to make a movie of`);
    }

    const plan = (() => {
        try {
            return chosenPlan(frames, options);
        } catch (error) {
            throw new Error(`${folder}: ${error instanceof Error ? error.message : String(error)}`);
        }
    })();
    const ranges = plan.ranges;
    const chosen = ranges.length > 0 ? framesForPlan(frames, ranges) : frames;
    const shownDisplays = [...new Set(ranges.map((range) => range.displayId))];
    const display = shownDisplays.length === 1 ? shownDisplays[0] : undefined;
    // The picture holds every display that has frames, whichever the plan shows, and the movie runs to the last frame
    // of any display: a display switch then changes neither, so an edit's fractions (hidden parts, shapes, a zoom's
    // focus) and its source size stay true. find-screen places its boxes in this same picture.
    const videoFilter = proxyVideoFilter([...frameSizesOf(frames).values()]);
    const list = join(folder, ".proxy-frames.txt");
    const lastUs = chosen.at(-1)?.atUs ?? 0;
    const durationUs = framesMovieEndUs({
        frames,
        schedule: chosen,
        startedAt: manifest?.startedAt,
        endedAt: manifest?.endedAt,
    });
    await writeFile(
        list,
        concatList(
            chosen.map((frame) => ({ path: frame.path, atUs: frame.atUs })),
            durationUs - lastUs
        )
    );
    const startedMs = manifest ? Date.parse(manifest.startedAt) : Number.NaN;
    const libraryPieces = await libraryAudioPieces(folder, manifest, startedMs);
    const audioFiles =
        libraryPieces.length > 0 || !Number.isFinite(startedMs) ? libraryPieces : meetingAudioPieces(folder, startedMs);
    // Every display capture of a frames recording records the same sound: each source plays once.
    const pieces = audioOncePerSource(audioFiles);
    const output = join(folder, PROXY_FILE);
    const partial = join(folder, ".proxy.partial.mp4");
    const audioInputs = pieces.flatMap((piece) => ["-i", piece.path]);
    const audioGraph = pieces.length
        ? [
              "-filter_complex",
              `[0:v]${videoFilter}[vout];` +
                  `${pieces.map(audioSegmentFilter).join(";")};` +
                  `${pieces.map((_, index) => `[a${index}]`).join("")}amix=inputs=${pieces.length}:normalize=0[aout]`,
              "-map",
              "[vout]",
              "-map",
              "[aout]",
              "-c:a",
              "aac",
              "-b:a",
              "160k",
          ]
        : ["-vf", videoFilter];
    const argv = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        ...audioInputs,
        ...audioGraph,
        "-fps_mode",
        "vfr",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        partial,
    ];
    log.info(
        {
            folder,
            frames: chosen.length,
            ranges: ranges.length,
            policy: plan.policy,
            audioFiles: audioFiles.length,
            audioPieces: pieces.length,
        },
        "making the proxy movie"
    );

    try {
        await runVideoCommand({ command: argv, timeoutMs: 10 * 60_000 });
    } finally {
        await rm(list, { force: true });
    }

    await rename(partial, output);
    atomicWriteFileSync(join(folder, PROXY_PLAN_FILE), SafeJSON.stringify(plan, null, 2));
    return {
        path: output,
        frames: chosen.length,
        audioPieces: pieces.length,
        ...(display !== undefined ? { displayId: display } : {}),
        plan,
    };
}
