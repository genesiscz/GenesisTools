import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { openSocketSession, type SocketSpec } from "../socket-session";
import type { LiveSttSession, LiveTranscriptEvent, ProviderSessionOptions } from "../types";

const ELEVENLABS_REALTIME_HOST = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const DEFAULT_MODEL = "scribe_v2_realtime";

/** `AudioFormatEnum` from the realtime AsyncAPI spec, minus the ulaw variant we never send. */
export const ELEVENLABS_PCM_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000] as const;

/**
 * Every `message_type` the spec lists as a failure. They do NOT share a suffix —
 * `quota_exceeded`, `rate_limited` and `unaccepted_terms` all end a session just
 * as hard as `auth_error` does — so matching on `_error` would let two thirds of
 * them through as unknown frames and the session would look healthy while
 * transcribing nothing.
 */
const ERROR_MESSAGE_TYPES: ReadonlySet<string> = new Set([
    "error",
    "auth_error",
    "quota_exceeded",
    "transcriber_error",
    "input_error",
    "invalid_request",
    "commit_throttled",
    "unaccepted_terms",
    "rate_limited",
    "queue_overflow",
    "resource_exhausted",
    "session_time_limit_exceeded",
    "chunk_size_exceeded",
    "insufficient_audio_activity",
]);

const { log } = logger.scoped("ai-stt");

interface ElevenLabsMessage {
    message_type?: string;
    text?: string;
    error?: string;
    warning?: string;
    session_id?: string;
    config?: { model_id?: string; sample_rate?: number; commit_strategy?: string };
}

export function elevenLabsRealtimeUrl(options: {
    sampleRateHz: number;
    model?: string;
    /** First code is `language_code`, the rest become `secondary_languages`. */
    languages?: string[];
    host?: string;
}): string {
    const rate = options.sampleRateHz;

    if (!(ELEVENLABS_PCM_SAMPLE_RATES as readonly number[]).includes(rate)) {
        throw new Error(
            `ElevenLabs realtime STT does not accept ${rate} Hz. Supported: ${ELEVENLABS_PCM_SAMPLE_RATES.join(", ")}.`
        );
    }

    const params = new URLSearchParams({
        model_id: options.model ?? DEFAULT_MODEL,
        audio_format: `pcm_${rate}`,
        // VAD commits a segment when the speaker stops, which is what turns a
        // stream of partials into the `committed_transcript` finals downstream
        // consumers act on. Manual commits would make `end()` the only commit.
        commit_strategy: "vad",
    });

    const [primary, ...secondary] = options.languages ?? [];
    if (primary) {
        params.set("language_code", primary);
    }

    for (const code of secondary) {
        params.append("secondary_languages", code);
    }

    return `${options.host ?? ELEVENLABS_REALTIME_HOST}?${params}`;
}

/** One inbound frame → the shared live-transcript shape. `null` means "nothing to report". */
export function parseElevenLabsMessage(raw: string, nowMs: number): LiveTranscriptEvent | null {
    const message = SafeJSON.parse(raw, { strict: true }) as ElevenLabsMessage | null;

    if (!message || typeof message !== "object") {
        return null;
    }

    const type = message.message_type ?? "";

    if (ERROR_MESSAGE_TYPES.has(type) || typeof message.error === "string") {
        return {
            kind: "error",
            text: "",
            isFinal: false,
            startedAtMs: nowMs,
            error: `${type || "error"}: ${message.error ?? "unknown"}`,
        };
    }

    if (type === "session_started") {
        log.info(
            {
                provider: "elevenlabs",
                sessionId: message.session_id,
                model: message.config?.model_id,
                sampleRate: message.config?.sample_rate,
                commitStrategy: message.config?.commit_strategy,
            },
            "ElevenLabs realtime session started"
        );
        return null;
    }

    if (type === "warning") {
        log.warn({ provider: "elevenlabs", warning: message.warning }, "ElevenLabs realtime warning");
        return null;
    }

    const text = message.text?.trim() ?? "";

    if (type === "partial_transcript") {
        return text ? { kind: "partial", text, isFinal: false, startedAtMs: nowMs } : null;
    }

    if (type === "committed_transcript") {
        return text ? { kind: "final", text, isFinal: true, startedAtMs: nowMs } : null;
    }

    // `committed_transcript_with_timestamps` and `committed_transcript_entities`
    // repeat text that `committed_transcript` already delivered, so emitting them
    // would double every final. They are enrichment, and only arrive at all when
    // the query parameters ask for them.
    return null;
}

function audioChunk(args: { pcm: Uint8Array; sampleRateHz: number; commit: boolean }): string {
    return SafeJSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: Buffer.from(args.pcm).toString("base64"),
        commit: args.commit,
        sample_rate: args.sampleRateHz,
    });
}

/**
 * Everything this provider contributes to a live session, in one value.
 *
 * Split out so the tests drive the real `frame`, `finish`, `readyWhen` and
 * `parse` against a local server rather than a hand-copied lookalike, which is
 * the version that stays correct when the wire format changes. `url` overrides
 * the host for exactly that.
 */
export function elevenLabsSocketSpec(
    options: Pick<ProviderSessionOptions, "apiKey" | "sampleRateHz" | "model" | "languages"> & { url?: string }
): SocketSpec {
    const sampleRateHz = options.sampleRateHz;

    return {
        provider: "elevenlabs",
        url: options.url ?? elevenLabsRealtimeUrl(options),
        headers: { "xi-api-key": options.apiKey },
        // Audio sent before `session_started` can come back as `input_error`, so
        // frames queue until the server has confirmed the configuration.
        readyWhen: (raw) => raw.includes("session_started"),
        frame: (pcm) => [audioChunk({ pcm, sampleRateHz, commit: false })],
        // The documented end-of-audio marker: an empty chunk with `commit` set,
        // which flushes the segment still in flight as a final.
        finish: () => [audioChunk({ pcm: new Uint8Array(0), sampleRateHz, commit: true })],
        parse: parseElevenLabsMessage,
    };
}

/**
 * Live microphone transcription over Scribe's realtime WebSocket.
 *
 * Everything that is not the ElevenLabs protocol — the queue before the socket is
 * ready, the event iterator, one reconnect, abort, the `stt` profiler scope —
 * belongs to `openSocketSession`, so this file stays comparable to the API
 * reference line by line.
 */
export function openElevenLabsStt(options: ProviderSessionOptions): Promise<LiveSttSession> {
    if (!options.apiKey) {
        throw new Error("ElevenLabs live STT needs an API key; none was resolved for the account.");
    }

    const spec = elevenLabsSocketSpec(options);

    log.info(
        {
            provider: "elevenlabs",
            accountId: options.accountId,
            model: options.model ?? DEFAULT_MODEL,
            sampleRateHz: options.sampleRateHz,
            languages: options.languages,
        },
        "opening ElevenLabs realtime STT"
    );

    return openSocketSession({ accountId: options.accountId, signal: options.signal, spec });
}
