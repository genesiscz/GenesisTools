import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
    defaultOcrLanguages,
    EMPTY_FRAME_CHARS,
    frameName,
    framesOnDisk,
    log,
    type NativeKeys,
    type RecorderDeps,
    type RecorderState,
    type RunRecorderOptions,
} from "@app/meetings/lib/recorder-shared";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { type MeetingsConfig, recorderSettings } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord, MeetingStore, RecordingBlock } from "@genesiscz/utils/meetings/record";
import type { AudioState, RecorderSettings } from "@genesiscz/utils/screen-recorder/control";
import { PolicyDisplays } from "@genesiscz/utils/screen-recorder/display-choice";
import type { FrameOutput, KeptFrame } from "@genesiscz/utils/screen-recorder/frame-output";
import type { FrameRecording } from "@genesiscz/utils/screen-recorder/recording";
import type { PieceTarget } from "@genesiscz/utils/screen-recorder/targets";
import type { CaptureResult } from "@genesiscz/utils/screen-recorder/types";
import { CallTimeline } from "./call-timeline";
import { type RecorderStateFile, RecordingRecord } from "./recorder-adapters";
import { meetingMovieZeroMs } from "./recording-manifest";
import { meetingSource, sourceRefOf } from "./sources";
import { RETRY_AFTER_MS, readAuto } from "./watch-auto";

/**
 * One run of the meetings recorder: the meeting's folder and record, its spans, the recorder state file and the
 * notes. The shared core (`FrameRecording`) runs the capture loop; this keeps what is a meeting's own.
 */
export class MeetingRun {
    readonly store: MeetingStore;
    readonly meetingId: string;
    readonly capture: MeetingsConfig["global"]["capture"];
    readonly deps: RecorderDeps;
    /** The meeting's record when the run started. */
    readonly initial: MeetingRecord | undefined;
    readonly folder: string;
    readonly framesDir: string;
    readonly pieceDir: string;
    readonly settings: RecorderSettings;
    readonly audio: AudioState;
    readonly nativeKeys: NativeKeys;
    readonly state: RecorderState;
    readonly notes: string[] = [];
    readonly recordingRecord: RecordingRecord;
    readonly displays: PolicyDisplays;
    private readonly stateFile: RecorderStateFile<RecorderState>;
    private failureNoticeOpen: boolean;
    private runFrames = 0;
    private audioFiles = 0;
    private zeroMs?: number;

    constructor(
        options: RunRecorderOptions & {
            deps: RecorderDeps;
            initial: MeetingRecord | undefined;
            stateFile: RecorderStateFile<RecorderState>;
        }
    ) {
        const { store, meetingId, capture, deps, initial } = options;
        this.store = store;
        this.meetingId = meetingId;
        this.capture = capture;
        this.deps = deps;
        this.initial = initial;
        this.stateFile = options.stateFile;
        this.folder = store.folder(meetingId);
        this.framesDir = join(this.folder, "frames");
        this.pieceDir = join(this.folder, ".piece");
        const { audio: audioConfig, ...nativeKeys } = recorderSettings(capture, deps.recorder.id);
        this.nativeKeys = nativeKeys;
        this.settings = {
            activeFps: capture.activeFps,
            idleFps: capture.idleFps,
            threshold: capture.threshold * 100,
            maxLongSide: capture.resolutionCap,
            heartbeatSec: nativeKeys.heartbeatSec ?? 0,
            ocr: {
                enabled: true,
                languages: options.ocrLanguages ?? defaultOcrLanguages(),
                minChars: 0,
                threshold: capture.ocr.threshold * 100,
                skipTextless: capture.ocr.skipTextless,
                region: capture.ocr.region,
                read: capture.ocr.read,
            },
        };
        this.audio = {
            sources: options.audio ?? audioConfig?.sources ?? [],
            muted: { mic: false, system: false },
            ...(audioConfig?.micDevice ? { micDevice: audioConfig.micDevice } : {}),
        };
        const policy = options.display ?? capture.displays;
        mkdirSync(this.framesDir, { recursive: true });
        this.state = {
            meetingId,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            display: policy,
            backend: deps.recorder.id,
            frames: 0,
            bytes: 0,
        };
        this.recordingRecord = new RecordingRecord(store, meetingId, initial?.recording?.spans ?? []);
        this.failureNoticeOpen = Boolean(initial?.recording?.failureNotifiedAt);
        this.displays = new PolicyDisplays(policy, {
            note: (text) => this.note(text),
            onPolicy: (next) => {
                this.state.display = next;
            },
        });
    }

    note(text: string): void {
        if (!this.notes.includes(text)) {
            this.notes.push(text);
        }
    }

    saveState(): void {
        this.stateFile.save(this.state);
    }

    /**
     * Wall-clock ms of the meeting movie's time 0, read at the first marker: this run's start, or the first frame of an
     * earlier run. Every frame of this run comes later, so it holds for the whole run.
     */
    movieZeroMs(): number {
        this.zeroMs ??= meetingMovieZeroMs(this.folder, this.state.startedAt);
        return this.zeroMs;
    }

    /** The loop starts: an empty piece folder, the state file, an open span, and the record's recording block. */
    async begin(recording: FrameRecording<string[]>): Promise<void> {
        rmSync(this.pieceDir, { recursive: true, force: true });
        mkdirSync(this.pieceDir, { recursive: true });
        this.saveState();
        this.recordingRecord.openSpan();
        await this.recordingRecord.start({
            startedAt: this.state.startedAt,
            backend: this.deps.recorder.id,
            displayPolicy: this.displays.policy,
            displaySpans: recording.displayBook.intervals,
        });
    }

    /** A capture recorded again: an open failure notice in the record is cleared. */
    async captureWorksAgain(): Promise<void> {
        if (this.failureNoticeOpen) {
            this.failureNoticeOpen = false;
            await this.recordingRecord.update("capture works again", (recordingBlock) => {
                delete recordingBlock.failureNotifiedAt;
            });
        }
    }

    /** Moves a capture's `.m4a` files to the meeting's `audio/` and lists each in `audio.jsonl`. */
    keepTracks(result: CaptureResult, target: PieceTarget): void {
        const audioDir = join(this.folder, "audio");

        for (const track of result.tracks ?? []) {
            for (const warning of track.warnings ?? []) {
                log.warn({ display: target.label, source: track.source, warning }, "a sound track had a problem");
                this.note(`${target.label} ${track.source} sound: ${warning}`);
            }

            if (!track.path || !existsSync(track.path)) {
                continue;
            }

            const at = new Date(result.startedAtMs);
            const name = frameName(at, target.displayId).replace(/\.jpg$/, `-${track.source}.m4a`);
            mkdirSync(audioDir, { recursive: true });
            renameSync(track.path, join(audioDir, name));
            appendFileSync(
                join(this.folder, "audio.jsonl"),
                `${SafeJSON.stringify({ file: `audio/${name}`, source: track.source, at: at.toISOString(), durationMs: track.durationMs, mutedSpans: track.mutedSpans })}\n`
            );
            this.audioFiles += 1;
        }
    }

    /** Keeps a capture's frames as JPEGs with their OCR. `streamed`: the socket announced them as they landed. */
    async keepFrames({
        recording,
        output,
        result,
        target,
        streamed,
        onFrame,
    }: {
        recording: FrameRecording<string[]>;
        output: FrameOutput;
        result: CaptureResult;
        target: PieceTarget;
        streamed: boolean;
        onFrame: (done: number) => void;
    }): Promise<void> {
        const { state } = this;
        let done = 0;

        for (const frame of [...result.frames].sort((a, b) => a.atMs - b.atMs)) {
            let kept: KeptFrame;

            try {
                kept = await output.keep(frame, {
                    atMs: result.startedAtMs + frame.atMs,
                    originMs: Date.parse(state.startedAt),
                    displayId: frame.displayId ?? target.displayId,
                });
            } catch (err) {
                // A frame that cannot be kept (its conversion failed) costs that frame, not the recording.
                log.warn({ err, frame: frame.path }, "a frame could not be kept; frame skipped");
                continue;
            }

            if (kept.read && state.frames === 0 && kept.read.text.trim().length < EMPTY_FRAME_CHARS) {
                this.note(
                    `The first frame holds almost no readable text: Screen Recording may be missing (macOS then returns only the desktop; check ${toolCommand("control", "doctor")}), or the text is too small for capture.resolutionCap.`
                );
            }

            state.frames += 1;
            this.runFrames += 1;
            state.bytes += kept.bytes;
            state.lastFrameAt = kept.at.toISOString();

            if (!streamed) {
                recording.emit("frame", { displayId: kept.displayId, at: kept.at.toISOString(), file: kept.path });
            }

            done += 1;
            onFrame(done);
        }
    }

    /**
     * The finish's first step: the stop reason, the closed span, and the record's recording block with the frames on
     * disk, the sound files, the display intervals and the source's clock. A failed run notifies once.
     */
    async summary(recording: FrameRecording<string[]>): Promise<void> {
        await this.recordingRecord.settleStatuses();
        const { store, meetingId, state } = this;
        state.stopReason ??= "requested";

        if (this.runFrames === 0) {
            this.note(
                `No frame was recorded${state.stopReason === "requested" ? " before the stop" : ""}. Check the recorder: ${toolCommand("control", "doctor")}`
            );
        }

        state.warning = this.notes.length > 0 ? this.notes.join("; ") : undefined;
        this.recordingRecord.closeSpan(state.stopReason);
        this.saveState();
        const stoppedAt = new Date().toISOString();
        const total = existsSync(this.framesDir)
            ? framesOnDisk(this.framesDir)
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
                    startedAt: next.recording?.startedAt ?? state.startedAt,
                    stoppedAt,
                    // A restart that fails before its first frame keeps the totals of the earlier runs.
                    frames: Math.max(next.recording?.frames ?? 0, total.frames),
                    bytes: Math.max(next.recording?.bytes ?? 0, total.bytes),
                    status: "stopped",
                    stopReason: state.stopReason,
                    displayPolicy: this.displays.policy,
                    ...(this.audio.sources.length > 0
                        ? { audio: { sources: recording.audio.sources, files: this.audioFiles } }
                        : {}),
                    spans: this.recordingRecord.spans,
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
            await this.deps.notify({
                title: "Screen recording stopped",
                message: `${state.warning ?? "The capture failed."} ${byWatcher ? `It starts again every ${RETRY_AFTER_MS / 60_000} min while the meeting runs.` : `Start it again: ${toolCommand("meetings", "record", "start", "--meeting", meetingId)}`}`,
                open: this.folder,
            });
        }
    }
}
