import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AudioSource } from "./control";
import type { PieceTarget } from "./targets";
import type { CapturedFrame, CaptureHooks, CaptureRequest, CaptureResult, LiveCapture } from "./types";

/**
 * The capture coordination of a recording session, shared by the meetings recorder and the library recording: one
 * capture per target in a piece, the sound on one capture or on each, a capture started inside a running piece (a
 * display added over the socket) joining that piece, and the piece ending when every capture has ended. What a
 * client does with a capture's frames, errors and files is its hooks.
 */

/** One running capture of a piece. */
export interface SessionCapture {
    /** What it records now; a live display switch changes it. */
    target: PieceTarget;
    /** The display it started on. */
    readonly startDisplayId: number;
    controller: AbortController;
    /** Commands to the running capture without a restart, when the recorder offers them. */
    live?: LiveCapture;
    /** Frames that landed and were counted live, not kept yet. */
    streamed: number;
    /** This capture records the session's sound. */
    audio: boolean;
    /** Where its recorder writes (`<pieceDir>/d<display>-<n>`). */
    outDir: string;
    done: Promise<void>;
}

/** How a piece went: `recorded` when any capture returned (even without frames), `frames` how many it kept. */
export interface PieceOutcome {
    recorded: boolean;
    frames: number;
    lastError?: unknown;
    /** The captures this piece started, those added during it too. */
    count: number;
}

/** `single`: one capture records the sound, so two never record the same microphone; `every`: each capture does. */
export const AUDIO_OWNERSHIPS = ["single", "every"] as const;
export type AudioOwnership = (typeof AUDIO_OWNERSHIPS)[number];

export interface PieceCapturesOptions {
    capture: (request: CaptureRequest, signal: AbortSignal) => Promise<CaptureResult>;
    /** Each capture gets `<pieceDir>/d<display>-<n>`, numbered over the whole session. */
    pieceDir: string;
    /** The settings of a capture that starts now (read at its start, so a change reaches the next capture). */
    request: (target: PieceTarget) => Omit<CaptureRequest, "target" | "outDir" | "hooks" | "audio">;
    /** The sound to record now; no sources is none. */
    audio: () => { sources: AudioSource[]; micDeviceId?: string } | undefined;
    audioOwnership: AudioOwnership;
    hooks: {
        /** The capture is in `running` (the recorded displays may have changed). */
        onStart?: (capture: SessionCapture) => void;
        onFrame?: (capture: SessionCapture, frame: CapturedFrame) => void;
        onLive?: (capture: SessionCapture, channel: LiveCapture) => void;
        /**
         * The capture returned; the piece waits for this to finish (frames kept, tracks moved). `false`: it kept none
         * of them, so they do not count in `PieceOutcome.frames`.
         */
        onResult?: (capture: SessionCapture, result: CaptureResult) => Promise<boolean | undefined>;
        onError?: (capture: SessionCapture, error: unknown, outcome: PieceOutcome) => void;
        /** After the result or the error, once the capture left `running`. */
        onSettled?: (capture: SessionCapture) => void;
    };
}

export class PieceCaptures {
    /** The running captures, by the display each records. */
    readonly running = new Map<number, SessionCapture>();
    private readonly pending = new Set<SessionCapture>();
    private sequence = 0;
    private current: PieceOutcome = { recorded: false, frames: 0, count: 0 };
    /** True while a piece runs: a capture started now joins it. */
    inPiece = false;

    constructor(private readonly options: PieceCapturesOptions) {}

    /** Starts one capture (inside the running piece when there is one). */
    start(target: PieceTarget): SessionCapture {
        const outDir = join(this.options.pieceDir, `d${target.displayId}-${++this.sequence}`);
        mkdirSync(outDir, { recursive: true });
        const sound = this.options.audio();
        const withAudio =
            (sound?.sources.length ?? 0) > 0 &&
            (this.options.audioOwnership === "every" || ![...this.running.values()].some((one) => one.audio));
        const entry: SessionCapture = {
            target,
            startDisplayId: target.displayId,
            controller: new AbortController(),
            streamed: 0,
            audio: withAudio,
            outDir,
            done: Promise.resolve(),
        };
        this.running.set(target.displayId, entry);
        this.pending.add(entry);
        const outcome = this.current;
        outcome.count += 1;
        this.options.hooks.onStart?.(entry);
        const hooks: CaptureHooks = {
            onFrame: (frame) => this.options.hooks.onFrame?.(entry, frame),
            onLive: (channel) => {
                entry.live = channel;
                this.options.hooks.onLive?.(entry, channel);
            },
        };
        entry.done = this.options
            .capture(
                {
                    ...this.options.request(target),
                    target: target.target,
                    ...(withAudio && sound
                        ? {
                              audio: {
                                  sources: sound.sources,
                                  ...(sound.micDeviceId ? { micDeviceId: sound.micDeviceId } : {}),
                              },
                          }
                        : {}),
                    outDir,
                    hooks,
                },
                entry.controller.signal
            )
            .then(
                async (result) => {
                    outcome.recorded = true;
                    const kept = await this.options.hooks.onResult?.(entry, result);

                    if (kept !== false) {
                        outcome.frames += result.frames.length;
                    }
                },
                (error: unknown) => {
                    outcome.lastError = error;
                    this.options.hooks.onError?.(entry, error, outcome);
                }
            )
            .finally(() => {
                if (this.running.get(entry.target.displayId) === entry) {
                    this.running.delete(entry.target.displayId);
                }

                this.pending.delete(entry);
                this.options.hooks.onSettled?.(entry);
            });
        return entry;
    }

    /** One piece: every target at once, until each capture (and each one added meanwhile) has ended. */
    async runPiece(targets: readonly PieceTarget[]): Promise<PieceOutcome> {
        const outcome: PieceOutcome = { recorded: false, frames: 0, count: 0 };
        this.current = outcome;
        this.inPiece = true;

        try {
            for (const target of targets) {
                this.start(target);
            }

            while (this.pending.size > 0) {
                await Promise.race([...this.pending].map((one) => one.done));
            }
        } catch (error) {
            this.abortAll();
            await Promise.allSettled([...this.pending].map((one) => one.done));
            throw error;
        } finally {
            this.inPiece = false;
        }

        return outcome;
    }

    /** Ends every running capture; each returns what it kept so far. */
    abortAll(): void {
        for (const capture of this.running.values()) {
            capture.controller.abort();
        }
    }
}
