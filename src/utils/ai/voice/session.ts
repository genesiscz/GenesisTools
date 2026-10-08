import { openPcmSource, type PcmSource } from "@genesiscz/utils/ai/stt/capture/pcm-source";
import { openLiveStt } from "@genesiscz/utils/ai/stt/resolve";
import type { LiveSttSession, LiveTranscriptEvent, OpenLiveSttOptions } from "@genesiscz/utils/ai/stt/types";
import { pcmRms } from "@genesiscz/utils/ai/stt/vad";
import { logger } from "@genesiscz/utils/logger";

export type VoiceEvent =
    | LiveTranscriptEvent
    | { kind: "state"; state: "listening" | "stopping" | "stopped"; provider: string; accountId?: string }
    | { kind: "level"; rms: number };

export interface VoiceSession {
    provider: string;
    accountId?: string;
    stop(): void;
    done: Promise<string>;
}

async function closeVoiceResources({
    source,
    session,
}: {
    source?: PcmSource;
    session?: LiveSttSession;
}): Promise<void> {
    const closed = await Promise.allSettled([
        Promise.resolve().then(() => source?.close()),
        Promise.resolve().then(() => session?.close()),
    ]);
    for (const result of closed) {
        if (result.status === "rejected") {
            logger.debug({ error: result.reason }, "Voice resource cleanup failed");
        }
    }
}

export async function createVoiceSession(
    options: OpenLiveSttOptions & {
        input: string;
        realtime?: boolean;
        maxDurationMs?: number;
        onEvent: (event: VoiceEvent) => void;
    }
): Promise<VoiceSession> {
    options.signal?.throwIfAborted();
    const maxDurationMs = options.maxDurationMs ?? 300_000;
    if (!Number.isFinite(maxDurationMs) || maxDurationMs < 100 || maxDurationMs > 3_600_000) {
        throw new Error("Voice duration must be between 0.1 seconds and one hour");
    }

    const capture = new AbortController();
    const transport = new AbortController();
    const abortSetup = () => {
        capture.abort(options.signal?.reason);
        transport.abort(options.signal?.reason);
    };
    options.signal?.addEventListener("abort", abortSetup, { once: true });
    let opened: LiveSttSession | undefined;
    let source: PcmSource | undefined;
    try {
        options.signal?.throwIfAborted();
        opened = await openLiveStt({ ...options, signal: transport.signal });
        options.signal?.throwIfAborted();
        if (options.input !== "none") {
            source = await openPcmSource({
                input: options.input,
                sampleRateHz: options.sampleRateHz ?? 16000,
                realtime: options.realtime,
                signal: capture.signal,
            });
        } else if (opened.provider !== "fixture") {
            throw new Error("Input none is reserved for fixture replay");
        }
        options.signal?.throwIfAborted();
    } catch (error) {
        capture.abort();
        transport.abort();
        await closeVoiceResources({ source, session: opened });
        throw error;
    } finally {
        options.signal?.removeEventListener("abort", abortSetup);
    }
    const session = opened;

    let stopping = false;
    let draining: ReturnType<typeof setTimeout> | undefined;
    const state = (value: "listening" | "stopping" | "stopped") =>
        options.onEvent({
            kind: "state",
            state: value,
            provider: session.provider,
            accountId: session.accountId,
        });
    const stop = () => {
        if (stopping) {
            return;
        }

        stopping = true;
        capture.abort();
        session.end();
        state("stopping");
        draining = setTimeout(() => transport.abort(), 3000);
    };
    const deadline = setTimeout(stop, maxDurationMs);
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) {
        stop();
    }

    state("listening");
    const finals: string[] = [];
    const pump = async () => {
        try {
            if (source) {
                for await (const frame of source.frames()) {
                    capture.signal.throwIfAborted();
                    session.write(frame);
                    options.onEvent({ kind: "level", rms: pcmRms(frame) });
                }
            }
        } catch (error) {
            if (!capture.signal.aborted) {
                throw error;
            }

            logger.debug({ error }, "Voice capture stopped");
        } finally {
            stop();
        }
    };
    const receive = async () => {
        try {
            for await (const event of session.events()) {
                options.onEvent(event);
                if (event.kind === "error") {
                    throw new Error(event.error ?? "Speech provider failed");
                }

                if (event.kind === "final" && event.text.trim()) {
                    finals.push(event.text.trim());
                }
            }
        } catch (error) {
            if (!transport.signal.aborted) {
                throw error;
            }

            logger.debug({ error }, "Voice finalization deadline reached");
        } finally {
            stop();
        }
    };
    const done = (async () => {
        try {
            await Promise.all([pump(), receive()]);
            return finals.join(" ");
        } finally {
            capture.abort();
            transport.abort();
            clearTimeout(deadline);
            clearTimeout(draining);
            options.signal?.removeEventListener("abort", stop);
            await closeVoiceResources({ source, session });
            state("stopped");
        }
    })();
    logger.info({ provider: session.provider, input: options.input }, "Reusable voice session opened");
    return { provider: session.provider, accountId: session.accountId, stop, done };
}
