import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { openSocketSession } from "../socket-session";
import type { LiveSttSession, LiveTranscriptEvent, ProviderSessionOptions } from "../types";

const DEEPGRAM_LISTEN_HOST = "wss://api.deepgram.com/v1/listen";
const DEFAULT_MODEL = "nova-3";
const KEEPALIVE_MS = 8_000;

interface DeepgramMessage {
    type?: string;
    is_final?: boolean;
    speech_final?: boolean;
    start?: number;
    duration?: number;
    channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
    error?: string;
    description?: string;
    message?: string;
}

/** The languages nova-3 can code-switch between in `language=multi` (Deepgram docs, 2026). */
export const DEEPGRAM_MULTI_LANGUAGES = new Set(["en", "es", "fr", "de", "hi", "ru", "pt", "ja", "it", "nl"]);

/**
 * Deepgram takes one `language` code. Several codes select `multi` (nova-3 code switching) only
 * when every code is in the multi set; Czech is not, so `cs,en` pins Czech and logs the drop.
 */
export function deepgramListenUrl(options: { sampleRateHz: number; model?: string; languages?: string[] }): string {
    const params = new URLSearchParams({
        model: options.model ?? DEFAULT_MODEL,
        smart_format: "true",
        interim_results: "true",
        endpointing: "300",
        vad_events: "true",
        encoding: "linear16",
        sample_rate: String(options.sampleRateHz),
        channels: "1",
    });
    const languages = (options.languages ?? []).map((code) => code.toLowerCase().split("-")[0]);
    if (languages.length === 1) {
        params.set("language", languages[0]);
    } else if (languages.length > 1) {
        const allMulti = languages.every((code) => DEEPGRAM_MULTI_LANGUAGES.has(code));
        params.set("language", allMulti ? "multi" : languages[0]);
        if (!allMulti) {
            logger.warn(
                { languages, chosen: languages[0] },
                "Deepgram multi mode does not cover every requested language; pinning the first one"
            );
        }
    }

    return `${DEEPGRAM_LISTEN_HOST}?${params}`;
}

/** One `Results` frame → partial or final; `SpeechStarted` / `UtteranceEnd` → speech markers. */
export function parseDeepgramMessage(raw: string, nowMs: number): LiveTranscriptEvent | null {
    const message = SafeJSON.parse(raw, { strict: true }) as DeepgramMessage | null;
    if (!message || typeof message !== "object") {
        return null;
    }

    if (message.type === "Error" || message.error) {
        return {
            kind: "error",
            text: "",
            isFinal: false,
            startedAtMs: nowMs,
            error: String(message.error ?? message.description ?? message.message ?? "Deepgram error"),
        };
    }

    if (message.type === "SpeechStarted") {
        return { kind: "speech_start", text: "", isFinal: false, startedAtMs: nowMs };
    }

    if (message.type === "UtteranceEnd") {
        return { kind: "speech_end", text: "", isFinal: false, startedAtMs: nowMs };
    }

    if (message.type !== "Results") {
        return null;
    }

    const alternative = message.channel?.alternatives?.[0];
    const text = alternative?.transcript?.trim() ?? "";
    if (!text) {
        return null;
    }

    const isFinal = message.is_final === true || message.speech_final === true;
    return {
        kind: isFinal ? "final" : "partial",
        text,
        isFinal,
        confidence: alternative?.confidence,
        startedAtMs: nowMs,
    };
}

export function openDeepgramStt(options: ProviderSessionOptions): Promise<LiveSttSession> {
    if (!options.apiKey) {
        throw new Error("Deepgram live STT needs an API key; none was resolved for the account.");
    }

    return openSocketSession({
        accountId: options.accountId,
        signal: options.signal,
        spec: {
            provider: "deepgram",
            url: deepgramListenUrl(options),
            headers: { Authorization: `Token ${options.apiKey}` },
            frame: (pcm) => [pcm],
            finish: () => [SafeJSON.stringify({ type: "CloseStream" })],
            keepAlive: { intervalMs: KEEPALIVE_MS, message: () => SafeJSON.stringify({ type: "KeepAlive" }) },
            parse: parseDeepgramMessage,
        },
    });
}
