import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
} from "node:fs";
import { join } from "node:path";
import { ensureBinaryAsync } from "@app/control/lib/runner";
import { writeMeetingRecordingManifest } from "@app/meetings/lib/recording-manifest";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { sendNotification } from "@genesiscz/utils/macos/notifications";
import {
    type DisplayPolicy,
    displayPolicySchema,
    languageSettings,
    type MeetingsConfig,
    meetingsConfigSchema,
    recorderSettings,
} from "@genesiscz/utils/meetings/config";
import {
    type MeetingStore,
    RECORDING_STOP_REASONS,
    type RecordingBlock,
    type RecordingStopReason,
    recordingDisplaySpanSchema,
} from "@genesiscz/utils/meetings/record";
import { inspectPidFile } from "@genesiscz/utils/process/pidfile";
import {
    type AudioSource,
    type AudioState,
    type RecorderMethod,
    type RecorderSettings,
    RPC_ERRORS,
} from "@genesiscz/utils/screen-recorder/control";
import { PolicyDisplays } from "@genesiscz/utils/screen-recorder/display-choice";
import {
    FrameOutput,
    type JpegConverter,
    JsonlOcrSink,
    type OcrRecognizer,
    sipsJpeg,
    visionOcr,
    wallClockFrameName,
} from "@genesiscz/utils/screen-recorder/frame-output";
import { liveRecordingId } from "@genesiscz/utils/screen-recorder/live";
import { FRAME_RECORDERS } from "@genesiscz/utils/screen-recorder/recorders";
import { FrameRecording } from "@genesiscz/utils/screen-recorder/recording";
import { settingsChange } from "@genesiscz/utils/screen-recorder/session";
import { type PieceTarget, pieceTargets } from "@genesiscz/utils/screen-recorder/targets";
import { CaptureError, type CaptureResult, type FrameRecorder } from "@genesiscz/utils/screen-recorder/types";
import { z } from "zod";
import { CallTimeline } from "./call-timeline";
import { collectRecord } from "./collect";
import { claimRecorderPid, RecorderStateFile, RecordingRecord } from "./recorder-adapters";
import { meetingSource, sourceRefOf } from "./sources";
import { RETRY_AFTER_MS, readAuto } from "./watch-auto";

const { log } = logger.scoped("meetings-recorder");

/** One capture runs at most 180 s; shorter pieces also re-read the displays sooner. */
const CHUNK_SEC = 30;
/** Consecutive pieces in which every capture failed, after which the recorder gives up. */
const MAX_FAILURES = 3;
const FAILURE_PAUSE_MS = 5_000;
/** The first frame's OCR finds less text than this: probably only the desktop, so the grant is likely missing. */
const EMPTY_FRAME_CHARS = 20;
/** How long the socket stays open after the stop answer, so the answer reaches the caller. */
const STOP_ANSWER_MS = 50;

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

/** The displays of a piece: moved to the shared capture session (`@genesiscz/utils/screen-recorder/targets`). */
export { pieceTargets };

const METHODS: readonly RecorderMethod[] = [
    "status",
    "pause",
    "resume",
    "stop",
    "displays.list",
    "displays.add",
    "displays.remove",
    "displays.switch",
    "displays.mode",
    "jobs.list",
    "audio.list",
    "audio.mute",
    "audio.setInput",
    "settings.get",
    "settings.set",
];

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

function defaultOcrLanguages(): string[] {
    return languageSettings(meetingsConfigSchema.parse({})).ocr;
}

function defaultDeps(capture: MeetingsConfig["global"]["capture"]): RecorderDeps {
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

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * The recorder process (`tools meetings record run`): captures the screen in pieces until a stop (a live recording
 * command, `record stop`, or a signal), converts each new frame to JPEG under the meeting's `frames/`, runs Vision
 * OCR on it into `ocr.jsonl`, and keeps the meeting's `recording` block. Pause and resume end and start a span.
 */
export async function runRecorder(options: {
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
}): Promise<RecorderState> {
    const { store, meetingId, capture } = options;
    const deps: RecorderDeps = { ...defaultDeps(capture), ...options.deps };
    const { audio: audioConfig, ...nativeKeys } = recorderSettings(capture, deps.recorder.id);
    const settings: RecorderSettings = {
        activeFps: capture.activeFps,
        idleFps: capture.idleFps,
        threshold: capture.threshold * 100,
        maxLongSide: capture.resolutionCap,
        heartbeatSec: nativeKeys.heartbeatSec ?? 0,
        ocr: { enabled: true, languages: options.ocrLanguages ?? defaultOcrLanguages(), minChars: 0 },
    };
    const audio: AudioState = {
        sources: options.audio ?? audioConfig?.sources ?? [],
        muted: { mic: false, system: false },
        ...(audioConfig?.micDevice ? { micDevice: audioConfig.micDevice } : {}),
    };
    const policy = options.display ?? capture.displays;
    const files = recorderFiles(store);
    const folder = store.folder(meetingId);
    const framesDir = join(folder, "frames");
    const pieceDir = join(folder, ".piece");
    const ocrPath = join(folder, "ocr.jsonl");
    const audioDir = join(folder, "audio");
    let audioFiles = 0;
    const record = store.read(meetingId);

    const claim = await claimRecorderPid(files.pid);
    const stateFile = new RecorderStateFile<RecorderState>({
        state: files.state,
        last: join(folder, "recorder-last.json"),
    });

    try {
        mkdirSync(framesDir, { recursive: true });
        const state: RecorderState = {
            meetingId,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            display: policy,
            backend: deps.recorder.id,
            frames: 0,
            bytes: 0,
        };
        const notes: string[] = [];
        const note = (text: string) => {
            if (!notes.includes(text)) {
                notes.push(text);
            }
        };
        const recordingRecord = new RecordingRecord(store, meetingId, record?.recording?.spans ?? []);
        const spans = recordingRecord.spans;
        let failureNoticeOpen = Boolean(record?.recording?.failureNotifiedAt);
        let runFrames = 0;
        const saveState = () => stateFile.save(state);
        const onSignal = () => recording.requestStop();
        const closeSpan = (stopReason: RecordingStopReason, at?: string) => recordingRecord.closeSpan(stopReason, at);
        /** Moves a capture's `.m4a` files to the meeting's `audio/` and lists each in `audio.jsonl`. */
        const keepTracks = (result: CaptureResult, target: PieceTarget): void => {
            for (const track of result.tracks ?? []) {
                if (!track.path || !existsSync(track.path)) {
                    continue;
                }

                const at = new Date(result.startedAtMs);
                const name = frameName(at, target.displayId).replace(/\.jpg$/, `-${track.source}.m4a`);
                mkdirSync(audioDir, { recursive: true });
                renameSync(track.path, join(audioDir, name));
                appendFileSync(
                    join(folder, "audio.jsonl"),
                    `${SafeJSON.stringify({ file: `audio/${name}`, source: track.source, at: at.toISOString(), durationMs: track.durationMs, mutedSpans: track.mutedSpans })}\n`
                );
                audioFiles += 1;
            }
        };

        const output = new FrameOutput({
            folder,
            naming: "wall-clock",
            format: { kind: "jpeg", quality: capture.jpegQuality },
            convert: deps.toJpeg,
            ocr: {
                settings: () => recording.settings.ocr,
                sink: new JsonlOcrSink(ocrPath),
                recognize: deps.ocr,
                onError: (err, jpg) => log.warn({ err, jpg }, "OCR failed for a frame"),
            },
        });

        /** `streamed`: the socket announced these frames as they landed already. */
        const keepFrames = async ({
            result,
            target,
            streamed,
            onFrame = () => undefined,
        }: {
            result: CaptureResult;
            target: PieceTarget;
            streamed: boolean;
            onFrame?: (done: number) => void;
        }): Promise<void> => {
            let done = 0;

            for (const frame of [...result.frames].sort((a, b) => a.atMs - b.atMs)) {
                const kept = await output.keep(frame, {
                    atMs: result.startedAtMs + frame.atMs,
                    originMs: Date.parse(state.startedAt),
                    displayId: frame.displayId ?? target.displayId,
                });

                if (kept.read && state.frames === 0 && kept.read.text.trim().length < EMPTY_FRAME_CHARS) {
                    note(
                        `The first frame holds almost no readable text: Screen Recording may be missing (macOS then returns only the desktop; check ${toolCommand("control", "doctor")}), or the text is too small for capture.resolutionCap.`
                    );
                }

                state.frames += 1;
                runFrames += 1;
                state.bytes += kept.bytes;
                state.lastFrameAt = kept.at.toISOString();

                if (!streamed) {
                    recording.emit("frame", { displayId: kept.displayId, at: kept.at.toISOString(), file: kept.path });
                }

                done += 1;
                onFrame(done);
            }
        };

        const displays = new PolicyDisplays(policy, {
            note,
            onPolicy: (next) => {
                state.display = next;
            },
        });
        const recording: FrameRecording<string[]> = new FrameRecording<string[]>({
            kind: "meeting",
            methods: METHODS,
            recorder: deps.recorder,
            live: { id: meetingLiveId(meetingId), title: record?.title || meetingId, folder, dir: deps.liveDir },
            history: {
                intervals: record?.recording?.displaySpans ?? [],
                names: (record?.recording?.displays ?? []).map((display) => [display.id, display.name]),
            },
            settings,
            audio,
            displays,
            keptFrames: () => state.frames,
            pieces: {
                dir: pieceDir,
                sec: deps.pieceSec,
                // One capture records the sound: two would write the same microphone twice.
                audioOwnership: "single",
                request: (now) => ({ ...nativeKeys, heartbeatSec: now.heartbeatSec }),
                failures: {
                    max: MAX_FAILURES,
                    pauseMs: deps.failurePauseMs,
                    // Only a capture fails a piece; anything else (a frame that cannot be converted) ends the
                    // recording.
                    verdict: ({ outcome, error }, now) => {
                        const failure =
                            error ??
                            (outcome && !outcome.recorded && !now.paused && !now.stopping
                                ? outcome.lastError
                                : undefined);

                        if (failure === undefined) {
                            return outcome?.recorded ? "recorded" : "neither";
                        }

                        if (failure instanceof CaptureError) {
                            return "failed";
                        }

                        throw failure;
                    },
                    gaveUp: (count, err) => {
                        note(`capture failed ${count} times in a row: ${errorText(err)}`);
                        state.stopReason = "failed";
                    },
                    recorded: async () => {
                        if (failureNoticeOpen) {
                            failureNoticeOpen = false;
                            await recordingRecord.update("capture works again", (recordingBlock) => {
                                delete recordingBlock.failureNotifiedAt;
                            });
                        }
                    },
                },
            },
            controls: {
                whileStopping: "refused",
                unrecordedSource: RPC_ERRORS.invalidParams,
                // Each capture takes a change live or restarts on its own.
                settings: { scope: "each", change: settingsChange },
            },
            hooks: {
                beforeLoop: async () => {
                    process.on("SIGTERM", onSignal);
                    process.on("SIGINT", onSignal);
                    rmSync(pieceDir, { recursive: true, force: true });
                    mkdirSync(pieceDir, { recursive: true });
                    saveState();
                    recordingRecord.openSpan();
                    await recordingRecord.start({
                        startedAt: state.startedAt,
                        backend: deps.recorder.id,
                        displayPolicy: displays.policy,
                        displaySpans: recording.displayBook.intervals,
                    });
                },
                afterLoop: () => {
                    process.off("SIGTERM", onSignal);
                    process.off("SIGINT", onSignal);
                    rmSync(pieceDir, { recursive: true, force: true });
                },
                onError: (err) => {
                    log.error({ err, meetingId }, "the recorder stopped on an error");
                    note(`the recorder stopped on an error: ${errorText(err)}`);
                    state.stopReason = "error";
                },
                onPaused: (at) => {
                    closeSpan("paused", at);
                    state.paused = true;
                    saveState();
                    recordingRecord.markStatus("paused");
                },
                onResumed: () => {
                    recordingRecord.openSpan();
                    state.paused = false;
                    saveState();
                    recordingRecord.markStatus("recording");
                },
                onDisplays: () => {
                    state.displays = recording.displayBook.recorded;
                    saveState();
                },
                afterPiece: () => {
                    state.warning = notes.length > 0 ? notes.join("; ") : undefined;
                    recording.update({ lastFrameAt: state.lastFrameAt, warning: state.warning });
                    saveState();
                },
                captures: {
                    onResult: async (entry, result) => {
                        keepTracks(result, entry.target);
                        await recording.jobs.task("ocr", (ctx) =>
                            keepFrames({
                                result,
                                target: entry.target,
                                streamed: entry.streamed > 0,
                                onFrame: (done) => ctx.progress({ done, total: result.frames.length, unit: "frames" }),
                            })
                        ).done;

                        if (result.endedEarly === "display-removed") {
                            log.info({ display: entry.target.label }, "a display left during a piece");
                        }

                        return undefined;
                    },
                    onError: (entry, err, outcome) => {
                        if (err instanceof CaptureError && err.kind === "display-missing") {
                            log.info({ display: entry.target.label }, "a display left before its capture");
                            return;
                        }

                        log.warn({ err, display: entry.target.label }, "a capture failed");

                        if (outcome.count > 1) {
                            note(`${entry.target.label}: ${errorText(err)}`);
                        }
                    },
                    onSettled: (entry) => rmSync(entry.outDir, { recursive: true, force: true }),
                },
            },
            finish: {
                kind: "finish",
                id: `finish-${meetingId}-${Date.now()}`,
                initial: [],
                steps: [
                    {
                        name: "summary",
                        run: async (ctx) => {
                            await finishRecording();
                            ctx.progress({ done: 1, total: 1, unit: "steps", message: `${state.frames} frames` });
                            return ctx.state;
                        },
                    },
                    {
                        name: "manifest",
                        run: async (ctx) => {
                            const current = store.read(meetingId);

                            if (current) {
                                writeMeetingRecordingManifest(folder, current);
                            }

                            return ctx.state;
                        },
                    },
                    {
                        name: "collect",
                        run: async () => {
                            const current = store.read(meetingId);
                            return current ? (await collectRecord(store, current)).notes.map((one) => one.text) : [];
                        },
                    },
                ],
                answer: (finishNotes, job) => ({
                    state: "stopped",
                    outcome: state.stopReason,
                    job,
                    frames: state.frames,
                    notes: finishNotes,
                }),
                failed: (err, job) => {
                    log.error({ err, meetingId }, "the recording summary could not be written");
                    return { state: "stopped", outcome: state.stopReason, job, frames: state.frames };
                },
                closeReason: () => state.stopReason,
                // A waiting `stop` call gets its answer before the socket closes.
                closeAfterMs: STOP_ANSWER_MS,
            },
        });
        state.displaySpans = recording.displayBook.intervals;
        recording.open();
        await recording.finished;
        stateFile.retire();

        log.info(
            { meetingId, frames: state.frames, bytes: state.bytes, stopReason: state.stopReason },
            "recording stopped"
        );
        return state;

        async function finishRecording(): Promise<void> {
            state.stopReason ??= "requested";

            if (runFrames === 0) {
                note(
                    `No frame was recorded${state.stopReason === "requested" ? " before the stop" : ""}. Check the recorder: ${toolCommand("control", "doctor")}`
                );
            }

            state.warning = notes.length > 0 ? notes.join("; ") : undefined;
            closeSpan(state.stopReason);
            saveState();
            const stoppedAt = new Date().toISOString();
            const total = existsSync(framesDir)
                ? framesOnDisk(framesDir)
                : { frames: 0, bytes: 0, perDisplay: new Map() };
            const current = store.read(meetingId);
            const ref = current ? sourceRefOf(current) : undefined;
            const sourceClock = ref
                ? await (async () =>
                      CallTimeline.sourceClock({
                          source: await meetingSource(ref.sourceId),
                          sourceMeetingId: ref.sourceMeetingId,
                      }))().catch((err: unknown) => {
                      log.warn({ err, meetingId }, "source clock unavailable; finalizing without it");
                      return undefined;
                  })
                : undefined;
            const clock = sourceClock?.source
                ? { source: sourceClock.source, startedAt: sourceClock.startedAt }
                : undefined;

            const failed = state.stopReason === "failed" || state.stopReason === "error";
            const notifyFailure = failed && !current?.recording?.failureNotifiedAt;
            await store.update(
                meetingId,
                {
                    command: "record stop",
                    change: `${state.frames} frames, ${Math.round(state.bytes / 1_000_000)} MB${total.frames > state.frames ? ` (${total.frames} frames, ${Math.round(total.bytes / 1_000_000)} MB in all)` : ""}, ${state.stopReason}${state.warning && failed ? `, ${state.warning}` : ""}`,
                },
                (next) => {
                    const recordingBlock: RecordingBlock = {
                        ...next.recording,
                        startedAt: state.startedAt,
                        stoppedAt,
                        frames: total.frames,
                        bytes: total.bytes,
                        status: "stopped",
                        stopReason: state.stopReason,
                        displayPolicy: displays.policy,
                        ...(audio.sources.length > 0
                            ? { audio: { sources: recording.audio.sources, files: audioFiles } }
                            : {}),
                        spans,
                        displaySpans: recording.displayBook.intervals,
                        displays: [...recording.displayBook.names].map(([id, name]) => ({
                            id,
                            name,
                            frames: total.perDisplay.get(id) ?? 0,
                        })),
                        ...(clock ? { clock } : {}),
                        ...(notifyFailure ? { failureNotifiedAt: stoppedAt } : {}),
                    };

                    if (state.warning) {
                        recordingBlock.warning = state.warning;
                    } else {
                        delete recordingBlock.warning;
                    }

                    next.recording = recordingBlock;
                }
            );

            if (notifyFailure) {
                const byWatcher = readAuto(store)?.meetingId === meetingId;
                await deps.notify({
                    title: "Screen recording stopped",
                    message: `${state.warning ?? "The capture failed."} ${byWatcher ? `It starts again every ${RETRY_AFTER_MS / 60_000} min while the meeting runs.` : `Start it again: ${toolCommand("meetings", "record", "start", "--meeting", meetingId)}`}`,
                    open: folder,
                });
            }
        }
    } catch (err) {
        // A failure outside the capture loop (the folders, the socket, the session) still leaves a terminal record
        // before the pidfile is released, so `record status` and the watcher never read a recording that is gone.
        const warning = errorText(err);
        const last = readRecorderState(store).state;
        await store
            .update(meetingId, { command: "record stop", change: `error: ${warning}` }, (current) => {
                current.recording = {
                    ...current.recording,
                    status: "stopped",
                    stopReason: "error",
                    stoppedAt: new Date().toISOString(),
                    frames: last?.frames ?? current.recording?.frames ?? 0,
                    bytes: last?.bytes ?? current.recording?.bytes ?? 0,
                    warning,
                };
            })
            .catch((persistErr: unknown) =>
                log.warn({ err: persistErr, meetingId }, "the failed recording could not be saved")
            );
        stateFile.retire();
        throw err;
    } finally {
        claim.release();
    }
}

/** The live displays of a recorder state, for `record status`. */
export function stateDisplays(state: RecorderState): string {
    return state.displays?.length
        ? state.displays.map((display) => `${display.name} (${display.id})`).join(", ")
        : String(state.display);
}
