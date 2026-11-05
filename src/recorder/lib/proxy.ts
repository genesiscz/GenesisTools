import { existsSync, readdirSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { imageSize } from "@genesiscz/utils/macos/ocr-boxes";
import { concatList } from "@genesiscz/utils/recording-editor/ffmpeg";
import { readFrameFolder, type SourceFrame } from "@genesiscz/utils/recording-editor/source";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { z } from "zod";

const { log } = logger.scoped("recorder-proxy");

/** An audio piece of a frames recording: `audio/<epoch ms>-d<display>-audio-<source>.m4a`. */
const AUDIO_PIECE = /^(\d+(?:\.\d+)?)-d(\d+)-audio-(mic|system)\.m4a$/;
/** H.264 needs even sides; frames of a display with an odd size lose one pixel. */
const EVEN_SIZE = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

/**
 * The video filter for the shown frames: one size keeps the frames as they are (even sides); several sizes (a plan
 * over displays of different shapes) fit each frame into the largest width and height with black bars, because one
 * H.264 stream cannot change its size and ffmpeg would stretch every later frame to the first one's.
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
 * The proxy's picture for the shown frame sizes, as proxyVideoFilter makes it: one size fills the picture; several are
 * each fitted into the largest width and height (even sides) and centred with black bars.
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

/** The pixel size of the first shown frame of each display (frames of one display share a size). */
function shownSizes(frames: readonly SourceFrame[]): Array<{ width: number; height: number }> {
    const firstOf = new Map<number | undefined, string>();

    for (const frame of frames) {
        if (!firstOf.has(frame.displayId)) {
            firstOf.set(frame.displayId, frame.path);
        }
    }

    return [...firstOf.values()].filter((path) => existsSync(path)).map((path) => imageSize(path));
}

export interface ProxyResult {
    path: string;
    frames: number;
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
 * was still on its screen when the range starts. The first frame is moved to 0, so movie time is recording time.
 */
export function framesForPlan(frames: readonly SourceFrame[], ranges: readonly DisplayRange[]): SourceFrame[] {
    const shown: SourceFrame[] = [];

    for (const [index, range] of ranges.entries()) {
        const toUs = index === ranges.length - 1 ? Number.POSITIVE_INFINITY : range.toUs;
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
        ranges: ranges.map((range) => ({ ...range, toUs: Math.min(range.toUs, endUs) })),
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
            const row = audioRowSchema.safeParse(SafeJSON.parse(line, { strict: true }));
            return row.success ? [row.data] : [];
        })
        .map((row) => ({ path: join(folder, row.file), delayMs: Math.max(0, Date.parse(row.at) - startedMs) }))
        .filter((piece) => existsSync(piece.path));
}

/**
 * Makes `proxy.mp4` for a frames recording so the editor can open it: each kept frame of one display shown until the
 * next one (the recording's own timing), with the audio pieces placed at their start times and mixed. The frames and
 * the audio files stay; the proxy is only what the editor plays and cuts.
 */
export async function makeProxy(folder: string, options: ProxyOptions = {}): Promise<ProxyResult> {
    const manifest = readRecordingManifest(folder);
    const frames = readFrameFolder(folder);

    if (frames.length === 0) {
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
    const videoFilter = proxyVideoFilter(shownSizes(chosen));
    const list = join(folder, ".proxy-frames.txt");
    await writeFile(list, concatList(chosen.map((frame) => ({ path: frame.path, atUs: frame.atUs }))));
    const startedMs = manifest ? Date.parse(manifest.startedAt) : Number.NaN;
    const audioDir = join(folder, "audio");
    const libraryPieces =
        existsSync(audioDir) && Number.isFinite(startedMs)
            ? readdirSync(audioDir)
                  .map((name) => ({ name, match: AUDIO_PIECE.exec(name) }))
                  .filter((piece) => piece.match !== null)
                  .map((piece) => ({
                      path: join(audioDir, piece.name),
                      delayMs: Math.max(0, Number(piece.match?.[1]) - startedMs),
                  }))
                  .sort((a, b) => a.delayMs - b.delayMs)
            : [];
    const pieces =
        libraryPieces.length > 0 || !Number.isFinite(startedMs)
            ? libraryPieces
            : meetingAudioPieces(folder, startedMs).sort((a, b) => a.delayMs - b.delayMs);
    const output = join(folder, "proxy.mp4");
    const partial = join(folder, ".proxy.partial.mp4");
    const audioInputs = pieces.flatMap((piece) => ["-i", piece.path]);
    const audioGraph = pieces.length
        ? [
              "-filter_complex",
              `[0:v]${videoFilter}[vout];` +
                  `${pieces.map((piece, index) => `[${index + 1}:a]adelay=${Math.round(piece.delayMs)}:all=1[a${index}]`).join(";")};` +
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
        { folder, frames: chosen.length, ranges: ranges.length, policy: plan.policy, audioPieces: pieces.length },
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
