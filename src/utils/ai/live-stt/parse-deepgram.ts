import { SafeJSON } from "@genesiscz/utils/json";
import type { TranscriptEvent } from "./types";

export function parseDeepgramMessage(raw: string, tMs = Date.now()): TranscriptEvent | null {
    const message = SafeJSON.parse(raw, { strict: true }) as {
        type?: string;
        is_final?: boolean;
        speech_final?: boolean;
        channel?: { alternatives?: Array<{ transcript?: string }> };
        error?: string;
    };
    if (message?.type === "Error" || message?.error) {
        return { type: "error", text: "", tMs, provider: "deepgram", error: String(message.error ?? "Deepgram error") };
    }
    const text = message?.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
    if (!text && message?.type !== "Results") {
        return null;
    }
    if (!text) {
        return null;
    }
    return {
        type: message.is_final || message.speech_final ? "final" : "partial",
        text,
        tMs,
        provider: "deepgram",
    };
}

export function deepgramListenUrl(options: { sampleRate: number; language?: string }): string {
    const params = new URLSearchParams({
        model: "nova-3",
        smart_format: "true",
        interim_results: "true",
        endpointing: "300",
        encoding: "linear16",
        sample_rate: String(options.sampleRate),
        channels: "1",
    });
    if (options.language) {
        params.set("language", options.language);
    }
    return `wss://api.deepgram.com/v1/listen?${params}`;
}
