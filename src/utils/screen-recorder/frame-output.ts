import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { recognizeText } from "@genesiscz/utils/macos/ocr";
import { imageSize, type PixelBox } from "@genesiscz/utils/macos/ocr-boxes";
import type { OcrBlock, OcrLevel, OcrResult } from "@genesiscz/utils/macos/types";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import type { RecorderSettings } from "./control";
import { mergeAreaRead, type OcrSkipReason, planRead } from "./ocr-region";
import type { CapturedFrame, MotionBox } from "./types";

const { log } = logger.scoped("frame-output");

/**
 * Where a recording's kept frames go and what each gets beside it: a name under `frames/`, a format (the recorder's
 * own file, or a JPEG), and an OCR read into a sink. Both recorders use it: the library recording (`start.ts`) and
 * the meetings recorder, each with its own options.
 */

/** A recording's folders and files hold screen captures and their text, so only the owner may read them. */
export const CAPTURE_DIR_MODE = 0o700;
export const CAPTURE_FILE_MODE = 0o600;

/** How a kept frame is named under `frames/`. */
export const FRAME_NAMINGS = ["elapsed", "wall-clock", "absolute"] as const;
export type FrameNaming = (typeof FRAME_NAMINGS)[number];

export interface FrameNameInput {
    /** The frame's wall-clock time. */
    at: Date;
    /** Milliseconds after the recording started. */
    elapsedMs: number;
    displayId: number;
    /** With the dot: `.png`, `.jpg`. */
    ext: string;
}

function pad(n: number, width = 2): string {
    return String(n).padStart(width, "0");
}

/** `15-23-41-502-d4.jpg`: the frame's local wall time, sortable within a day, and its display. */
export function wallClockFrameName(at: Date, displayId: number, ext = ".jpg"): string {
    return `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}-${pad(at.getMilliseconds(), 3)}-d${displayId}${ext}`;
}

/**
 * `2026-11-05T13-29-23-502Z-d4.jpg`: the frame's UTC time with its date, so a recording resumed on another day or
 * across a repeated DST hour never reuses a name, and the names sort over the whole recording.
 */
export function absoluteFrameName(at: Date, displayId: number, ext = ".jpg"): string {
    return `${at.toISOString().replace(/[:.]/g, "-")}-d${displayId}${ext}`;
}

const FRAME_NAMERS: Record<FrameNaming, (input: FrameNameInput) => string> = {
    /** `00012345-d1.png`: the milliseconds after the start, so the names sort over a whole recording. */
    elapsed: ({ elapsedMs, displayId, ext }) =>
        `${String(Math.max(0, Math.round(elapsedMs))).padStart(8, "0")}-d${displayId}${ext}`,
    "wall-clock": ({ at, displayId, ext }) => wallClockFrameName(at, displayId, ext),
    absolute: ({ at, displayId, ext }) => absoluteFrameName(at, displayId, ext),
};

export function frameFileName(naming: FrameNaming, input: FrameNameInput): string {
    return FRAME_NAMERS[naming](input);
}

/** The recorder's own file (moved), or a JPEG at `quality` (0 to 1). */
export type FrameFormat = { kind: "original" } | { kind: "jpeg"; quality: number };

export type JpegConverter = (source: string, target: string, quality: number) => Promise<void>;
/** One OCR read; `options` asks for the fast level or no fast retry of an empty accurate read (a crop). */
export type OcrRecognizer = (
    image: string,
    languages: string[],
    options?: { level?: OcrLevel; fastFallback?: boolean }
) => Promise<OcrResult>;
/** Writes the `box` of an image (pixels, top-left origin) to `target` as a PNG. */
export type ImageCropper = (source: string, target: string, box: PixelBox) => Promise<void>;

/** One frame's JPEG conversion ends within this; a hung `sips` must not hold a piece or the finish forever. */
const SIPS_TIMEOUT_MS = 30_000;

/** An image to a reduced JPEG with the system's own `sips`, which is stopped past `timeoutMs`. */
export function sipsJpegWithin(timeoutMs: number): JpegConverter {
    return async (source, target, quality) => {
        const result = await boundedCommand({
            command: [
                "sips",
                "-s",
                "format",
                "jpeg",
                "-s",
                "formatOptions",
                String(Math.round(quality * 100)),
                source,
                "--out",
                target,
            ],
            timeoutMs,
        });

        if (result.error?.code === "ETIMEDOUT") {
            throw new Error(`sips did not end within ${timeoutMs / 1000} s for ${source}`, { cause: result.error });
        }

        if (result.error) {
            throw result.error;
        }

        if (result.status !== 0) {
            throw new Error(`sips failed for ${source}: ${result.stderr.trim()}`);
        }
    };
}

/** An image to a reduced JPEG with the system's own `sips`. */
export const sipsJpeg: JpegConverter = sipsJpegWithin(SIPS_TIMEOUT_MS);

/** A part of an image as a PNG, cut by `sips` (`-c <height> <width> --cropOffset <y> <x>`). */
export const sipsCrop: ImageCropper = async (source, target, box) => {
    const result = await boundedCommand({
        command: [
            "sips",
            "-s",
            "format",
            "png",
            "-c",
            String(box.height),
            String(box.width),
            "--cropOffset",
            String(box.y),
            String(box.x),
            source,
            "--out",
            target,
        ],
        timeoutMs: SIPS_TIMEOUT_MS,
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`sips crop failed for ${source}: ${result.stderr.trim()}`);
    }
};

export const visionOcr: OcrRecognizer = (image, languages, options) => recognizeText(image, { languages, ...options });

/** One kept frame's OCR, as a line of a meeting's `ocr.jsonl`. */
export interface OcrRow {
    /** Relative to the recording folder: `frames/<name>`. */
    file: string;
    at: string;
    displayId: number;
    changePercent: number;
    reason: string;
    text: string;
    blocks: OcrBlock[];
    /** Set when no read ran: the row holds the previous frame's text of its display, and why it was not read. */
    skipped?: OcrSkipReason;
    /**
     * Set when only these areas were read (`[x, y, width, height]`, frame pixels, top-left origin): the row's other
     * lines are the previous frame's. `blocks` are in the whole frame's coordinates either way.
     */
    regions?: MotionBox[];
}

/** Where a kept frame's OCR goes. `row.text` is empty when the read held fewer than `minChars` characters. */
export interface OcrSink {
    write(row: OcrRow, framePath: string): void;
}

/** Every frame gets a line in one file, an empty read too: the meeting's `ocr.jsonl`. */
export class JsonlOcrSink implements OcrSink {
    constructor(readonly path: string) {}

    write(row: OcrRow): void {
        appendFileSync(this.path, `${SafeJSON.stringify(row)}\n`, { mode: CAPTURE_FILE_MODE });
    }
}

/** A frame with text gets `<frame>.ocr.json` beside it (`{ text, blocks }`); a frame without text gets nothing. */
export class SidecarOcrSink implements OcrSink {
    write(row: OcrRow, framePath: string): void {
        if (row.text.trim().length === 0) {
            return;
        }

        atomicWriteFileSync(`${framePath}.ocr.json`, SafeJSON.stringify({ text: row.text, blocks: row.blocks }), {
            mode: CAPTURE_FILE_MODE,
        });
    }
}

export const OCR_SINK_KINDS = ["sidecar", "jsonl"] as const;
export type OcrSinkKind = (typeof OCR_SINK_KINDS)[number];

const OCR_SINKS: Record<OcrSinkKind, (folder: string) => OcrSink> = {
    sidecar: () => new SidecarOcrSink(),
    jsonl: (folder) => new JsonlOcrSink(join(folder, "ocr.jsonl")),
};

export function ocrSinkFor(kind: OcrSinkKind, folder: string): OcrSink {
    return OCR_SINKS[kind](folder);
}

export interface FrameOutputOptions {
    /** The recording folder; frames go to its `frames/`. */
    folder: string;
    naming: FrameNaming;
    format: FrameFormat;
    /**
     * The OCR of each frame and where it goes. The sink gets a row for every kept frame, an empty one while OCR is off
     * (a meeting's `ocr.jsonl` is also its frame index). The settings are read per frame, so a live change reaches the
     * next frame. Absent: no OCR and no sink.
     */
    ocr?: {
        settings: () => RecorderSettings["ocr"];
        sink: OcrSink;
        recognize?: OcrRecognizer;
        /** A read that threw; the frame is kept with an empty read. */
        onError?: (error: unknown, framePath: string) => void;
    };
    convert?: JpegConverter;
    /** Cuts the changed area out of a frame for a read of it alone; default `sips`. */
    crop?: ImageCropper;
}

export interface KeptFrame {
    /** The absolute path under `frames/`. */
    path: string;
    /** Relative to the recording folder. */
    file: string;
    at: Date;
    elapsedMs: number;
    displayId: number;
    changePercent: number;
    reason: string;
    motionBoxes?: MotionBox[];
    bytes: number;
    /** The OCR read before the `minChars` cut (a skipped frame's is the previous one); absent when OCR is off. */
    read?: OcrResult;
}

const EMPTY_READ: OcrResult = { text: "", blocks: [] };

/** Writes kept frames one at a time: the name, the format, and the OCR into its sink. */
export class FrameOutput {
    readonly framesDir: string;
    /** Names given out so far: two frames still converting must not share one. */
    private readonly named = new Set<string>();
    /** The last read of each display, before the `minChars` cut: what a skipped frame keeps. */
    private readonly lastRead = new Map<number, OcrResult>();
    private crops = 0;
    /** An older frames folder is made owner-only at the first frame, once. */
    private dirTightened = false;

    constructor(private readonly options: FrameOutputOptions) {
        this.framesDir = join(options.folder, "frames");
    }

    /**
     * Keeps one captured frame. `atMs` is the frame's wall-clock time in ms, `originMs` the recording's start. A frame
     * whose recorder file is gone is still named (the recorder may have moved it), so a manifest keeps its row.
     */
    async keep(frame: CapturedFrame, at: { atMs: number; originMs: number; displayId: number }): Promise<KeptFrame> {
        const { format, naming } = this.options;
        const when = new Date(at.atMs);
        const elapsedMs = at.atMs - at.originMs;
        const ext = format.kind === "jpeg" ? ".jpg" : extname(frame.path) || ".png";
        const name = this.freeName((offsetMs) =>
            frameFileName(naming, {
                at: new Date(at.atMs + offsetMs),
                elapsedMs: elapsedMs + offsetMs,
                displayId: at.displayId,
                ext,
            })
        );
        const path = join(this.framesDir, name);
        mkdirSync(this.framesDir, { recursive: true, mode: CAPTURE_DIR_MODE });

        if (!this.dirTightened) {
            chmodSync(this.framesDir, CAPTURE_DIR_MODE);
            this.dirTightened = true;
        }

        if (format.kind === "jpeg") {
            await (this.options.convert ?? sipsJpeg)(frame.path, path, format.quality);
        } else if (existsSync(frame.path)) {
            renameSync(frame.path, path);
        }

        if (existsSync(path)) {
            chmodSync(path, CAPTURE_FILE_MODE);
        }

        const kept: KeptFrame = {
            path,
            file: `frames/${name}`,
            at: when,
            elapsedMs,
            displayId: at.displayId,
            changePercent: frame.changePercent,
            reason: frame.reason,
            ...(frame.motionBoxes ? { motionBoxes: frame.motionBoxes } : {}),
            bytes: existsSync(path) ? statSync(path).size : 0,
        };
        const ocr = this.options.ocr;

        if (!ocr) {
            return kept;
        }

        const settings = ocr.settings();
        const outcome = settings.enabled ? await this.read(frame, path, at.displayId, settings) : undefined;
        const read = outcome?.read;
        const used = !read || read.text.trim().length < settings.minChars ? EMPTY_READ : read;
        ocr.sink.write(
            {
                file: kept.file,
                at: when.toISOString(),
                displayId: at.displayId,
                changePercent: frame.changePercent,
                reason: frame.reason,
                text: used.text,
                blocks: used.blocks.map((block) => ({
                    text: block.text,
                    confidence: block.confidence,
                    bounds: block.bounds,
                })),
                ...(outcome?.skipped ? { skipped: outcome.skipped } : {}),
                ...(outcome?.regions ? { regions: outcome.regions } : {}),
            },
            path
        );
        return read ? { ...kept, read } : kept;
    }

    /**
     * The OCR of one kept frame: the previous read of its display when the plan skips it (`planRead`), else a read of
     * the whole frame. A read that throws counts as an empty one and is reported to `onError`.
     */
    private async read(
        frame: CapturedFrame,
        path: string,
        displayId: number,
        settings: RecorderSettings["ocr"]
    ): Promise<{ read: OcrResult; skipped?: OcrSkipReason; regions?: MotionBox[] }> {
        const ocr = this.options.ocr;
        const recognize = ocr?.recognize ?? visionOcr;
        const previous = this.lastRead.get(displayId);
        let size: { width: number; height: number } | undefined;
        const plan = planRead({
            frame,
            settings,
            previous: previous?.blocks,
            size: () => {
                size ??= imageSize(path);
                return size;
            },
        });

        if (plan.kind === "skip" && previous) {
            return { read: previous, skipped: plan.reason };
        }

        if (plan.kind === "area" && previous && size) {
            const frameSize = size;
            const crops = plan.areas.map((box) => ({
                box,
                path: join(tmpdir(), `gt-ocr-crop-${process.pid}-${++this.crops}.png`),
            }));

            try {
                for (const crop of crops) {
                    await (this.options.crop ?? sipsCrop)(path, crop.path, crop.box);
                }

                if (plan.checkTextless) {
                    let textless = true;

                    for (const crop of crops) {
                        const found = await recognize(crop.path, settings.languages, {
                            level: "fast",
                            fastFallback: false,
                        });

                        if (found.text.trim().length > 0 || found.blocks.length > 0) {
                            textless = false;
                            break;
                        }
                    }

                    if (textless) {
                        return { read: previous, skipped: "no-text" };
                    }
                }

                if (plan.readArea) {
                    let read = previous;

                    for (const crop of crops) {
                        const part = await recognize(crop.path, settings.languages, { fastFallback: false });
                        read = mergeAreaRead({ previous: read, area: crop.box, read: part, size: frameSize });
                    }

                    this.lastRead.set(displayId, read);
                    return { read, regions: plan.areas.map(({ x, y, width, height }) => [x, y, width, height]) };
                }
            } catch (error) {
                log.debug({ error, path }, "the changed-area read failed; the frame is read whole");
            } finally {
                for (const crop of crops) {
                    if (existsSync(crop.path)) {
                        unlinkSync(crop.path);
                    }
                }
            }
        }

        try {
            const read = await recognize(path, settings.languages);
            this.lastRead.set(displayId, read);
            return { read };
        } catch (error) {
            ocr?.onError?.(error, path);
            // The next frame is read whole: a skip must not keep an empty text that only stands for a failure.
            this.lastRead.delete(displayId);
            return { read: EMPTY_READ };
        }
    }

    /**
     * A name no other frame has: two frames of one display in the same millisecond would overwrite one file, so the
     * later one is named a millisecond on (its `at` stays the real time).
     */
    private freeName(nameAt: (offsetMs: number) => string): string {
        for (let offsetMs = 0; ; offsetMs++) {
            const name = nameAt(offsetMs);

            if (!this.named.has(name) && !existsSync(join(this.framesDir, name))) {
                this.named.add(name);
                return name;
            }
        }
    }
}
