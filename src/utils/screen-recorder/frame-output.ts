import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { recognizeText } from "@genesiscz/utils/macos/ocr";
import type { OcrBlock, OcrResult } from "@genesiscz/utils/macos/types";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import type { RecorderSettings } from "./control";
import type { CapturedFrame, MotionBox } from "./types";

/**
 * Where a recording's kept frames go and what each gets beside it: a name under `frames/`, a format (the recorder's
 * own file, or a JPEG), and an OCR read into a sink. Both recorders use it: the library recording (`start.ts`) and
 * the meetings recorder, each with its own options.
 */

/** How a kept frame is named under `frames/`. */
export const FRAME_NAMINGS = ["elapsed", "wall-clock"] as const;
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

const FRAME_NAMERS: Record<FrameNaming, (input: FrameNameInput) => string> = {
    /** `00012345-d1.png`: the milliseconds after the start, so the names sort over a whole recording. */
    elapsed: ({ elapsedMs, displayId, ext }) =>
        `${String(Math.max(0, Math.round(elapsedMs))).padStart(8, "0")}-d${displayId}${ext}`,
    "wall-clock": ({ at, displayId, ext }) => wallClockFrameName(at, displayId, ext),
};

export function frameFileName(naming: FrameNaming, input: FrameNameInput): string {
    return FRAME_NAMERS[naming](input);
}

/** The recorder's own file (moved), or a JPEG at `quality` (0 to 1). */
export type FrameFormat = { kind: "original" } | { kind: "jpeg"; quality: number };

export type JpegConverter = (source: string, target: string, quality: number) => Promise<void>;
export type OcrRecognizer = (image: string, languages: string[]) => Promise<OcrResult>;

async function run(argv: string[]): Promise<{ exitCode: number; stderr: string }> {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stderr };
}

/** An image to a reduced JPEG with the system's own `sips`. */
export const sipsJpeg: JpegConverter = async (source, target, quality) => {
    const result = await run([
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
    ]);

    if (result.exitCode !== 0) {
        throw new Error(`sips failed for ${source}: ${result.stderr.trim()}`);
    }
};

export const visionOcr: OcrRecognizer = (image, languages) => recognizeText(image, { languages });

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
}

/** Where a kept frame's OCR goes. `row.text` is empty when the read held fewer than `minChars` characters. */
export interface OcrSink {
    write(row: OcrRow, framePath: string): void;
}

/** Every frame gets a line in one file, an empty read too: the meeting's `ocr.jsonl`. */
export class JsonlOcrSink implements OcrSink {
    constructor(readonly path: string) {}

    write(row: OcrRow): void {
        appendFileSync(this.path, `${SafeJSON.stringify(row)}\n`);
    }
}

/** A frame with text gets `<frame>.ocr.json` beside it (`{ text, blocks }`); a frame without text gets nothing. */
export class SidecarOcrSink implements OcrSink {
    write(row: OcrRow, framePath: string): void {
        if (row.text.trim().length === 0) {
            return;
        }

        atomicWriteFileSync(`${framePath}.ocr.json`, SafeJSON.stringify({ text: row.text, blocks: row.blocks }));
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
    /** The OCR read before the `minChars` cut; absent when OCR is off. */
    read?: OcrResult;
}

const EMPTY_READ: OcrResult = { text: "", blocks: [] };

/** Writes kept frames one at a time: the name, the format, and the OCR into its sink. */
export class FrameOutput {
    readonly framesDir: string;
    /** Names given out so far: two frames still converting must not share one. */
    private readonly named = new Set<string>();

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
        mkdirSync(this.framesDir, { recursive: true });

        if (format.kind === "jpeg") {
            await (this.options.convert ?? sipsJpeg)(frame.path, path, format.quality);
        } else if (existsSync(frame.path)) {
            renameSync(frame.path, path);
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
        const read = settings.enabled
            ? await (ocr.recognize ?? visionOcr)(path, settings.languages).catch((error: unknown) => {
                  ocr.onError?.(error, path);
                  return EMPTY_READ;
              })
            : undefined;
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
            },
            path
        );
        return read ? { ...kept, read } : kept;
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
