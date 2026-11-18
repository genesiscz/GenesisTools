import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJSON, SafeJSON } from "@genesiscz/utils/json";
import type { RecordingSpan } from "@genesiscz/utils/meetings/record";
import type { AudioCaptureChange } from "@genesiscz/utils/screen-recorder/audio-session";
import { AUDIO_SOURCES, type AudioSource } from "@genesiscz/utils/screen-recorder/control";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";
import { AUDIO_INDEX, audioRowSchema, audioRowZeroMs } from "./sound";

type Interval = [number, number];
const savedRow = audioRowSchema.loose();
const missingMedia = audioRowSchema.pick({ source: true, at: true }).extend({
    event: z.literal("sound-loss"),
    lostSpans: audioRowSchema.shape.lostSpans.unwrap(),
});

/** Native writers tolerate 5 ms of timestamp jitter before declaring samples missing. */
function uncovered(from: number, to: number, excluded: Interval[]): Interval[] {
    const result: Interval[] = [];
    let cursor = from;
    for (const [start, end] of excluded) {
        if (start >= to) {
            break;
        }
        if (end <= cursor) {
            continue;
        }
        if (start - cursor > 5) {
            result.push([cursor, start]);
        }
        cursor = Math.max(cursor, end);
    }
    if (to - cursor > 5) {
        result.push([cursor, to]);
    }
    return result;
}

/** Runs with the recorder claim held, after all writers have closed and crash fragments have been salvaged.
 * Native writers can finish out of order. Compare the union of file times, never the order of JSON lines.
 */
export function markMeetingSoundLoss(options: {
    folder: string;
    files: ReadonlySet<string>;
    interruptedFrom?: number;
    spans: readonly RecordingSpan[];
    changes: readonly AudioCaptureChange[];
    sources: readonly AudioSource[];
    stoppedMs: number;
}): void {
    const { files, changes, interruptedFrom, stoppedMs } = options;
    if (!files.size && interruptedFrom === undefined && !changes.some((change) => change.kind === "failure")) {
        return;
    }
    const index = join(options.folder, AUDIO_INDEX);
    const original = existsSync(index) ? readFileSync(index, "utf8") : "";
    const lines = original ? original.split("\n") : [];
    if (lines.at(-1) === "") {
        lines.pop();
    }
    const savedLoss: Record<AudioSource, Interval[]> = { mic: [], system: [] };
    const entries = lines.flatMap((line, lineNumber) => {
        // Keep damaged lines and other writers' fields byte for byte.
        const raw = parseJSON<unknown>(line);
        const parsed = savedRow.safeParse(raw);
        if (!parsed.success) {
            const loss = missingMedia.safeParse(raw);
            if (loss.success) {
                const zero = Date.parse(loss.data.at);
                for (const [start, end] of loss.data.lostSpans) {
                    savedLoss[loss.data.source].push([zero + start, zero + end]);
                }
            }
            return [];
        }
        const row = parsed.data;
        const from = audioRowZeroMs(row);
        const end = from + row.durationMs;
        if (
            !Number.isFinite(end) ||
            (!files.has(row.file) && (interruptedFrom === undefined || end <= interruptedFrom))
        ) {
            return [];
        }
        return [{ row, from, end, lineNumber }];
    });
    const paused: Interval[] = [];
    for (const [i, span] of options.spans.entries()) {
        if (span.stopReason === "paused" && span.to) {
            const next = options.spans[i + 1];
            paused.push([Date.parse(span.to), next ? Date.parse(next.from) : stoppedMs]);
        }
    }
    let dirty = false;
    for (const source of AUDIO_SOURCES) {
        const excluded = [...paused, ...savedLoss[source]];
        let muted: number | undefined;
        for (const change of changes) {
            if (change.kind === "mute" && change.source === source) {
                if (change.muted) {
                    muted = change.atMs;
                } else if (muted !== undefined) {
                    excluded.push([muted, change.atMs]);
                    muted = undefined;
                }
            }
        }
        if (muted !== undefined) {
            excluded.push([muted, stoppedMs]);
        }
        excluded.sort(([a], [b]) => a - b);
        const reasonFor = (from: number, to: number, fallback: string) => {
            for (const change of changes) {
                if (
                    change.kind === "device" &&
                    change.source === source &&
                    change.atMs <= to &&
                    change.untilMs >= from
                ) {
                    return source === "mic" ? "microphone input changed" : "system output changed";
                }
                if (change.kind === "failure" && change.atMs >= from && change.atMs <= to) {
                    return change.reason;
                }
            }
            return fallback;
        };
        const tracks = entries.filter(({ row }) => row.source === source).sort((a, b) => a.from - b.from);
        const addGap = (track: (typeof tracks)[number], from: number, to: number, fallback: string) => {
            const row = track.row;
            const accounted = [...excluded];
            for (const [a, b] of row.lostSpans ?? []) {
                accounted.push([track.from + a, track.from + b]);
            }
            accounted.sort(([a], [b]) => a - b);
            for (const [start, end] of uncovered(from, to, accounted)) {
                const span: Interval = [start - track.from, end - track.from];
                row.lostSpans ??= [];
                row.lostSpanReasons ??= [];
                row.lostSpans.push(span);
                row.lostSpanReasons.push(reasonFor(start, end, fallback));
                lines[track.lineNumber] = SafeJSON.stringify(row);
                dirty = true;
            }
        };
        let previous: (typeof tracks)[number] | undefined;
        let uncertain = false;
        for (const track of tracks) {
            const { row, from } = track;
            if (row.clockGuess || row.durationGuess) {
                // There is recovered media here, but its sample interval could not be established.
                uncertain = true;
                continue;
            }
            if (row.lostSpans?.length && !row.lostSpanReasons) {
                row.lostSpanReasons = row.lostSpans.map(([a, b]) =>
                    reasonFor(from + a, from + b, "missing capture samples")
                );
                lines[track.lineNumber] = SafeJSON.stringify(row);
                dirty = true;
            }
            if (previous && !uncertain && from > previous.end) {
                const reason =
                    !files.has(previous.row.file) && files.has(row.file)
                        ? "recorder interrupted"
                        : previous.row.kept === undefined && row.kept === undefined
                          ? "screen piece restarted"
                          : "no samples between sound files";
                addGap(previous, previous.end, from, reason);
            }
            if (!previous || track.end > previous.end) {
                previous = track;
                uncertain = false;
            }
        }
        // With no next file, only a reported failure establishes loss. A normal stop can take
        // several seconds to finish after capture has already ended.
        if (!options.sources.includes(source)) {
            continue;
        }
        const failures = changes.filter((change) => change.kind === "failure");
        const first = failures[0];
        const last = failures.at(-1);
        if (
            first &&
            (!tracks[0] || (!tracks[0].row.clockGuess && !tracks[0].row.durationGuess && first.atMs < tracks[0].from))
        ) {
            // No preceding file owns these offsets. Media readers skip this explicitly fileless row.
            for (const [start, end] of uncovered(first.atMs, tracks[0]?.from ?? stoppedMs, excluded)) {
                lines.push(
                    SafeJSON.stringify({
                        event: "sound-loss",
                        source,
                        at: new Date(start).toISOString(),
                        lostSpans: [[0, end - start]],
                        lostSpanReasons: [first.reason],
                    })
                );
                dirty = true;
            }
        }
        if (previous && !uncertain && last && last.atMs >= previous.from) {
            addGap(previous, previous.end, stoppedMs, last.reason);
        }
    }
    if (dirty) {
        atomicWriteFileSync(index, `${lines.join("\n")}\n`);
    }
}
