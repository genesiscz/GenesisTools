import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { RECORDING_MANIFEST, type RecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";

/** A frame line of `ocr.jsonl`: every frame the recorder kept has one, with its exact time (older rows lack the change). */
interface OcrLine {
    file?: unknown;
    at?: unknown;
    displayId?: unknown;
    changePercent?: unknown;
    reason?: unknown;
}

interface TimedFrame {
    at: number;
    displayId?: number;
    changePercent: number;
    reason: string;
}

/**
 * Writes `recording.json` into a meeting folder, so the recorder's menu, its library window and the editor list the
 * meeting's screen recording beside the library recordings (`tools recorder open <folder>` makes the proxy movie).
 * Frame times come from `ocr.jsonl`; a frame it lacks takes its file time. Returns undefined when there are no frames.
 */
export function writeMeetingRecordingManifest(folder: string, record: MeetingRecord): RecordingManifest | undefined {
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

            const row = SafeJSON.parse(line) as OcrLine;
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

    if (timed.size === 0) {
        return undefined;
    }

    const recording = record.recording;
    const first = Math.min(...[...timed.values()].map((frame) => frame.at));
    const started = recording?.startedAt ? Math.min(Date.parse(recording.startedAt), first) : first;
    const manifest: RecordingManifest = {
        version: 1,
        id: record.id,
        title: record.title,
        startedAt: new Date(started).toISOString(),
        ...(recording?.stoppedAt ? { endedAt: recording.stoppedAt } : {}),
        displays: (recording?.displays ?? []).map((display) => ({ id: display.id, name: display.name })),
        settings: { source: "meeting", meetingId: record.id },
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
