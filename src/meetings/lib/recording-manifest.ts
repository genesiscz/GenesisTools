import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { RECORDING_MANIFEST, type RecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";

const { log } = logger.scoped("meetings-recording-manifest");

/** A frame line of `ocr.jsonl`: every frame the recorder kept has one, with its exact time (older rows lack the change). */
interface OcrLine {
    file?: unknown;
    at?: unknown;
    displayId?: unknown;
    changePercent?: unknown;
    reason?: unknown;
}

function isOcrLine(value: unknown): value is OcrLine {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One `ocr.jsonl` row, or undefined for a row an interrupted run cut short (its frame then takes its file time). */
function parseOcrLine(line: string, ocrPath: string): OcrLine | undefined {
    let row: unknown;

    try {
        row = SafeJSON.parse(line);
    } catch (error) {
        log.debug({ ocrPath, error }, "skipped an unreadable ocr.jsonl row");
        return undefined;
    }

    if (!isOcrLine(row)) {
        log.debug({ ocrPath, row }, "skipped an ocr.jsonl row that is not an object");
        return undefined;
    }

    return row;
}

interface TimedFrame {
    at: number;
    displayId?: number;
    changePercent: number;
    reason: string;
}

/** When each kept frame was taken: its `ocr.jsonl` row, else its file time; undefined without a `frames/` folder. */
function frameTimes(folder: string): Map<string, TimedFrame> | undefined {
    const framesDir = join(folder, "frames");

    if (!existsSync(framesDir)) {
        return undefined;
    }

    const timed = new Map<string, TimedFrame>();
    const ocrPath = join(folder, "ocr.jsonl");

    if (existsSync(ocrPath)) {
        for (const line of readFileSync(ocrPath, "utf8").split("\n")) {
            if (!line.trim()) {
                continue;
            }

            const row = parseOcrLine(line, ocrPath);

            if (!row) {
                continue;
            }

            const at = typeof row.at === "string" ? Date.parse(row.at) : Number.NaN;

            if (typeof row.file === "string" && Number.isFinite(at)) {
                timed.set(row.file, {
                    at,
                    displayId: typeof row.displayId === "number" ? row.displayId : undefined,
                    changePercent: typeof row.changePercent === "number" ? row.changePercent : 0,
                    reason: typeof row.reason === "string" ? row.reason : "change",
                });
            }
        }
    }

    for (const name of readdirSync(framesDir)) {
        const file = join("frames", name);

        if (/\.(jpe?g|png)$/i.test(name) && !timed.has(file)) {
            const display = /-d(\d+)\.\w+$/.exec(name);
            timed.set(file, {
                at: statSync(join(framesDir, name)).mtimeMs,
                displayId: display ? Number(display[1]) : undefined,
                changePercent: 0,
                reason: "change",
            });
        }
    }

    return timed;
}

/** Wall-clock ms of the movie's time 0: the recording's start, or its first frame when that came earlier. */
function movieZeroMs(startedAt: string | undefined, frames: Iterable<TimedFrame>): number {
    const first = Math.min(...[...frames].map((frame) => frame.at));
    return startedAt ? Math.min(Date.parse(startedAt), first) : first;
}

/**
 * Wall-clock ms of time 0 of a meeting's movie while it records from `startedAt`: that start, or the first frame of an
 * earlier run. The manifest counts the frames and the markers from this time.
 */
export function meetingMovieZeroMs(folder: string, startedAt: string): number {
    return movieZeroMs(startedAt, frameTimes(folder)?.values() ?? []);
}

/**
 * Writes `recording.json` into a meeting folder, so the recorder's menu, its library window and the editor list the
 * meeting's screen recording beside the library recordings (`tools recorder open <folder>` makes the proxy movie).
 * Frame times come from `ocr.jsonl`; a frame it lacks takes its file time. The record's markers go into
 * `settings.markers` at their movie time. Returns undefined when there are no frames.
 */
export function writeMeetingRecordingManifest(folder: string, record: MeetingRecord): RecordingManifest | undefined {
    const timed = frameTimes(folder);

    if (!timed || timed.size === 0) {
        return undefined;
    }

    const recording = record.recording;
    const started = movieZeroMs(recording?.startedAt, timed.values());
    const markers = (recording?.markers ?? []).map((marker) => ({
        atMs: Math.max(0, Math.round(Date.parse(marker.at) - started)),
        label: marker.label,
    }));
    const manifest: RecordingManifest = {
        version: 1,
        id: record.id,
        title: record.title,
        startedAt: new Date(started).toISOString(),
        ...(recording?.stoppedAt ? { endedAt: recording.stoppedAt } : {}),
        displays: (recording?.displays ?? []).map((display) => ({ id: display.id, name: display.name })),
        settings: { source: "meeting", meetingId: record.id, ...(markers.length > 0 ? { markers } : {}) },
        frames: [...timed]
            .sort((a, b) => a[1].at - b[1].at || a[0].localeCompare(b[0]))
            .map(([file, frame]) => ({
                file,
                atMs: Math.max(0, Math.round(frame.at - started)),
                ...(frame.displayId === undefined ? {} : { displayId: frame.displayId }),
                changePercent: frame.changePercent,
                reason: frame.reason,
            })),
        warnings: [],
    };
    atomicWriteFileSync(join(folder, RECORDING_MANIFEST), SafeJSON.stringify(manifest, null, 2));
    return manifest;
}
