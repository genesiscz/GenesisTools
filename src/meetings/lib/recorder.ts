import { rmSync } from "node:fs";
import { join } from "node:path";
import { MeetingRun } from "@app/meetings/lib/meeting-run";
import {
    defaultDeps,
    errorText,
    log,
    MAX_FAILURES,
    meetingLiveId,
    type RecorderDeps,
    RecorderFailedError,
    type RecorderState,
    type RunRecorderOptions,
    readRecorderState,
    recorderFiles,
    STOP_ANSWER_MS,
} from "@app/meetings/lib/recorder-shared";
import { writeMeetingRecordingManifest } from "@app/meetings/lib/recording-manifest";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { RPC_ERRORS } from "@genesiscz/utils/screen-recorder/control";
import { FrameOutput, JsonlOcrSink } from "@genesiscz/utils/screen-recorder/frame-output";
import {
    captureErrorVerdict,
    defineRecorderConfig,
    FRAME_RECORDING_METHODS,
    FrameRecording,
} from "@genesiscz/utils/screen-recorder/recording";
import { settingsChange } from "@genesiscz/utils/screen-recorder/session";
import { CaptureError } from "@genesiscz/utils/screen-recorder/types";
import { collectRecord } from "./collect";
import { claimRecorderPid, RecorderStateFile } from "./recorder-adapters";

/**
 * The meetings recorder's configuration of the shared capture core. Its rules: one capture records the sound, the
 * controls are refused while it stops, each capture takes a settings change on its own, and the socket stays open a
 * moment for the stop answer. The meeting's own steps are the run's.
 */
function meetingRecorderConfig(run: MeetingRun) {
    const { store, meetingId, deps, state } = run;
    return defineRecorderConfig<string[]>((recording) => {
        const output = new FrameOutput({
            folder: run.folder,
            naming: "wall-clock",
            format: { kind: "jpeg", quality: run.capture.jpegQuality },
            convert: deps.toJpeg,
            ocr: {
                settings: () => recording.settings.ocr,
                sink: new JsonlOcrSink(join(run.folder, "ocr.jsonl")),
                recognize: deps.ocr,
                onError: (err, jpg) => log.warn({ err, jpg }, "OCR failed for a frame"),
            },
        });

        return {
            kind: "meeting",
            methods: FRAME_RECORDING_METHODS,
            recorder: deps.recorder,
            live: {
                id: meetingLiveId(meetingId),
                title: run.initial?.title || meetingId,
                folder: run.folder,
                dir: deps.liveDir,
            },
            history: {
                intervals: run.initial?.recording?.displaySpans ?? [],
                names: (run.initial?.recording?.displays ?? []).map((display) => [display.id, display.name]),
            },
            settings: run.settings,
            audio: run.audio,
            stopOnSignals: true,
            displays: run.displays,
            keptFrames: () => state.frames,
            pieces: {
                dir: run.pieceDir,
                sec: deps.pieceSec,
                // One capture records the sound: two would write the same microphone twice.
                audioOwnership: "single",
                request: (now) => ({ ...run.nativeKeys, heartbeatSec: now.heartbeatSec }),
                failures: {
                    max: MAX_FAILURES,
                    pauseMs: deps.failurePauseMs,
                    verdict: captureErrorVerdict,
                    gaveUp: (count, err) => {
                        run.note(`capture failed ${count} times in a row: ${errorText(err)}`);
                        state.stopReason = "failed";
                    },
                    recorded: () => run.captureWorksAgain(),
                },
            },
            controls: {
                whileStopping: "refused",
                unrecordedSource: RPC_ERRORS.invalidParams,
                // Each capture takes a change live or restarts on its own.
                settings: { scope: "each", change: settingsChange },
            },
            hooks: {
                beforeLoop: () => run.begin(recording),
                afterLoop: () => {
                    rmSync(run.pieceDir, { recursive: true, force: true });
                },
                onError: (err) => {
                    log.error({ err, meetingId }, "the recorder stopped on an error");
                    run.note(`the recorder stopped on an error: ${errorText(err)}`);
                    state.stopReason = "error";
                },
                onPaused: (at) => {
                    run.recordingRecord.closeSpan("paused", at);
                    state.paused = true;
                    run.saveState();
                    run.recordingRecord.markStatus("paused");
                },
                onResumed: () => {
                    run.recordingRecord.openSpan();
                    state.paused = false;
                    run.saveState();
                    run.recordingRecord.markStatus("recording");
                },
                onDisplays: () => {
                    state.displays = recording.displayBook.recorded;
                    run.saveState();
                },
                afterPiece: () => {
                    state.warning = run.notes.length > 0 ? run.notes.join("; ") : undefined;
                    recording.update({ lastFrameAt: state.lastFrameAt, warning: state.warning });
                    run.saveState();
                },
                captures: {
                    onResult: async (entry, result) => {
                        run.keepTracks(result, entry.target);
                        await recording.jobs.task("ocr", (ctx) =>
                            run.keepFrames({
                                recording,
                                output,
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
                            run.note(`${entry.target.label}: ${errorText(err)}`);
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
                            await run.summary(recording);
                            ctx.progress({ done: 1, total: 1, unit: "steps", message: `${state.frames} frames` });
                            return ctx.state;
                        },
                    },
                    {
                        name: "manifest",
                        run: async (ctx) => {
                            const current = store.read(meetingId);

                            if (current) {
                                writeMeetingRecordingManifest(run.folder, current);
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
        };
    });
}

/**
 * A failure outside the capture loop (the folders, the socket, the session) still leaves a terminal record before the
 * pidfile is released, so `record status` and the watcher never read a recording that is gone.
 */
async function saveFailedRun(store: MeetingStore, meetingId: string, err: unknown): Promise<void> {
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
}

/**
 * The recorder process (`tools meetings record run`): captures the screen in pieces until a stop (a live recording
 * command, `record stop`, or a signal), converts each new frame to JPEG under the meeting's `frames/`, runs Vision
 * OCR on it into `ocr.jsonl`, and keeps the meeting's `recording` block. Pause and resume end and start a span.
 */
export async function runRecorder(options: RunRecorderOptions): Promise<RecorderState> {
    const { store, meetingId } = options;
    const deps: RecorderDeps = { ...defaultDeps(options.capture), ...options.deps };
    const files = recorderFiles(store);
    const initial = store.read(meetingId);
    const claim = await claimRecorderPid(files.pid);
    let final: RecorderState;
    const stateFile = new RecorderStateFile<RecorderState>({
        state: files.state,
        last: join(store.folder(meetingId), "recorder-last.json"),
    });

    try {
        const run = new MeetingRun({ ...options, deps, initial, stateFile });
        const recording = new FrameRecording(meetingRecorderConfig(run));
        run.state.displaySpans = recording.displayBook.intervals;
        recording.open();
        await recording.finished;
        stateFile.retire();

        const { state } = run;
        log.info(
            { meetingId, frames: state.frames, bytes: state.bytes, stopReason: state.stopReason },
            "recording stopped"
        );
        final = state;
    } catch (err) {
        await saveFailedRun(store, meetingId, err);
        stateFile.retire();
        throw err;
    } finally {
        claim.release();
    }

    if (final.stopReason === "failed" || final.stopReason === "error") {
        throw new RecorderFailedError(final);
    }

    return final;
}

/** The live displays of a recorder state, for `record status`. */
export function stateDisplays(state: RecorderState): string {
    return state.displays?.length
        ? state.displays.map((display) => `${display.name} (${display.id})`).join(", ")
        : String(state.display);
}
