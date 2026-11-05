import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { z } from "zod";
import { AUDIO_SOURCES, type AudioDevices, type AudioSource } from "./control";
import { mainDisplay, outputScaleFor, parseDisplayList } from "./displays";
import { runCaptureProcess } from "./process";
import {
    CAPTURE_ENDINGS,
    CAPTURE_TIMEOUT_GRACE_MS,
    type CapturedFrame,
    CaptureError,
    type CaptureErrorKind,
    type CaptureHooks,
    type CaptureRequest,
    type CaptureResult,
    type DisplayInfo,
    FrameRecorder,
    type FrameRecorderContext,
    type FrameRecorderSupport,
    type LiveCapture,
    MAX_CAPTURE_SECONDS,
} from "./types";

const { log } = logger.scoped("screen-recorder-native");

/** The `ax-tool capture` options that came after the first release; each is used only when `--help` names it. */
export const NATIVE_OPTIONAL_FLAGS = [
    "--display-id",
    "--follow-focus",
    "--max-long-side",
    "--quiet-ms",
    "--heartbeat-sec",
    "--max-mb",
    "--control-stdin",
    "--audio",
    "--mic-device",
    "--audio-sidecar",
    "audio-devices",
    // `--control-stdin` commands, named in the same help text.
    "mute",
    "set-mic",
    "set-fps",
    "set-threshold",
    "set-max-long-side",
] as const;
export type NativeOptionalFlag = (typeof NATIVE_OPTIONAL_FLAGS)[number];

const HELP_TIMEOUT_MS = 10_000;
const SCREENS_TIMEOUT_MS = 10_000;

const nativeFrame = z.object({
    path: z.string(),
    timestampMs: z.number(),
    changePercent: z.number().default(0),
    reason: z.string().default("change"),
    displayId: z.number().optional(),
    motionBoxes: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).optional(),
});
const nativeTrack = z.object({
    source: z.enum(AUDIO_SOURCES),
    path: z.string().optional(),
    durationMs: z.number().default(0),
    peakDbfs: z.number().nullable().optional(),
    mutedSpans: z.array(z.tuple([z.number(), z.number()])).default([]),
});
const nativeResult = z.object({
    data: z.object({
        frames: z.array(nativeFrame).default([]),
        tracks: z.array(nativeTrack).optional(),
        cancelled: z.boolean().optional(),
        endedEarly: z.enum(CAPTURE_ENDINGS).optional(),
        stats: z.record(z.string(), z.number()).optional(),
    }),
});
const nativeError = z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() });

/**
 * The flags the ax-tool help names, read once per binary and process. `ax-tool --help` documents the capture options;
 * `ax-tool capture --help` would parse as a capture.
 */
const helpCache = new Map<string, Promise<Set<NativeOptionalFlag>>>();

export function flagsInHelp(text: string): Set<NativeOptionalFlag> {
    return new Set(NATIVE_OPTIONAL_FLAGS.filter((flag) => new RegExp(`(?<![\\w-])${flag}(?![\\w-])`).test(text)));
}

function detectFlags(axTool: string[]): Promise<Set<NativeOptionalFlag>> {
    const key = axTool.join("\0");
    let cached = helpCache.get(key);

    if (!cached) {
        cached = boundedCommand({ command: [...axTool, "--help"], timeoutMs: HELP_TIMEOUT_MS }).then((result) => {
            if (result.status !== 0) {
                helpCache.delete(key);
                return new Set<NativeOptionalFlag>();
            }

            const flags = flagsInHelp(`${result.stdout}\n${result.stderr}`);
            log.debug({ axTool, flags: [...flags] }, "ax-tool capture options");
            return flags;
        });
        cached = cached.catch((error: unknown) => {
            helpCache.delete(key);
            throw error;
        });
        helpCache.set(key, cached);
    }

    return cached;
}

/** Which kind of failure an error code (from the recorder's JSON) or its message names. */
export function captureErrorKind(code: string | undefined, message: string): CaptureErrorKind {
    if (code === "display-missing" || code === "no-permission") {
        return code;
    }

    if (code === "invalid-argument" || code === "failed") {
        return "failed";
    }

    if (
        /screen.index (outside|\d+ not found)|display.*(missing|not connected|not shareable)|no display for/i.test(
            message
        )
    ) {
        return "display-missing";
    }

    if (/permission|not authori[sz]ed|declined|TCC|refused to enumerate/i.test(message)) {
        return "no-permission";
    }

    return "failed";
}

/** The argv after the binary for one capture, with only the flags the binary has. */
export function nativeArgv(options: {
    request: CaptureRequest;
    flags: Set<NativeOptionalFlag>;
    displays: DisplayInfo[];
}): string[] {
    const { request, flags, displays } = options;
    const argv = [
        "capture",
        "--mode",
        "screen",
        "--duration",
        String(Math.min(MAX_CAPTURE_SECONDS, request.durationSec)),
        "--out",
        request.outDir,
        "--active-fps",
        String(Math.max(0.5, request.activeFps)),
        "--idle-fps",
        String(Math.max(0.1, Math.min(request.idleFps, request.activeFps, 5))),
        "--threshold",
        String(request.thresholdPercent),
        "--no-indicator",
    ];
    let display: DisplayInfo | undefined;

    if (request.target.kind === "follow-focus") {
        if (!flags.has("--follow-focus")) {
            throw new CaptureError("unavailable", "this ax-tool has no --follow-focus; rebuild it");
        }

        argv.push("--follow-focus");
    } else {
        const { displayId } = request.target;
        display = displays.find((one) => one.id === displayId);

        if (flags.has("--display-id")) {
            argv.push("--display-id", String(displayId));
        } else if (display) {
            argv.push("--screen-index", String(display.index));
        } else {
            throw new CaptureError("display-missing", `display ${displayId} is not connected`);
        }
    }

    if (request.maxLongSidePx !== undefined) {
        if (flags.has("--max-long-side")) {
            argv.push("--max-long-side", String(request.maxLongSidePx));
        } else {
            const sized = display ?? mainDisplay(displays);

            if (sized) {
                argv.push("--output-scale", String(Number(outputScaleFor(sized, request.maxLongSidePx).toFixed(4))));
            }
        }
    }

    const optional: Array<[NativeOptionalFlag, number | undefined]> = [
        ["--quiet-ms", request.quietMs],
        ["--heartbeat-sec", request.heartbeatSec],
        ["--max-mb", request.maxMb],
    ];

    for (const [flag, value] of optional) {
        if (value !== undefined && flags.has(flag)) {
            argv.push(flag, String(value));
        }
    }

    if (request.maxFrames !== undefined) {
        argv.push("--max-frames", String(request.maxFrames));
    }

    return argv;
}

const audioDevice = z.object({
    id: z.string(),
    name: z.string().default(""),
    channels: z.number().default(0),
    default: z.boolean().default(false),
});

/** `ax-tool audio-devices`: `{ok, inputs: [...], outputs: [...]}`, each with its UID as `id`. */
export function parseAudioDevices(data: unknown): AudioDevices {
    const parsed = z.object({ inputs: z.array(audioDevice), outputs: z.array(audioDevice) }).parse(data);
    return { inputs: parsed.inputs, outputs: parsed.outputs };
}

/** `--audio mic,system --mic-device <uid> --audio-sidecar`: the meetings recorder writes no movie, so sidecars. */
export function audioArgv(request: CaptureRequest, flags: ReadonlySet<NativeOptionalFlag>): string[] {
    const audio = request.audio;

    if (!audio || audio.sources.length === 0) {
        return [];
    }

    if (!flags.has("--audio") || !flags.has("--audio-sidecar")) {
        throw new CaptureError("unavailable", "this ax-tool records no sound; rebuild it");
    }

    return [
        "--audio",
        audio.sources.join(","),
        ...(audio.micDeviceId && flags.has("--mic-device") ? ["--mic-device", audio.micDeviceId] : []),
        "--audio-sidecar",
    ];
}

/** Frames left on disk by a recorder that exited without a result; their times come from the files. */
function salvagedFrames(outDir: string, displayId: number | undefined): CaptureResult | undefined {
    if (!existsSync(outDir)) {
        return undefined;
    }

    const kept = readdirSync(outDir)
        .filter((name) => /^keep-\d+\.png$/.test(name))
        .sort()
        .map((name) => ({ path: join(outDir, name), mtimeMs: statSync(join(outDir, name)).mtimeMs }));
    const first = kept[0];

    if (!first) {
        return undefined;
    }

    return {
        startedAtMs: first.mtimeMs,
        endedEarly: "stream-error",
        frames: kept.map((file) => ({
            path: file.path,
            atMs: Math.round(file.mtimeMs - first.mtimeMs),
            changePercent: 0,
            reason: "salvaged",
            ...(displayId !== undefined ? { displayId } : {}),
        })),
    };
}

const SWITCH_TIMEOUT_MS = 5_000;

const controlEvent = z.discriminatedUnion("event", [
    z.object({
        event: z.literal("frame"),
        path: z.string(),
        timestampMs: z.number(),
        reason: z.string().default("change"),
        displayId: z.number().optional(),
    }),
    z.object({ event: z.literal("display-switch"), from: z.number().optional(), to: z.number() }),
    z.object({ event: z.literal("error"), code: z.string().optional(), message: z.string() }),
    z.object({ event: z.literal("state") }).loose(),
    z.object({ event: z.literal("settings") }).loose(),
]);

const SETTINGS_TIMEOUT_MS = 5_000;

/**
 * The `--control-stdin` side of one running capture: commands as JSON lines to its stdin, its stderr events back. A
 * switch resolves on the recorder's `display-switch` event and rejects on its `error` event.
 */
export class NativeLiveCapture implements LiveCapture {
    readonly setRates?: (active: number, idle: number) => Promise<void>;
    readonly setThreshold?: (percent: number) => Promise<void>;
    readonly setMaxLongSide?: (px: number) => Promise<void>;
    readonly mute?: (source: AudioSource, muted: boolean) => Promise<void>;
    readonly setMic?: (deviceId: string) => Promise<void>;
    /**
     * Commands waiting for their answer, oldest first: `settings` for a rate, threshold, size or microphone change, a
     * `state` event with `muted` for a mute.
     */
    private readonly pendingSettings: Array<{
        answer: "settings" | "muted";
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }> = [];
    private pendingSwitch?: {
        to: number;
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    };

    constructor(
        private readonly write: (text: string) => void,
        private displayId: number | undefined,
        private readonly hooks: CaptureHooks,
        commands: ReadonlySet<NativeOptionalFlag> = new Set()
    ) {
        if (commands.has("set-fps")) {
            this.setRates = (active, idle) => this.settingsCommand({ cmd: "set-fps", active, idle });
        }

        if (commands.has("set-threshold")) {
            this.setThreshold = (percent) => this.settingsCommand({ cmd: "set-threshold", percent });
        }

        if (commands.has("set-max-long-side")) {
            this.setMaxLongSide = (px) => this.settingsCommand({ cmd: "set-max-long-side", px });
        }

        if (commands.has("mute")) {
            this.mute = (source, muted) => this.settingsCommand({ cmd: muted ? "mute" : "unmute", source }, "muted");
        }

        if (commands.has("set-mic")) {
            this.setMic = (deviceId) => this.settingsCommand({ cmd: "set-mic", deviceId });
        }
    }

    /** One command whose answer is the recorder's next `settings` event, or its next `error` event. */
    private settingsCommand(
        command: Record<string, unknown>,
        answer: "settings" | "muted" = "settings"
    ): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const entry = {
                answer,
                resolve,
                reject,
                timer: setTimeout(() => {
                    const index = this.pendingSettings.indexOf(entry);

                    if (index >= 0) {
                        this.pendingSettings.splice(index, 1);
                    }

                    reject(new CaptureError("timeout", `the recorder did not answer ${String(command.cmd)}`));
                }, SETTINGS_TIMEOUT_MS),
            };
            this.pendingSettings.push(entry);
            this.send(command);
        });
    }

    switchDisplay(displayId: number): Promise<void> {
        if (displayId === this.displayId) {
            return Promise.resolve();
        }

        if (this.pendingSwitch) {
            clearTimeout(this.pendingSwitch.timer);
            this.pendingSwitch.reject(new CaptureError("failed", "another switch replaced this one"));
        }
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pendingSwitch?.timer === timer) {
                    this.pendingSwitch = undefined;
                }

                reject(new CaptureError("timeout", `the recorder did not switch to display ${displayId}`));
            }, SWITCH_TIMEOUT_MS);
            this.pendingSwitch = { to: displayId, resolve, reject, timer };
            this.send({ cmd: "switch", displayId });
        });
    }

    pause(): void {
        this.send({ cmd: "pause" });
    }

    resume(): void {
        this.send({ cmd: "resume" });
    }

    /** One stderr line of the recorder: an event, or its own log, which is ignored. */
    receive(line: string): void {
        if (!line.trimStart().startsWith("{")) {
            return;
        }

        let raw: unknown;

        try {
            raw = SafeJSON.parse(line, { strict: true });
        } catch (error) {
            log.debug({ error }, "recorder stderr line is not an event");
            return;
        }

        const parsed = controlEvent.safeParse(raw);

        if (!parsed.success) {
            return;
        }

        const event = parsed.data;

        if (event.event === "frame") {
            this.hooks.onFrame?.({
                path: event.path,
                atMs: event.timestampMs,
                changePercent: 0,
                reason: event.reason,
                ...((event.displayId ?? this.displayId) !== undefined
                    ? { displayId: event.displayId ?? this.displayId }
                    : {}),
            });
            return;
        }

        if (event.event === "display-switch") {
            this.displayId = event.to;
            this.settle(event.to);
            return;
        }

        if (event.event === "settings" || (event.event === "state" && "muted" in event)) {
            const kind = event.event === "settings" ? "settings" : "muted";
            const index = this.pendingSettings.findIndex((entry) => entry.answer === kind);
            const [pending] = index >= 0 ? this.pendingSettings.splice(index, 1) : [];
            clearTimeout(pending?.timer);
            pending?.resolve();
            return;
        }

        if (event.event !== "error") {
            return;
        }

        const failure = new CaptureError(captureErrorKind(event.code, event.message), event.message);

        if (this.pendingSwitch) {
            const pending = this.pendingSwitch;
            this.pendingSwitch = undefined;
            clearTimeout(pending.timer);
            pending.reject(failure);
            return;
        }

        const pending = this.pendingSettings.shift();
        clearTimeout(pending?.timer);
        pending?.reject(failure);
    }

    private settle(to: number): void {
        const pending = this.pendingSwitch;

        if (pending && pending.to === to) {
            this.pendingSwitch = undefined;
            clearTimeout(pending.timer);
            pending.resolve();
        }
    }

    private send(command: Record<string, unknown>): void {
        this.write(`${SafeJSON.stringify(command)}\n`);
    }
}

/** `ax-tool capture --mode screen`, GenesisTools' own ScreenCaptureKit recorder. */
export class NativeFrameRecorder extends FrameRecorder {
    readonly id = "native" as const;
    private flags = new Set<NativeOptionalFlag>();

    constructor(private readonly context: FrameRecorderContext) {
        super();
    }

    get supports(): FrameRecorderSupport {
        return {
            followFocus: this.flags.has("--follow-focus"),
            displayId: true,
            // Motion boxes came with the same ax-tool release as --follow-focus.
            motionBoxes: this.flags.has("--follow-focus"),
            heartbeat: this.flags.has("--heartbeat-sec"),
            liveControl: this.flags.has("--control-stdin"),
            parallelCaptures: true,
            audio: this.flags.has("--audio") && this.flags.has("--audio-sidecar"),
        };
    }

    private async axTool(signal?: AbortSignal): Promise<string[]> {
        const axTool = await this.context.axTool({
            signal,
            onBuild: () => log.info("building ax-tool before the capture"),
        });
        this.flags = await detectFlags(axTool);
        return axTool;
    }

    async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
        try {
            await this.axTool();
            return { ok: true };
        } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
    }

    async displays(): Promise<DisplayInfo[]> {
        const axTool = await this.axTool();
        const result = await boundedCommand({ command: [...axTool, "screens"], timeoutMs: SCREENS_TIMEOUT_MS });

        if (result.status !== 0) {
            throw new CaptureError("unavailable", `ax-tool screens exited ${result.status}: ${result.stderr.trim()}`);
        }

        return parseDisplayList(SafeJSON.parse(result.stdout, { strict: true }));
    }

    override async audioDevices(): Promise<AudioDevices> {
        const axTool = await this.axTool();

        if (!this.flags.has("audio-devices")) {
            throw new CaptureError("unavailable", "this ax-tool has no audio-devices; rebuild it");
        }

        const result = await boundedCommand({ command: [...axTool, "audio-devices"], timeoutMs: SCREENS_TIMEOUT_MS });

        if (result.status !== 0) {
            throw new CaptureError(
                "unavailable",
                `ax-tool audio-devices exited ${result.status}: ${result.stderr.trim()}`
            );
        }

        return parseAudioDevices(SafeJSON.parse(result.stdout, { strict: true }));
    }

    async capture(request: CaptureRequest, signal?: AbortSignal): Promise<CaptureResult> {
        const axTool = await this.axTool(signal);
        const byIndex = request.target.kind === "display" && !this.flags.has("--display-id");
        const byScale = request.maxLongSidePx !== undefined && !this.flags.has("--max-long-side");
        const displays = byIndex || byScale ? await this.displays() : [];
        const controlled = request.hooks !== undefined && this.flags.has("--control-stdin");
        const argv = [
            ...axTool,
            ...nativeArgv({ request, flags: this.flags, displays }),
            ...(controlled ? ["--control-stdin"] : []),
            ...audioArgv(request, this.flags),
        ];
        const targetId = request.target.kind === "display" ? request.target.displayId : undefined;
        const spawnedAt = Date.now();
        let channel: NativeLiveCapture | undefined;
        const run = await runCaptureProcess({
            argv,
            timeoutMs: Math.min(MAX_CAPTURE_SECONDS, request.durationSec) * 1000 + CAPTURE_TIMEOUT_GRACE_MS,
            signal,
            launch: this.context.launch,
            ...(controlled && request.hooks
                ? {
                      onStdin: (write: (text: string) => void) => {
                          channel = new NativeLiveCapture(write, targetId, request.hooks ?? {}, this.flags);
                          request.hooks?.onLive?.(channel);
                      },
                      onStderrLine: (line: string) => channel?.receive(line),
                  }
                : {}),
        });
        log.debug({ exitCode: run.exitCode, argv, timedOut: run.timedOut }, "native capture");

        if (run.timedOut) {
            throw new CaptureError(
                "timeout",
                `ax-tool capture did not end within ${request.durationSec} s + ${CAPTURE_TIMEOUT_GRACE_MS / 1000} s`
            );
        }

        let json: unknown = null;

        try {
            json = SafeJSON.parse(run.stdout.slice(Math.max(0, run.stdout.indexOf("{"))) || "null", { strict: true });
        } catch (error) {
            log.debug({ error }, "native capture result is incomplete; trying frame salvage");
        }
        const parsed = nativeResult.safeParse(json);

        if (run.exitCode === 0 && parsed.success) {
            const { frames, cancelled, endedEarly, stats, tracks } = parsed.data.data;
            const first = frames[0];
            const firstMtime = first ? statSync(first.path, { throwIfNoEntry: false })?.mtimeMs : undefined;
            const kept: CapturedFrame[] = frames.map((frame) => ({
                path: frame.path,
                atMs: frame.timestampMs,
                changePercent: frame.changePercent,
                reason: frame.reason,
                ...(frame.displayId !== undefined || targetId !== undefined
                    ? { displayId: frame.displayId ?? targetId }
                    : {}),
                ...(frame.motionBoxes ? { motionBoxes: frame.motionBoxes } : {}),
            }));
            const ending = endedEarly ?? (cancelled || run.aborted ? "stopped" : undefined);
            return {
                startedAtMs: first && firstMtime !== undefined ? firstMtime - first.timestampMs : spawnedAt,
                frames: kept,
                ...(ending ? { endedEarly: ending } : {}),
                ...(stats ? { stats } : {}),
                ...(tracks
                    ? {
                          tracks: tracks.map((track) => ({
                              source: track.source,
                              ...(track.path ? { path: track.path } : {}),
                              durationMs: track.durationMs,
                              ...(typeof track.peakDbfs === "number" ? { peakDbfs: track.peakDbfs } : {}),
                              mutedSpans: track.mutedSpans,
                          })),
                      }
                    : {}),
            };
        }

        const failure = nativeError.safeParse(json);
        const message = failure.success ? failure.data.error : run.stderr.trim().slice(-300) || "no output";
        const salvaged = salvagedFrames(request.outDir, targetId);

        if (salvaged) {
            log.warn({ message, frames: salvaged.frames.length }, "native capture failed; kept its frames");
            return salvaged;
        }

        throw new CaptureError(
            captureErrorKind(failure.success ? failure.data.code : undefined, message),
            `ax-tool capture exited ${run.exitCode}: ${message}`
        );
    }
}
