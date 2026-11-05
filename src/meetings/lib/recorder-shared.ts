import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureBinaryAsync } from "@app/control/lib/runner";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { sendNotification } from "@genesiscz/utils/macos/notifications";
import {
    type DisplayPolicy,
    displayPolicySchema,
    languageSettings,
    type MeetingsConfig,
    meetingsConfigSchema,
    type recorderSettings,
} from "@genesiscz/utils/meetings/config";
import {
    type MeetingStore,
    RECORDING_STOP_REASONS,
    recordingDisplaySpanSchema,
} from "@genesiscz/utils/meetings/record";
import { inspectPidFile } from "@genesiscz/utils/process/pidfile";
import type { AudioSource } from "@genesiscz/utils/screen-recorder/control";
import {
    type JpegConverter,
    type OcrRecognizer,
    sipsJpeg,
    visionOcr,
    wallClockFrameName,
} from "@genesiscz/utils/screen-recorder/frame-output";
import { liveRecordingId } from "@genesiscz/utils/screen-recorder/live";
import { FRAME_RECORDERS } from "@genesiscz/utils/screen-recorder/recorders";
import type { FrameRecorder } from "@genesiscz/utils/screen-recorder/types";
import { z } from "zod";

export const { log } = logger.scoped("meetings-recorder");

/** One capture runs at most 180 s; shorter pieces also re-read the displays sooner. */
const CHUNK_SEC = 30;
/** Consecutive pieces in which every capture failed, after which the recorder gives up. */
export const MAX_FAILURES = 3;
const FAILURE_PAUSE_MS = 5_000;
/** The first frame's OCR finds less text than this: probably only the desktop, so the grant is likely missing. */
export const EMPTY_FRAME_CHARS = 20;
/** How long the socket stays open after the stop answer, so the answer reaches the caller. */
export const STOP_ANSWER_MS = 50;

/** Where the one running recording keeps its pid and its state. */
export function recorderFiles(store: MeetingStore): { pid: string; state: string } {
    return { pid: join(store.root, "recorder.pid"), state: join(store.root, "recorder.json") };
}

/** The live recording of a meeting's recorder, whose socket `record pause|resume|stop|display` and the menu bar call. */
export function meetingLiveId(meetingId: string): string {
    return liveRecordingId("meeting", meetingId);
}

const recorderStateSchema = z.object({
    meetingId: z.string(),
    pid: z.number(),
    startedAt: z.string(),
    /** The display policy (an index for a recorder from before the policies). */
    display: displayPolicySchema,
    backend: z.string().optional(),
    displays: z.array(z.object({ id: z.number(), name: z.string() })).optional(),
    /** When each display was captured so far, for `meetings screen` while the recording runs. */
    displaySpans: z.array(recordingDisplaySpanSchema).optional(),
    paused: z.boolean().optional(),
    frames: z.number(),
    bytes: z.number(),
    lastFrameAt: z.string().optional(),
    warning: z.string().optional(),
    stopReason: z.enum(RECORDING_STOP_REASONS).optional(),
});
export type RecorderState = z.infer<typeof recorderStateSchema>;

/** Whether the recorder that runs now is the one just started for this meeting: live, and its state written after the start. */
export function recorderAcknowledged(options: {
    current: { running: boolean; state?: RecorderState };
    meetingId: string;
    startedAfter: number;
}): boolean {
    const { current, meetingId, startedAfter } = options;
    return (
        current.running && current.state?.meetingId === meetingId && Date.parse(current.state.startedAt) >= startedAfter
    );
}

export function readRecorderState(store: MeetingStore): { running: boolean; state?: RecorderState } {
    const files = recorderFiles(store);
    const running = inspectPidFile(files.pid).status === "live";
    const parsed = existsSync(files.state)
        ? recorderStateSchema.safeParse(SafeJSON.parse(readFileSync(files.state, "utf8")))
        : undefined;
    return { running, ...(parsed?.success ? { state: parsed.data } : {}) };
}

/** `15-23-41-502-d4.jpg`: the frame's local wall time, sortable within a day, and its display. */
export function frameName(at: Date, displayId: number): string {
    return wallClockFrameName(at, displayId);
}

/** The frames a recording holds on disk, their size, and the count per display (from the `-d<id>` of the name). */
export function framesOnDisk(framesDir: string): { frames: number; bytes: number; perDisplay: Map<number, number> } {
    const files = readdirSync(framesDir).filter((name) => name.endsWith(".jpg"));
    const perDisplay = new Map<number, number>();

    for (const name of files) {
        const id = name.match(/-d(\d+)\.jpg$/)?.[1];

        if (id) {
            perDisplay.set(Number(id), (perDisplay.get(Number(id)) ?? 0) + 1);
        }
    }

    return {
        frames: files.length,
        bytes: files.reduce((sum, name) => sum + statSync(join(framesDir, name)).size, 0),
        perDisplay,
    };
}

/**
 * The recording ended on failed captures or an error. Its record, its state file and its notice are written already;
 * the rejection makes the recorder process (`record run`) report the failure too.
 */
export class RecorderFailedError extends Error {
    constructor(readonly state: RecorderState) {
        super(state.warning ?? `the recording stopped: ${state.stopReason}`);
        this.name = "RecorderFailedError";
    }
}

export interface RecorderNote {
    title: string;
    message: string;
    open?: string;
}

/** What the recorder uses beside the store, so a test can replace each part. */
export interface RecorderDeps {
    recorder: FrameRecorder;
    toJpeg: JpegConverter;
    ocr: OcrRecognizer;
    notify: (note: RecorderNote) => Promise<void>;
    /** Where the live recording entry goes (the genesis-tools root's `recordings/live/` by default). */
    liveDir?: string;
    pieceSec: number;
    failurePauseMs: number;
}

export function defaultOcrLanguages(): string[] {
    return languageSettings(meetingsConfigSchema.parse({})).ocr;
}

export function defaultDeps(capture: MeetingsConfig["global"]["capture"]): RecorderDeps {
    return {
        recorder: FRAME_RECORDERS[capture.backend]({ axTool: async (options) => [await ensureBinaryAsync(options)] }),
        toJpeg: sipsJpeg,
        ocr: visionOcr,
        notify: async (note) => {
            await sendNotification({ ...note, group: "meetings" }).catch((err: unknown) =>
                log.warn({ err }, "notification failed")
            );
        },
        pieceSec: CHUNK_SEC,
        failurePauseMs: FAILURE_PAUSE_MS,
    };
}

export function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** What `record run` passes the recorder. */
export interface RunRecorderOptions {
    store: MeetingStore;
    meetingId: string;
    capture: MeetingsConfig["global"]["capture"];
    /** The Vision OCR languages of the meeting language (`languages.<code>.ocr`); the default language's when omitted. */
    ocrLanguages?: string[];
    /** Overrides `capture.displays`. */
    display?: DisplayPolicy;
    /** Overrides `capture.recorders.<backend>.audio.sources`. */
    audio?: AudioSource[];
    deps?: Partial<RecorderDeps>;
}

/** The recorder's own keys of a capture request (`capture.recorders.<backend>`), without its sound. */
export type NativeKeys = Omit<ReturnType<typeof recorderSettings>, "audio">;
