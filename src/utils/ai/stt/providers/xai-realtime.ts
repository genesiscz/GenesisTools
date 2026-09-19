import { SafeJSON } from "@genesiscz/utils/json";
import { openSocketSession } from "../socket-session";
import type { LiveSttSession, LiveTranscriptEvent, ProviderSessionOptions } from "../types";

const XAI_STT_HOST = "wss://api.x.ai/v1/stt";
const DEFAULT_MODEL = "grok-voice-transcribe-2.0";

interface XaiSttEvent {
    type?: string;
    text?: string;
    is_final?: boolean;
    speech_final?: boolean;
    message?: string;
    duration?: number;
}

/** xAI formats text for one `language`; the first code wins, the rest are detected by the model. */
export function xaiSttUrl(options: { sampleRateHz: number; model?: string; languages?: string[] }): string {
    const params = new URLSearchParams({
        model: options.model ?? DEFAULT_MODEL,
        sample_rate: String(options.sampleRateHz),
        encoding: "pcm",
        interim_results: "true",
        endpointing: "400",
    });
    const primary = options.languages?.[0];
    if (primary) {
        params.set("language", primary);
    }

    return `${XAI_STT_HOST}?${params}`;
}

/** `transcript.created` = server ready; `transcript.partial` carries partial or final text. */
export function parseXaiSttEvent(raw: string, nowMs: number): LiveTranscriptEvent | null {
    const event = SafeJSON.parse(raw, { strict: true }) as XaiSttEvent | null;
    if (!event || typeof event.type !== "string") {
        return null;
    }

    if (event.type === "error") {
        return { kind: "error", text: "", isFinal: false, startedAtMs: nowMs, error: event.message ?? "xAI STT error" };
    }

    if (event.type === "transcript.partial") {
        const text = event.text?.trim() ?? "";
        if (!text) {
            return null;
        }

        const isFinal = event.is_final === true || event.speech_final === true;
        return { kind: isFinal ? "final" : "partial", text, isFinal, startedAtMs: nowMs };
    }

    if (event.type === "transcript.done") {
        const text = event.text?.trim() ?? "";
        return text ? { kind: "final", text, isFinal: true, startedAtMs: nowMs } : null;
    }

    return null;
}

export function isXaiReady(raw: string): boolean {
    return raw.includes("transcript.created");
}

export function openXaiRealtimeStt(options: ProviderSessionOptions): Promise<LiveSttSession> {
    if (!options.apiKey) {
        throw new Error("xAI live STT needs an API key; none was resolved for the account.");
    }

    return openSocketSession({
        accountId: options.accountId,
        signal: options.signal,
        spec: {
            provider: "xai",
            url: xaiSttUrl(options),
            headers: { Authorization: `Bearer ${options.apiKey}` },
            frame: (pcm) => [pcm],
            finish: () => [SafeJSON.stringify({ type: "audio.done" })],
            parse: parseXaiSttEvent,
            readyWhen: isXaiReady,
        },
    });
}
