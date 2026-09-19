import { SafeJSON } from "@genesiscz/utils/json";
import { resamplePcm16 } from "../pcm";
import { openSocketSession } from "../socket-session";
import type { LiveSttSession, LiveTranscriptEvent, ProviderSessionOptions } from "../types";
import { LocalVad } from "../vad";

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const DEFAULT_MODEL = "gpt-live-transcribe";
/** OpenAI rejects `audio/pcm` below this rate; lower capture rates are resampled on the way in. */
export const OPENAI_REALTIME_MIN_RATE_HZ = 24000;

const PARTIAL_EVENTS = new Set([
    "conversation.item.input_audio_transcription.delta",
    "input_audio_transcription.delta",
]);
const FINAL_EVENTS = new Set([
    "conversation.item.input_audio_transcription.completed",
    "input_audio_transcription.completed",
    "conversation.item.input_audio_transcription.done",
]);

interface RealtimeEvent {
    type?: string;
    delta?: string;
    transcript?: string;
    error?: { message?: string; code?: string };
}

/** The transcription-session update OpenAI's realtime API expects (2026 grammar, `type: transcription`). */
export function realtimeTranscriptionSessionUpdate(options: {
    model: string;
    sampleRateHz: number;
    languages?: string[];
}): Record<string, unknown> {
    return {
        type: "session.update",
        session: {
            type: "transcription",
            audio: {
                input: {
                    format: { type: "audio/pcm", rate: options.sampleRateHz },
                    transcription: {
                        model: options.model,
                        ...(options.languages?.length ? { languages: options.languages } : {}),
                    },
                    // gpt-live-transcribe rejects server turn detection; the client commits on local
                    // silence (LocalVad in `frame`) and on `end()`.
                    turn_detection: null,
                },
            },
        },
    };
}

export function parseRealtimeEvent(raw: string, nowMs: number): LiveTranscriptEvent | null {
    const event = SafeJSON.parse(raw, { strict: true }) as RealtimeEvent | null;
    if (!event || typeof event.type !== "string") {
        return null;
    }

    if (event.type === "error" || event.type.endsWith(".error")) {
        return {
            kind: "error",
            text: "",
            isFinal: false,
            startedAtMs: nowMs,
            error: event.error?.message ?? event.type,
        };
    }

    if (event.type === "input_audio_buffer.speech_started") {
        return { kind: "speech_start", text: "", isFinal: false, startedAtMs: nowMs };
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
        return { kind: "speech_end", text: "", isFinal: false, startedAtMs: nowMs };
    }

    if (PARTIAL_EVENTS.has(event.type) && event.delta) {
        return { kind: "partial", text: event.delta, isFinal: false, startedAtMs: nowMs };
    }

    const text = event.transcript?.trim();
    if (FINAL_EVENTS.has(event.type) && text) {
        return { kind: "final", text, isFinal: true, startedAtMs: nowMs };
    }

    return null;
}

export function openOpenAiRealtimeStt(options: ProviderSessionOptions): Promise<LiveSttSession> {
    if (!options.apiKey) {
        throw new Error("OpenAI realtime STT needs an API key; none was resolved for the account.");
    }

    const model = options.model ?? DEFAULT_MODEL;
    const wireRateHz = Math.max(options.sampleRateHz, OPENAI_REALTIME_MIN_RATE_HZ);
    const vad = new LocalVad();
    const commit = SafeJSON.stringify({ type: "input_audio_buffer.commit" });
    return openSocketSession({
        accountId: options.accountId,
        signal: options.signal,
        spec: {
            provider: "openai",
            url: OPENAI_REALTIME_URL,
            headers: { Authorization: `Bearer ${options.apiKey}` },
            hello: () => [
                SafeJSON.stringify(
                    realtimeTranscriptionSessionUpdate({
                        model,
                        sampleRateHz: wireRateHz,
                        languages: options.languages,
                    })
                ),
            ],
            frame: (pcm) => {
                const messages = [
                    SafeJSON.stringify({
                        type: "input_audio_buffer.append",
                        audio: Buffer.from(resamplePcm16(pcm, options.sampleRateHz, wireRateHz)).toString("base64"),
                    }),
                ];
                if (vad.push(pcm) === "speech_end") {
                    messages.push(commit);
                }

                return messages;
            },
            finish: () => [commit],
            parse: parseRealtimeEvent,
        },
    });
}
