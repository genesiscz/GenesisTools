import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
    defaultOcrLanguages,
    errorText,
    frameName,
    framesOnDisk,
    log,
    microphoneRefused,
    type NativeKeys,
    type RecorderDeps,
    type RecorderState,
    type RunRecorderOptions,
} from "@app/meetings/lib/recorder-shared";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { type MeetingsConfig, recorderSettings } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord, MeetingStore, RecordingBlock } from "@genesiscz/utils/meetings/record";
import type { AudioSegment } from "@genesiscz/utils/screen-recorder/audio-session";
import type { AudioState, RecorderSettings } from "@genesiscz/utils/screen-recorder/control";
import { PolicyDisplays } from "@genesiscz/utils/screen-recorder/display-choice";
import type { FrameOutput, KeptFrame } from "@genesiscz/utils/screen-recorder/frame-output";
import type { FrameRecording } from "@genesiscz/utils/screen-recorder/recording";
import type { PieceTarget } from "@genesiscz/utils/screen-recorder/targets";
import type { CaptureResult } from "@genesiscz/utils/screen-recorder/types";
import { CallTimeline } from "./call-timeline";
import { appendFrameIndex, readFrameIndex } from "./frame-index";
import { LiveOcrSettings, meetingOcrSettings, OCR_SETTINGS_FILE } from "./ocr-worker";
import { type RecorderStateFile, RecordingRecord } from "./recorder-adapters";
import { meetingMovieZeroMs } from "./recording-manifest";
import { AUDIO_FOLDER, appendAudioRow } from "./sound";
import { meetingSource, sourceRefOf } from "./sources";
import { RETRY_AFTER_MS, readAuto } from "./watch-auto";

/** How ax-tool names a capture's sound file. */
const SALVAGED_TRACK = /^audio-(?:\d+-)?(mic|system)\.m4a$/;

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
    readonly audioMode: "pieces" | "session";
    readonly nativeKeys: NativeKeys;
    readonly state: RecorderState;
    readonly notes: string[] = [];
    readonly recordingRecord: RecordingRecord;
    readonly displays: PolicyDisplays;
    private readonly stateFile: RecorderStateFile<RecorderState>;
    private failureNoticeOpen: boolean;
    /** When the current run of failed captures that the recording outlives began; undefined while captures work. */
    private strugglingSince?: number;
    /** The OCR settings the worker reads before each frame: written at the start and at each live change. */
    private readonly ocrSettings: LiveOcrSettings;
    private runFrames = 0;
    private audioFiles = 0;
    private zeroMs?: number;
    private microphoneDropped = false;

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
        this.ocrSettings = new LiveOcrSettings(join(this.folder, OCR_SETTINGS_FILE));
        const { audio: audioConfig, ...nativeKeys } = recorderSettings(capture, deps.recorder.id);
        this.nativeKeys = nativeKeys;
        this.audioMode = audioConfig?.mode ?? "pieces";
        this.settings = {
            activeFps: capture.activeFps,
            idleFps: capture.idleFps,
            threshold: capture.threshold * 100,
            maxLongSide: capture.resolutionCap,
            heartbeatSec: nativeKeys.heartbeatSec ?? 0,
            ocr: meetingOcrSettings(capture, options.ocrLanguages ?? defaultOcrLanguages()),
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

    /** The interrupted run's last indexed frame, or its start when no frame belongs to that run. */
    private lastFrameAt(): string {
        const open = this.recordingRecord.spans.at(-1);
        if (!open || open.to) {
            return this.state.startedAt;
        }

        const start = Date.parse(open.from);
        const restart = Date.parse(this.state.startedAt);
        let latest = start;
        for (const frame of readFrameIndex(this.folder)) {
            const at = Date.parse(frame.at);
            if (at >= start && at <= restart) {
                latest = Math.max(latest, at);
            }
        }

        return new Date(latest).toISOString();
    }

    /**
     * The loop starts: an empty piece folder, the state file, an open span, the record's recording block, and the
     * meeting's OCR worker.
     */
    async begin(recording: FrameRecording<string[]>): Promise<void> {
        this.salvageTracks(this.pieceDir);
        rmSync(this.pieceDir, { recursive: true, force: true });
        mkdirSync(this.pieceDir, { recursive: true });
        this.saveState();
        // A span still open here is a run whose process died without a stop: it ends at its last kept frame.
        this.recordingRecord.closeSpan("interrupted", this.lastFrameAt());
        this.recordingRecord.openSpan();
        await this.recordingRecord.start({
            startedAt: this.state.startedAt,
            backend: this.deps.recorder.id,
            displayPolicy: this.displays.policy,
            displaySpans: recording.displayBook.intervals,
        });

        // The second phase: the meeting's OCR worker follows the frame index until this recording stops.
        this.writeOcrSettings(recording);

        try {
            this.deps.startOcr(this.store, this.meetingId);
        } catch (err) {
            log.warn(
                { err, meeting: this.meetingId },
                "the OCR worker could not be started; the watcher starts it later"
            );
        }
    }

    /** A capture recorded again: an open failure notice in the record is cleared, and a "keeps failing" one is answered. */
    async captureWorksAgain(): Promise<void> {
        if (this.failureNoticeOpen) {
            this.failureNoticeOpen = false;
            await this.recordingRecord.update("capture works again", (recordingBlock) => {
                delete recordingBlock.failureNotifiedAt;
            });
        }

        if (this.strugglingSince !== undefined) {
            const lostSec = Math.round((Date.now() - this.strugglingSince) / 1000);
            this.strugglingSince = undefined;
            log.info({ lostSec, meeting: this.meetingId }, "capture works again after failures");

            if (this.capture.failureNotices !== "failing-and-recovered") {
                return;
            }

            await this.deps.notify({
                title: "Screen recording works again",
                message: `The capture records again after about ${lostSec} s of failures.`,
                open: this.folder,
            });
        }
    }

    /**
     * `count` captures in a row failed with an error the recording outlives (an ax-tool being rebuilt, a timeout): the
     * recording goes on trying, and says so once until a capture records again.
     */
    async captureStruggling(count: number, err: unknown): Promise<void> {
        if (this.strugglingSince !== undefined) {
            return;
        }

        this.strugglingSince = Date.now();
        this.note(`capture failed ${count} times in a row: ${errorText(err)}; it keeps trying`);
        log.warn({ err, count, meeting: this.meetingId }, "capture keeps failing; the recording keeps trying");

        if (this.capture.failureNotices === "off") {
            return;
        }

        await this.deps.notify({
            title: "Screen capture is failing",
            message: `${errorText(err)}. The recording keeps trying every minute until it works again.`,
            open: this.folder,
        });
    }

    /**
     * Moves a capture's `.m4a` files to the meeting's `audio/` and lists each in `audio.jsonl`, with `zeroAt`, the
     * wall time of the file's second 0, when the engine reported where the track started.
     */
    keepTracks(result: CaptureResult, target: PieceTarget): void {
        const audioDir = join(this.folder, AUDIO_FOLDER);

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
            appendAudioRow(this.folder, {
                file: `${AUDIO_FOLDER}/${name}`,
                source: track.source,
                at: at.toISOString(),
                durationMs: track.durationMs,
                mutedSpans: track.mutedSpans,
                ...(track.lostSpans !== undefined ? { lostSpans: track.lostSpans } : {}),
                ...(track.startOffsetMs !== undefined
                    ? { zeroAt: new Date(result.startedAtMs + track.startOffsetMs).toISOString() }
                    : {}),
            });
            this.audioFiles += 1;
        }
    }

    /** The engine has already moved and indexed a closed continuous sound segment. */
    keptSound(_segment: AudioSegment): void {
        this.audioFiles += 1;
    }

    /**
     * Moves every sound file a capture left in `dir` (a crash, a kill, a failed capture) to the meeting's `audio/`,
     * so clearing `dir` loses no sound. A file named as ax-tool names a track (`audio-<source>.m4a`) gets a row with
     * `kept: "salvaged"`, its start and length taken from the file's times; any other `.m4a` is moved without a row.
     * Answers how many files it kept.
     */
    salvageTracks(dir: string): number {
        let names: string[];

        try {
            names = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".m4a"));
        } catch (err) {
            if (err instanceof Error && "code" in err && err.code === "ENOENT") {
                return 0;
            }

            throw err;
        }

        const audioDir = join(this.folder, AUDIO_FOLDER);
        let kept = 0;

        for (const relative of names) {
            const path = join(dir, relative);
            const stat = statSync(path, { throwIfNoEntry: false });

            if (!stat?.isFile() || stat.size === 0) {
                continue;
            }

            const source = SALVAGED_TRACK.exec(basename(path))?.[1];
            const startMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
            const at = new Date(startMs);
            const stem = frameName(at, 0).replace(/\.jpg$/, `-${source ?? basename(path, ".m4a")}`);
            let name = `${stem}-salvaged.m4a`;

            for (let copy = 2; existsSync(join(audioDir, name)); copy++) {
                name = `${stem}-salvaged-${copy}.m4a`;
            }

            mkdirSync(audioDir, { recursive: true });
            renameSync(path, join(audioDir, name));
            kept += 1;

            if (source === "mic" || source === "system") {
                appendAudioRow(this.folder, {
                    file: `${AUDIO_FOLDER}/${name}`,
                    source,
                    at: at.toISOString(),
                    durationMs: Math.max(0, Math.round(stat.mtimeMs - startMs)),
                    mutedSpans: [],
                    kept: "salvaged",
                });
            }

            log.warn({ meeting: this.meetingId, from: path, to: name }, "kept a sound file a capture left behind");
        }

        if (kept > 0) {
            this.note(`kept ${kept} sound file(s) a capture left behind`);
        }

        return kept;
    }

    /**
     * A capture refused for the microphone grant: the recording goes on with the system sound only (the microphone
     * counts as muted, so the next capture leaves it out) and says so once. Answers whether it dropped it now.
     */
    dropRefusedMicrophone(recording: FrameRecording<string[]>, error: unknown): boolean {
        const audio = recording.audio;

        if (!microphoneRefused(error) || !audio.sources.includes("mic") || audio.muted.mic) {
            return false;
        }

        if (!this.microphoneDropped) {
            this.microphoneDropped = true;
            this.note("the microphone is not granted; the recording keeps the system sound only");
            log.warn({ meeting: this.meetingId }, "no microphone grant; recording the system sound only");
        }

        void recording.muteAudio("mic", true).catch((err: unknown) => {
            log.warn({ err, meeting: this.meetingId }, "the microphone could not be left out of the next capture");
        });
        return true;
    }

    /**
     * Keeps a capture's frames as JPEGs, each listed in the frame index for the OCR worker. `streamed`: the socket
     * announced them as they landed.
     */
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
        // A live OCR change (`settings.set`) reaches the worker before the frames it applies to are listed.
        this.writeOcrSettings(recording);

        for (const frame of [...result.frames].sort((a, b) => a.atMs - b.atMs)) {
            let kept: KeptFrame;

            try {
                kept = await output.keep(frame, {
                    atMs: result.startedAtMs + frame.atMs,
                    originMs: Date.parse(state.startedAt),
                    displayId: frame.displayId ?? target.displayId,
                });
                appendFrameIndex(this.folder, kept);
            } catch (err) {
                // A frame that cannot be kept (its conversion or its index line failed) costs that frame, not the recording.
                log.warn({ err, frame: frame.path }, "a frame could not be kept; frame skipped");
                continue;
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

    private writeOcrSettings(recording: FrameRecording<string[]>): void {
        try {
            this.ocrSettings.write(recording.settings.ocr);
        } catch (err) {
            log.warn(
                { err, meeting: this.meetingId },
                "the OCR settings could not be written; the worker keeps its own"
            );
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
