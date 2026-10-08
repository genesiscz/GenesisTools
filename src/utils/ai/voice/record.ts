import { statSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { type OpenPcmSourceOptions, openPcmSource, type PcmSource } from "@genesiscz/utils/ai/stt/capture/pcm-source";
import { pcmRms } from "@genesiscz/utils/ai/stt/vad";
import { logger } from "@genesiscz/utils/logger";

export interface RecordedPcmClip {
    path: string;
    bytes: number;
    sampleRateHz: number;
    channels: 1;
    encoding: "s16le";
    durationMs: number;
    peakRms: number;
    endedBy: "eof" | "stop" | "limit";
}
export type RecordingEvent =
    | { kind: "recording"; sampleRateHz: number }
    | { kind: "level"; rms: number; durationMs: number };

/** Local capture only: no provider resolution, credentials, sockets or transcription. */
export async function recordPcmClip({
    output,
    input = "mic",
    micLauncher,
    sampleRateHz = 16000,
    maxDurationMs = 30_000,
    signal,
    stopSignal,
    onEvent = () => {},
    openSource = openPcmSource,
}: {
    output: string;
    input?: string;
    micLauncher?: string;
    sampleRateHz?: number;
    maxDurationMs?: number;
    signal?: AbortSignal;
    stopSignal?: AbortSignal;
    onEvent?: (event: RecordingEvent) => void;
    openSource?: (options: OpenPcmSourceOptions) => Promise<PcmSource>;
}): Promise<RecordedPcmClip> {
    signal?.throwIfAborted();
    if (
        !Number.isInteger(sampleRateHz) ||
        sampleRateHz < 8000 ||
        sampleRateHz > 48000 ||
        !Number.isFinite(maxDurationMs) ||
        maxDurationMs < 100 ||
        maxDurationMs > 30_000
    ) {
        throw new Error("Recording requires 8–48 kHz mono PCM and a duration from 0.1 to 30 seconds");
    }
    if (input === "mic" && !micLauncher) {
        throw new Error(
            "Local recording requires the current app's explicit --mic-launcher; production fallback is disabled"
        );
    }
    if (input !== "mic" && input !== "-") {
        const size = statSync(input).size;
        if (size > sampleRateHz * 2 * 30) {
            throw new Error("PCM input exceeds the 30-second local clip limit");
        }
    }
    const capture = new AbortController();
    let source: PcmSource | undefined;
    let closePromise: Promise<void> | undefined;
    let endedBy: RecordedPcmClip["endedBy"] = "eof";
    const close = () => (closePromise ??= source?.close() ?? Promise.resolve());
    const stop = () => {
        endedBy = "stop";
        capture.abort();
        if (source) {
            void close().catch((error) => logger.debug({ error }, "Recorder stop cleanup failed"));
        }
    };
    const cancel = () => {
        capture.abort();
        if (source) {
            void close().catch((error) => logger.debug({ error }, "Recorder cancellation cleanup failed"));
        }
    };
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    const file = await open(output, "wx", 0o600);
    let saved = false;
    let bytes = 0;
    let peakRms = 0;
    const maxBytes = Math.floor((sampleRateHz * 2 * maxDurationMs) / 1000 / 2) * 2;
    signal?.addEventListener("abort", cancel, { once: true });
    stopSignal?.addEventListener("abort", stop, { once: true });
    const deadline = setTimeout(() => {
        stop();
        endedBy = "limit";
    }, maxDurationMs);
    try {
        signal?.throwIfAborted();
        if (stopSignal?.aborted) {
            throw new Error("Recording stopped before capture started");
        }
        source = await openSource({ input, sampleRateHz, micLauncher, realtime: false, signal: capture.signal });
        onEvent({ kind: "recording", sampleRateHz });
        try {
            for await (const frame of source.frames()) {
                signal?.throwIfAborted();
                if (capture.signal.aborted) {
                    break;
                }
                if (frame.byteLength % 2 !== 0) {
                    throw new Error("PCM input ended with an incomplete 16-bit sample");
                }
                const data = frame.subarray(0, Math.min(frame.byteLength, maxBytes - bytes));
                if (data.byteLength) {
                    await file.writeFile(data);
                    bytes += data.byteLength;
                    const rms = pcmRms(data);
                    peakRms = Math.max(peakRms, rms);
                    onEvent({ kind: "level", rms, durationMs: (bytes / (sampleRateHz * 2)) * 1000 });
                }
                if (bytes >= maxBytes) {
                    endedBy = "limit";
                    break;
                }
            }
        } catch (error) {
            if (!capture.signal.aborted || signal?.aborted) {
                throw error;
            }
        }
        signal?.throwIfAborted();
        await close();
        if (!bytes) {
            throw new Error("The recording contains no audio. Check the microphone and try again.");
        }
        await file.sync();
        signal?.throwIfAborted();
        saved = true;
        return {
            path: output,
            bytes,
            sampleRateHz,
            channels: 1,
            encoding: "s16le",
            durationMs: (bytes / (sampleRateHz * 2)) * 1000,
            peakRms,
            endedBy,
        };
    } finally {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", cancel);
        stopSignal?.removeEventListener("abort", stop);
        try {
            await close();
        } catch (error) {
            logger.warn({ error }, "Recording source cleanup failed");
        }
        await file.close();
        if (!saved) {
            await unlink(output).catch((error) =>
                logger.debug({ error, output }, "Unfinished recording cleanup failed")
            );
        }
    }
}

/** The native owner attaches this process to its audio lease before writing start. EOF stops capture. */
export function recordingControl({
    input,
    signal,
    waitForStart,
}: {
    input: ReadableStream<Uint8Array>;
    signal: AbortSignal;
    waitForStart: boolean;
}) {
    const stopped = new AbortController();
    const reader = input.getReader();
    let started = !waitForStart;
    let start: () => void = () => {};
    let refuse: (error: unknown) => void = () => {};
    const ready = waitForStart
        ? new Promise<void>((resolve, reject) => {
              start = resolve;
              refuse = reject;
          })
        : Promise.resolve();
    const cancel = () => {
        stopped.abort();
        refuse(new Error("Recording cancelled before start"));
        void reader.cancel().catch((error) => logger.debug({ error }, "Recording control cleanup failed"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    const deadline = waitForStart ? setTimeout(cancel, 10_000) : undefined;
    const pump = (async () => {
        const decoder = new TextDecoder();
        let pending = "";
        try {
            while (true) {
                const next = await reader.read();
                if (next.done) {
                    break;
                }
                if (!started) {
                    pending += decoder.decode(next.value, { stream: true });
                    if (pending.length > 512) {
                        throw new Error("Recording start message exceeds 512 characters");
                    }
                    const newline = pending.indexOf("\n");
                    if (newline >= 0) {
                        if (pending.slice(0, newline).trim() !== "start") {
                            throw new Error("Recording needs an explicit start message");
                        }
                        started = true;
                        clearTimeout(deadline);
                        start();
                        pending = "";
                    }
                }
            }
            stopped.abort();
            if (!started) {
                refuse(new Error("Recording owner closed before start"));
            }
        } catch (error) {
            stopped.abort();
            refuse(error);
        }
    })();
    if (signal.aborted) {
        cancel();
    }
    return {
        ready,
        stopSignal: stopped.signal,
        close: async () => {
            clearTimeout(deadline);
            signal.removeEventListener("abort", cancel);
            await reader.cancel().catch((error) => logger.debug({ error }, "Recording control already closed"));
            await pump;
        },
    };
}
