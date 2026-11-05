import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AudioSource, RecorderSettings, RecorderSettingsPatch } from "./control";
import type { PieceTarget } from "./targets";
import {
    type CapturedFrame,
    CaptureError,
    type CaptureHooks,
    type CaptureRequest,
    type CaptureResult,
    type LiveCapture,
} from "./types";

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
    /** The sound sources it started with: a source muted at its start is not among them. */
    audioSources: readonly AudioSource[];
    /** Where its recorder writes (`<pieceDir>/d<display>-<n>`). */
    outDir: string;
    done: Promise<void>;
}

/**
 * How a piece went: `recorded` when any capture returned (even without frames) and its stream did not fail, `frames`
 * how many it kept.
 */
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
            audioSources: withAudio && sound ? sound.sources : [],
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
                    // A capture whose stream failed returns what it kept before, but it did not record: a piece of
                    // only such captures failed.
                    if (result.endedEarly === "stream-error") {
                        outcome.lastError = new CaptureError("failed", "the capture stream failed");
                    } else {
                        outcome.recorded = true;
                    }

                    // The one capture that recorded the sound lost its display: the others record none, so the piece
                    // ends, and the next one gives the sound to a display that is still there.
                    if (
                        entry.audio &&
                        result.endedEarly === "display-removed" &&
                        this.options.audioOwnership !== "every"
                    ) {
                        for (const other of this.running.values()) {
                            if (other !== entry) {
                                other.controller.abort();
                            }
                        }
                    }

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

    /** Pauses in place when every running capture has a live channel; otherwise ends the running piece. */
    pause(): "live" | "aborted" {
        const captures = [...this.running.values()];

        if (captures.length > 0 && captures.every((one) => one.live)) {
            for (const one of captures) {
                one.live?.pause();
            }

            return "live";
        }

        this.abortAll();
        return "aborted";
    }

    resume(): void {
        for (const one of this.running.values()) {
            one.live?.resume();
        }
    }

    /** Sends a settings change to the running captures (`SettingsScope`); a capture that cannot take it restarts. */
    async applySettings(options: {
        change: SettingsChange;
        settings: RecorderSettings;
        scope: SettingsScope;
    }): Promise<"live" | "restart" | "next-piece"> {
        const { change, settings } = options;
        const captures = [...this.running.values()];

        if (options.scope === "all") {
            if (!captures.every((one) => takesLive(one.live, change))) {
                this.abortAll();
                return "restart";
            }

            await Promise.all(
                captures.map(async (one) => {
                    // One command after the other on each capture, as the recorder answers them in order.
                    if (change.rates) {
                        await one.live?.setRates?.(settings.activeFps, settings.idleFps);
                    }

                    if (change.threshold) {
                        await one.live?.setThreshold?.(settings.threshold);
                    }

                    if (change.longSide) {
                        await one.live?.setMaxLongSide?.(settings.maxLongSide);
                    }
                })
            );
            return "live";
        }

        const wanted = change.rates || change.threshold || change.longSide || change.restart;

        if (captures.length === 0 || !wanted) {
            return "next-piece";
        }

        let restarted = false;

        for (const one of captures) {
            if (!takesLive(one.live, change)) {
                one.controller.abort();
                restarted = true;
                continue;
            }

            await Promise.all(sendLive(one.live, change, settings));
        }

        return restarted ? "restart" : "live";
    }
}

/** The live commands a settings change needs; `restart`: a change no running capture takes live (the heartbeat). */
export interface SettingsChange {
    rates: boolean;
    threshold: boolean;
    longSide: boolean;
    restart: boolean;
}

/** The change between two settings, by value: a key set to the value it had changes nothing. */
export function settingsChange(before: RecorderSettings, after: RecorderSettings): SettingsChange {
    return {
        rates: after.activeFps !== before.activeFps || after.idleFps !== before.idleFps,
        threshold: after.threshold !== before.threshold,
        longSide: after.maxLongSide !== before.maxLongSide,
        restart: after.heartbeatSec !== before.heartbeatSec,
    };
}

/** The change a patch asks for, by the keys it gives (a key given its old value still sends its command). */
export function patchChange(patch: RecorderSettingsPatch): SettingsChange {
    return {
        rates: patch.activeFps !== undefined || patch.idleFps !== undefined,
        threshold: patch.threshold !== undefined,
        longSide: patch.maxLongSide !== undefined,
        restart: patch.heartbeatSec !== undefined,
    };
}

/**
 * How a settings change reaches the running captures. `each`: every capture takes it live when it has the commands,
 * and a capture that lacks one restarts on its own (no capture or nothing to send: the next piece takes it). `all`:
 * live only when every capture has every command, else every capture restarts.
 */
export const SETTINGS_SCOPES = ["each", "all"] as const;
export type SettingsScope = (typeof SETTINGS_SCOPES)[number];

function takesLive(live: LiveCapture | undefined, change: SettingsChange): live is LiveCapture {
    return Boolean(
        live &&
            !change.restart &&
            (!change.rates || live.setRates) &&
            (!change.threshold || live.setThreshold) &&
            (!change.longSide || live.setMaxLongSide)
    );
}

function sendLive(live: LiveCapture, change: SettingsChange, settings: RecorderSettings): Array<Promise<void>> {
    return [
        ...(change.rates && live.setRates ? [live.setRates(settings.activeFps, settings.idleFps)] : []),
        ...(change.threshold && live.setThreshold ? [live.setThreshold(settings.threshold)] : []),
        ...(change.longSide && live.setMaxLongSide ? [live.setMaxLongSide(settings.maxLongSide)] : []),
    ];
}
