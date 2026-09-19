import { existsSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { installedGenesisAppLauncher } from "@genesiscz/utils/macos/genesis-app";
import { profiler } from "@genesiscz/utils/profile";
import { STT_DEFAULT_SAMPLE_RATE_HZ } from "../types";

const prof = profiler.scope("stt");
const log = logger.child({ component: "ai-stt-capture" });

export const PCM_SOURCE_KINDS = ["file", "stdin", "mic", "ffmpeg"] as const;
export type PcmSourceKind = (typeof PCM_SOURCE_KINDS)[number];

/** 100 ms of s16le mono at the sample rate: the frame size every provider accepts comfortably. */
export function frameBytes(sampleRateHz: number, frameMs = 100): number {
    return Math.floor((sampleRateHz * frameMs) / 1000) * 2;
}

export interface PcmSource {
    kind: PcmSourceKind;
    /** Human description for logs and the CLI: path, device name, or "stdin". */
    label: string;
    sampleRateHz: number;
    frames(): AsyncIterable<Uint8Array>;
    close(): Promise<void>;
}

export interface OpenPcmSourceOptions {
    /** `-` = stdin, an existing path = raw s16le file, `mic` = GenesisTools.app microphone face, `ffmpeg[:<device>]` = avfoundation. */
    input: string;
    sampleRateHz?: number;
    /** Real-time pacing for file input, so a provider sees the stream as it would from a mic. */
    realtime?: boolean;
    signal?: AbortSignal;
}

export async function openPcmSource(options: OpenPcmSourceOptions): Promise<PcmSource> {
    const sampleRateHz = options.sampleRateHz ?? STT_DEFAULT_SAMPLE_RATE_HZ;
    const input = options.input.trim();
    if (input === "-") {
        return streamSource({
            kind: "stdin",
            label: "stdin",
            sampleRateHz,
            stream: Bun.stdin.stream(),
            signal: options.signal,
        });
    }

    if (input === "mic") {
        return micSource({ sampleRateHz, signal: options.signal });
    }

    if (input === "ffmpeg" || input.startsWith("ffmpeg:")) {
        return ffmpegSource({
            device: input.slice("ffmpeg:".length) || "default",
            sampleRateHz,
            signal: options.signal,
        });
    }

    if (!existsSync(input)) {
        throw new Error(
            `PCM input '${input}' is not a file. Use '-' for stdin, 'mic' for the GenesisTools.app microphone, or 'ffmpeg[:device]'.`
        );
    }

    return fileSource({ path: input, sampleRateHz, realtime: options.realtime ?? true, signal: options.signal });
}

async function fileSource(options: {
    path: string;
    sampleRateHz: number;
    realtime: boolean;
    signal?: AbortSignal;
}): Promise<PcmSource> {
    const file = Bun.file(options.path);
    const size = file.size;
    const frame = frameBytes(options.sampleRateHz);
    log.info(
        { path: options.path, bytes: size, sampleRateHz: options.sampleRateHz, realtime: options.realtime },
        "PCM file source opened"
    );
    let closed = false;
    return {
        kind: "file",
        label: options.path,
        sampleRateHz: options.sampleRateHz,
        async *frames() {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const started = Date.now();
            let offset = 0;
            let frameIndex = 0;
            while (offset < bytes.byteLength && !closed) {
                options.signal?.throwIfAborted();
                yield bytes.subarray(offset, Math.min(offset + frame, bytes.byteLength));
                offset += frame;
                frameIndex++;
                if (options.realtime) {
                    const due = started + frameIndex * 100;
                    const wait = due - Date.now();
                    if (wait > 0) {
                        await Bun.sleep(Math.min(wait, 100));
                    }
                }
            }
        },
        async close() {
            closed = true;
        },
    };
}

function streamSource(options: {
    kind: PcmSourceKind;
    label: string;
    sampleRateHz: number;
    stream: ReadableStream<Uint8Array>;
    signal?: AbortSignal;
    onClose?: () => Promise<void>;
}): PcmSource {
    const frame = frameBytes(options.sampleRateHz);
    let closed = false;
    const reader = options.stream.getReader();
    return {
        kind: options.kind,
        label: options.label,
        sampleRateHz: options.sampleRateHz,
        async *frames() {
            let carry = new Uint8Array(0);
            let total = 0;
            while (!closed) {
                options.signal?.throwIfAborted();
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }

                total += value.byteLength;
                const merged = new Uint8Array(carry.byteLength + value.byteLength);
                merged.set(carry, 0);
                merged.set(value, carry.byteLength);
                let offset = 0;
                while (merged.byteLength - offset >= frame) {
                    yield merged.subarray(offset, offset + frame);
                    offset += frame;
                }

                carry = merged.subarray(offset);
            }

            if (carry.byteLength > 0) {
                yield carry;
            }

            log.info({ source: options.label, bytes: total }, "PCM stream source ended");
        },
        async close() {
            closed = true;
            await reader.cancel().catch((error: unknown) => {
                log.debug({ error }, "PCM reader cancel failed");
            });
            await options.onClose?.();
        },
    };
}

function spawnSource(options: {
    kind: PcmSourceKind;
    label: string;
    argv: string[];
    sampleRateHz: number;
    signal?: AbortSignal;
}): PcmSource {
    log.info({ argv: options.argv, sampleRateHz: options.sampleRateHz }, "spawning PCM capture process");
    const stopSpawn = prof.start("capture-spawn");
    // The mic face stops when its stdin closes (parent gone), so it gets a pipe we hold open until
    // close(); ffmpeg reads stdin for interactive keys and must not see a pipe.
    const child = Bun.spawn(options.argv, {
        stdin: options.kind === "mic" ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    stopSpawn();
    void child.exited.then(async (code) => {
        const stderr = child.stderr ? await new Response(child.stderr).text() : "";
        log.info({ pid: child.pid, code, stderr: stderr.trim().slice(0, 500) }, "PCM capture process exited");
    });
    const source = streamSource({
        kind: options.kind,
        label: options.label,
        sampleRateHz: options.sampleRateHz,
        stream: child.stdout,
        signal: options.signal,
        onClose: async () => {
            if (child.stdin && typeof child.stdin !== "number") {
                child.stdin.end();
            }

            if (child.exitCode === null) {
                child.kill("SIGTERM");
                await Promise.race([child.exited, Bun.sleep(1_000)]);
                if (child.exitCode === null) {
                    child.kill("SIGKILL");
                }
            }
        },
    });
    options.signal?.addEventListener("abort", () => {
        void source.close();
    });
    return source;
}

/**
 * The GenesisTools.app `--mic` face: the signed bundle owns the microphone TCC grant, so the
 * prompt names GenesisTools, not the terminal. Streams s16le mono PCM at `--rate` on stdout.
 */
function micSource(options: { sampleRateHz: number; signal?: AbortSignal }): PcmSource {
    const launcher = installedGenesisAppLauncher();
    if (!launcher) {
        throw new Error(
            "GenesisTools.app is not installed, so there is no microphone face. Build it with: bun run app " +
                "(or capture with 'ffmpeg:<device>' / '--pcm-in -')."
        );
    }

    return spawnSource({
        kind: "mic",
        label: "GenesisTools.app microphone",
        // Two launcher stages: `GenesisTools <program>` disclaims responsibility, so the `--mic`
        // face runs as the bundle and the microphone prompt names GenesisTools. A bare `--mic`
        // spawned from a terminal inherits the terminal's grant and is denied without a prompt.
        argv: [launcher, launcher, "--mic", "--rate", String(options.sampleRateHz)],
        sampleRateHz: options.sampleRateHz,
        signal: options.signal,
    });
}

function ffmpegSource(options: { device: string; sampleRateHz: number; signal?: AbortSignal }): PcmSource {
    const ffmpeg = Bun.which("ffmpeg");
    if (!ffmpeg) {
        throw new Error("ffmpeg is not on PATH. Install it with: brew install ffmpeg, or use --pcm-in mic.");
    }

    const device = options.device === "default" ? ":default" : `:${options.device}`;
    return spawnSource({
        kind: "ffmpeg",
        label: `ffmpeg avfoundation ${device}`,
        argv: [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "avfoundation",
            "-i",
            device,
            "-ac",
            "1",
            "-ar",
            String(options.sampleRateHz),
            "-f",
            "s16le",
            "-",
        ],
        sampleRateHz: options.sampleRateHz,
        signal: options.signal,
    });
}
