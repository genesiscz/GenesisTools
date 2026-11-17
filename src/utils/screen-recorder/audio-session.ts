import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { withTimeout } from "@genesiscz/utils/async";
import { getAudioInfo } from "@genesiscz/utils/audio/probe";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { wrapWithGenesisApp } from "@genesiscz/utils/macos/genesis-app";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { signalProcessTree } from "@genesiscz/utils/process/processes";
import { z } from "zod";
import { AUDIO_SOURCES, type AudioSource } from "./control";
import { CaptureError, type CaptureRequest, type FrameRecorder } from "./types";

const { log } = logger.scoped("screen-recorder-audio-session");
const nativeFailure = z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() });
const READY_MS = 30_000;
const CONTROL_MS = 5_000;
const STOP_MS = 20_000;

/** P14's audio row. The engine keeps the same ledger for sessions and frame pieces. */
export const audioSegmentSchema = z.object({
    file: z.string().min(1),
    source: z.enum(AUDIO_SOURCES),
    at: z.iso.datetime(),
    durationMs: z.number().finite().nonnegative(),
    mutedSpans: z.array(z.tuple([z.number().nonnegative(), z.number().nonnegative()])),
    lostSpans: z.array(z.tuple([z.number().nonnegative(), z.number().nonnegative()])).optional(),
    zeroAt: z.iso.datetime(),
    kept: z.literal("normal"),
});
export type AudioSegment = z.infer<typeof audioSegmentSchema>;

const segmentStartedSchema = audioSegmentSchema.pick({ file: true, source: true, zeroAt: true }).extend({
    event: z.literal("segment-started"),
    primingFrames: z.number().int().nonnegative().optional(),
});

const packetPrimingSchema = z.object({
    packets: z
        .array(
            z.object({
                side_data_list: z
                    .array(z.object({ skip_samples: z.number().int().nonnegative().optional() }))
                    .optional(),
            })
        )
        .nonempty(),
});

/** A finalized file already tells the decoder to skip priming; an interrupted fragment does not. */
async function decoderPrimingFrames(file: string): Promise<number> {
    const probe = await boundedCommand({
        command: [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-read_intervals",
            "%+#1",
            "-show_packets",
            "-show_entries",
            "packet_side_data=skip_samples",
            "-of",
            "json",
            file,
        ],
        timeoutMs: 2_000,
        maxBufferBytes: 16_384,
    });
    if (probe.status !== 0) {
        throw new Error(`could not read AAC priming: ${probe.stderr.trim()}`);
    }
    const packet = packetPrimingSchema.parse(SafeJSON.parse(probe.stdout, { strict: true })).packets[0];
    return packet.side_data_list?.reduce((frames, side) => Math.max(frames, side.skip_samples ?? 0), 0) ?? 0;
}

/** Recovery reads the sample clock saved beside the open file, even after the supervisor itself was killed. */
export async function salvagedAudioTiming(file: string): Promise<{
    at: string;
    zeroAt?: string;
    durationMs: number;
    clockGuess?: "file-times";
    durationGuess?: "file-times";
    primingFrames?: number;
    primingGuess?: "unavailable";
}> {
    const stat = statSync(file);
    const startMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    let zeroAt: string | undefined;
    let encoderPriming: number | undefined;
    try {
        const started = segmentStartedSchema.parse(
            SafeJSON.parse(readFileSync(`${file}.json`, "utf8"), { strict: true })
        );
        if (started.file !== basename(file) || !started.file.endsWith(`-${started.source}.m4a`)) {
            throw new Error("the saved sample clock belongs to another segment");
        }
        zeroAt = started.zeroAt;
        encoderPriming = started.primingFrames;
    } catch (error) {
        log.debug({ file, error }, "no saved sample clock; recovery uses the file's times");
    }
    const info = await getAudioInfo(file, { timeoutMs: 2_000 });
    const decoded = Number.isFinite(info.duration) && info.duration > 0;
    const at = zeroAt ?? new Date(startMs).toISOString();
    let primingFrames: number | undefined;
    let primingGuess: "unavailable" | undefined;
    if (zeroAt && info.format === "aac") {
        if (encoderPriming !== undefined && info.sampleRate && info.sampleRate > 0) {
            try {
                primingFrames = Math.max(0, encoderPriming - (await decoderPrimingFrames(file)));
                zeroAt = new Date(Date.parse(zeroAt) - (primingFrames * 1000) / info.sampleRate).toISOString();
            } catch (error) {
                log.warn({ file, error }, "could not correct the salvaged AAC clock for encoder priming");
                primingGuess = "unavailable";
            }
        } else {
            primingGuess = "unavailable";
        }
    }
    return {
        at,
        ...(zeroAt ? { zeroAt } : { clockGuess: "file-times" }),
        durationMs: Math.max(0, Math.round(decoded ? info.duration * 1000 : stat.mtimeMs - startMs)),
        ...(!decoded ? { durationGuess: "file-times" } : {}),
        ...(primingFrames !== undefined ? { primingFrames } : {}),
        ...(primingGuess ? { primingGuess } : {}),
    };
}

const eventSchema = z.discriminatedUnion("event", [
    z.object({
        event: z.literal("state"),
        state: z.string(),
        sources: z.array(z.enum(AUDIO_SOURCES)).optional(),
        muted: z.record(z.string(), z.boolean()).optional(),
    }),
    z.object({ event: z.literal("settings"), micDevice: z.string() }),
    z.object({ event: z.literal("warning"), message: z.string() }),
    z.object({ event: z.literal("error"), message: z.string(), code: z.string().optional() }),
]);
type AudioEvent = z.infer<typeof eventSchema>;

export interface RecorderAudioOptions {
    folder: string;
    /** Under the piece folder, so P14's salvage sees any file a killed process left open. */
    outDir: string;
    request: NonNullable<CaptureRequest["audio"]>;
    signal?: AbortSignal;
    onSegment?: (segment: AudioSegment) => void;
    onWarning?: (warning: string) => void;
    onFailure?: (error: Error) => void;
}

/** The native adapter owns the capability; the frame loop never branches on a backend name. */
export function recordsAudioSession(recorder: FrameRecorder): recorder is FrameRecorder & {
    startAudioSession(options: RecorderAudioOptions): Promise<AudioSession | undefined>;
} {
    return "startAudioSession" in recorder && typeof recorder.startAudioSession === "function";
}

/** The only TypeScript owner of audio-record's pipes, commands and closed-file handover. */
export class AudioSession {
    readonly warnings: string[] = [];
    sources: AudioSource[] = [];
    private readonly proc;
    private readonly ready = Promise.withResolvers<void>();
    private readonly done: Promise<void>;
    private pending?: { accepts: (event: AudioEvent) => boolean; resolve: () => void; reject: (error: Error) => void };
    private commands = Promise.resolve();
    private stopping?: Promise<{ segments: number; warnings: string[] }>;
    private failure?: Error;
    private segments = 0;
    private readonly prefix = randomUUID();
    private readonly abort = () => {
        void this.stop().catch((error: unknown) => log.warn({ error }, "audio stop failed"));
    };

    private constructor(
        private readonly options: RecorderAudioOptions & {
            argv: string[];
            launch?: (argv: string[]) => string[];
            segmentSec?: number;
        }
    ) {
        mkdirSync(options.outDir, { recursive: true });
        mkdirSync(join(options.folder, "audio"), { recursive: true });
        const argv = [
            ...options.argv,
            "audio-record",
            "--sources",
            options.request.sources.join(","),
            ...(options.request.micDeviceId ? ["--mic-device", options.request.micDeviceId] : []),
            "--out",
            options.outDir,
            "--segment-sec",
            String(options.segmentSec ?? 60),
        ];
        log.debug({ argv }, "starting continuous sound");
        this.proc = Bun.spawn((options.launch ?? wrapWithGenesisApp)(argv), {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        const output = this.lines(this.proc.stdout, (line) => this.segment(line));
        const events = this.lines(this.proc.stderr, (line) => this.event(line));
        this.done = this.proc.exited.then(async (code) => {
            if (code !== 0 || !this.stopping) {
                this.fail(new Error(`audio-record exited ${code}${this.stopping ? "" : " before stop"}`));
            }
            await withTimeout(Promise.all([output, events]), 2_000, new Error("audio pipes did not close")).catch(
                (error: unknown) => this.fail(error)
            );
            this.ready.reject(this.failure ?? new Error("audio-record ended before readiness"));
            this.pending?.reject(this.failure ?? new Error("audio-record stopped"));
        });
        void this.ready.promise.catch(() => undefined);
        options.signal?.addEventListener("abort", this.abort, { once: true });
    }

    static async start(
        options: RecorderAudioOptions & { argv: string[]; launch?: (argv: string[]) => string[]; segmentSec?: number }
    ): Promise<AudioSession> {
        options.signal?.throwIfAborted();
        const session = new AudioSession(options);
        try {
            await withTimeout(
                session.ready.promise,
                READY_MS,
                new CaptureError("timeout", "audio-record did not become ready")
            );
            options.signal?.throwIfAborted();
            return session;
        } catch (error) {
            if (!options.signal?.aborted) {
                session.fail(error);
            }
            await session
                .stop()
                .catch((stopError: unknown) => log.debug({ stopError }, "failed audio startup cleaned up"));
            options.signal?.throwIfAborted();
            throw error;
        }
    }

    private async lines(stream: ReadableStream<Uint8Array>, receive: (line: string) => void): Promise<void> {
        const decoder = new TextDecoder();
        let pending = "";
        try {
            for await (const chunk of stream) {
                pending += decoder.decode(chunk, { stream: true });
                if (pending.length > 1_048_576) {
                    throw new Error("audio-record sent an oversized line");
                }
                const lines = pending.split("\n");
                pending = lines.pop() ?? "";
                for (const line of lines) {
                    if (line.trim()) {
                        receive(line);
                    }
                }
            }
            if (pending.trim()) {
                receive(pending);
            }
        } catch (error) {
            this.fail(error);
        }
    }

    private segment(line: string): void {
        const raw: unknown = SafeJSON.parse(line, { strict: true });
        const failure = nativeFailure.safeParse(raw);
        if (failure.success) {
            throw new CaptureError(
                failure.data.code === "no-permission" ? "no-permission" : "failed",
                failure.data.error
            );
        }

        const started = segmentStartedSchema.safeParse(raw);
        const row = started.success ? started.data : audioSegmentSchema.parse(raw);
        if (
            basename(row.file) !== row.file ||
            !/^audio-\d+-(mic|system)\.m4a$/.test(row.file) ||
            !this.options.request.sources.includes(row.source)
        ) {
            throw new Error("audio-record sent an invalid segment file");
        }
        if (started.success) {
            writeFileSync(join(this.options.outDir, `${row.file}.json`), SafeJSON.stringify(started.data));
            return;
        }
        const closed = audioSegmentSchema.parse(raw);
        const file = `audio/${this.prefix}-${row.file}`;
        renameSync(join(this.options.outDir, row.file), join(this.options.folder, file));
        const kept = { ...closed, file };
        try {
            appendFileSync(join(this.options.folder, "audio.jsonl"), `${SafeJSON.stringify(kept)}\n`);
        } catch (error) {
            // Put it back where crash recovery looks, before the piece folder is cleared.
            renameSync(join(this.options.folder, file), join(this.options.outDir, row.file));
            throw error;
        }
        this.segments += 1;
        this.options.onSegment?.(kept);
    }

    private event(line: string): void {
        let event: AudioEvent;
        try {
            const parsed = eventSchema.safeParse(SafeJSON.parse(line, { strict: true }));
            if (!parsed.success) {
                log.debug({ line }, "ignoring non-event audio stderr");
                return;
            }
            event = parsed.data;
        } catch (error) {
            log.debug({ error, line }, "ignoring non-JSON audio stderr");
            return;
        }
        if (event.event === "warning") {
            this.warnings.push(event.message);
            this.options.onWarning?.(event.message);
        } else if (event.event === "error") {
            const error = new CaptureError(event.code === "no-permission" ? "no-permission" : "failed", event.message);
            if (this.pending) {
                this.pending.reject(error);
            } else {
                this.fail(error);
            }
        } else {
            if (event.event === "state" && event.sources) {
                this.sources = event.sources;
                this.ready.resolve();
            }
            if (this.pending?.accepts(event)) {
                this.pending.resolve();
            }
        }
    }

    private fail(error: unknown): void {
        if (this.failure) {
            return;
        }
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.ready.reject(this.failure);
        this.pending?.reject(this.failure);
        this.options.onFailure?.(this.failure);
    }

    get failureReason(): Error | undefined {
        return this.failure;
    }

    private command(command: Record<string, unknown>, accepts: (event: AudioEvent) => boolean): Promise<void> {
        const result = this.commands.then(async () => {
            if (this.failure) {
                throw this.failure;
            }
            if (this.stopping || this.proc.exitCode !== null) {
                throw new Error("the sound session is stopping");
            }
            const answer = Promise.withResolvers<void>();
            this.pending = { accepts, resolve: () => answer.resolve(), reject: answer.reject };
            try {
                await withTimeout(
                    this.write(command),
                    CONTROL_MS,
                    new CaptureError("timeout", "audio control pipe blocked")
                );
                await withTimeout(
                    answer.promise,
                    CONTROL_MS,
                    new CaptureError("timeout", `audio-record did not acknowledge ${command.cmd}`)
                );
            } catch (error) {
                if (error instanceof CaptureError && error.kind === "timeout") {
                    this.fail(error);
                }
                throw error;
            } finally {
                this.pending = undefined;
            }
        });
        this.commands = result.catch((error: unknown) => log.debug({ error }, "audio command refused"));
        return result;
    }

    private async write(command: Record<string, unknown>): Promise<void> {
        this.proc.stdin.write(`${SafeJSON.stringify(command)}\n`);
        await this.proc.stdin.flush();
    }

    mute(source: AudioSource, muted: boolean): Promise<void> {
        return this.command(
            { cmd: muted ? "mute" : "unmute", source },
            (event) => event.event === "state" && event.muted?.[source] === muted
        );
    }

    setMic(deviceId: string): Promise<void> {
        return this.command(
            { cmd: "set-mic", deviceId },
            (event) => event.event === "settings" && event.micDevice === deviceId
        );
    }

    pause(): Promise<void> {
        return this.command({ cmd: "pause" }, (event) => event.event === "state" && event.state === "paused");
    }

    resume(): Promise<void> {
        return this.command({ cmd: "resume" }, (event) => event.event === "state" && event.state === "recording");
    }

    stop(): Promise<{ segments: number; warnings: string[] }> {
        this.stopping ??= Promise.resolve().then(async () => {
            this.options.signal?.removeEventListener("abort", this.abort);
            try {
                const stopped = async () => {
                    if (this.proc.exitCode === null) {
                        await this.write({ cmd: "stop" }).catch((error: unknown) =>
                            log.debug({ error }, "audio stdin already closed before stop")
                        );
                    }
                    await this.done;
                };
                await withTimeout(stopped(), STOP_MS, new Error("audio-record did not stop within 20s"));
            } catch (error) {
                this.fail(error);
                signalProcessTree(this.proc.pid, { signal: "SIGKILL", includeSelf: true });
                await withTimeout(this.done, 2_000, new Error("audio-record did not exit after SIGKILL")).catch(
                    (killError: unknown) => log.warn({ killError }, "audio process cleanup timed out")
                );
            } finally {
                await withTimeout(
                    Promise.resolve(this.proc.stdin.end()),
                    2_000,
                    new Error("audio stdin did not close")
                ).catch((error: unknown) => log.debug({ error }, "audio stdin closed"));
            }
            if (this.failure) {
                throw this.failure;
            }
            return { segments: this.segments, warnings: [...this.warnings] };
        });
        return this.stopping;
    }
}
