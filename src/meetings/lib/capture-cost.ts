import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { readOcrRows } from "./screen-boxes";

/**
 * The CPU one kept frame costs: warm Vision OCR in the darwinkit helper (260 ms) plus the JPEG conversion (8.6 ms).
 * Measured by scripts/benchmarks/meetings-ocr/bench.ts on 40 frames of a real meeting (commit c15b15f99e, medians of
 * 3 runs, load average 35 to 50). Re-measure with that bench before changing it.
 */
export const KEPT_FRAME_CPU_MS = 268.6;
export const KEPT_FRAME_SOURCE = "scripts/benchmarks/meetings-ocr/bench.ts, 40 frames, commit c15b15f99e";

export const ACTIVE_FPS_CHOICES = [0.5, 1, 2] as const;
export const IDLE_FPS_CHOICES = [0.05, 0.1, 0.2] as const;
export const THRESHOLD_CHOICES = [0.01, 0.02, 0.05, 0.1] as const;

export interface CostChoice {
    value: number | string;
    /** CPU seconds per minute while the screen keeps changing: every frame kept, on every recorded display. */
    maxCpuSecPerMin: number;
}

export interface ThresholdChoice {
    value: number;
    /** The share of the last measured recording's frames this threshold keeps; absent when no recording stored it. */
    keptShare?: number;
    /** CPU seconds per minute at the last recording's frame rate scaled by `keptShare`. */
    cpuSecPerMin?: number;
}

export interface CaptureCost {
    keptFrameCpuMs: number;
    source: string;
    /** The newest stopped recording with frames: what this Mac really recorded. */
    observed?: {
        meeting: string;
        displays: number;
        minutes: number;
        frames: number;
        framesPerMin: number;
        cpuSecPerMin: number;
    };
    displays: CostChoice[];
    activeFps: CostChoice[];
    idleFps: CostChoice[];
    threshold: ThresholdChoice[];
    /** Why the threshold shares are missing, when they are. */
    thresholdNote?: string;
}

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

function recordedMinutes(record: MeetingRecord): number {
    const spans = record.recording?.spans ?? [];
    const ms = spans.reduce(
        (sum, span) => sum + Math.max(0, Date.parse(span.to ?? span.from) - Date.parse(span.from)),
        0
    );
    return ms / 60_000;
}

/** The per-frame change of the newest of the last five recordings that stored it; reads one file at most when found. */
function newestChangePercents(store: MeetingStore, records: MeetingRecord[]): number[] | undefined {
    const recent = [...records]
        .filter((record) => (record.recording?.frames ?? 0) > 0)
        .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
        .slice(0, 5);

    for (const record of recent) {
        const path = join(store.folder(record.id), "ocr.jsonl");

        if (!existsSync(path)) {
            continue;
        }

        const percents = readOcrRows(path).flatMap((row) =>
            row.changePercent !== undefined ? [row.changePercent] : []
        );

        if (percents.length > 0) {
            return percents;
        }
    }

    return undefined;
}

/**
 * What each capture choice costs in CPU, from the bench's cost per kept frame and the newest real recording. The
 * maximum assumes a screen that changes all the time; the observed rate is what a real meeting kept. Reads only.
 */
export function captureCost(options: {
    store: MeetingStore;
    records: MeetingRecord[];
    config: MeetingsConfig;
}): CaptureCost {
    const { capture } = options.config.global;
    const perFrameSec = KEPT_FRAME_CPU_MS / 1000;
    const newest = [...options.records]
        .filter((record) => (record.recording?.frames ?? 0) > 0 && recordedMinutes(record) >= 1)
        .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0];
    const connected = Math.max(1, newest?.recording?.displays?.length ?? 1);
    const displaysNow = capture.displays === "all" ? connected : 1;
    const max = (fps: number, displays: number) => round(fps * 60 * displays * perFrameSec);
    let observed: CaptureCost["observed"];

    const frames = newest?.recording?.frames ?? 0;

    if (newest && frames > 0) {
        const minutes = recordedMinutes(newest);
        const framesPerMin = frames / minutes;
        observed = {
            meeting: newest.id,
            displays: newest.recording?.displays?.length ?? 1,
            minutes: round(minutes),
            frames,
            framesPerMin: round(framesPerMin),
            cpuSecPerMin: round(framesPerMin * perFrameSec),
        };
    }

    const measured = newestChangePercents(options.store, options.records);

    return {
        keptFrameCpuMs: KEPT_FRAME_CPU_MS,
        source: KEPT_FRAME_SOURCE,
        ...(observed ? { observed } : {}),
        displays: [
            { value: "all", maxCpuSecPerMin: max(capture.activeFps, connected) },
            { value: "follow-focus", maxCpuSecPerMin: max(capture.activeFps, 1) },
            { value: "main", maxCpuSecPerMin: max(capture.activeFps, 1) },
        ],
        activeFps: ACTIVE_FPS_CHOICES.map((fps) => ({ value: fps, maxCpuSecPerMin: max(fps, displaysNow) })),
        idleFps: IDLE_FPS_CHOICES.map((fps) => ({ value: fps, maxCpuSecPerMin: max(fps, displaysNow) })),
        threshold: THRESHOLD_CHOICES.map((value): ThresholdChoice => {
            if (!measured) {
                return { value };
            }

            const keptShare = measured.filter((percent) => percent >= value * 100).length / measured.length;
            return {
                value,
                keptShare: round(keptShare, 3),
                ...(observed ? { cpuSecPerMin: round(observed.cpuSecPerMin * keptShare) } : {}),
            };
        }),
        ...(measured
            ? {}
            : {
                  thresholdNote:
                      "no recording here stores the change of each frame yet, so the share each threshold keeps is not measured",
              }),
    };
}
