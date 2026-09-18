import { SafeJSON } from "@genesiscz/utils/json";
import type { LiveSttProviderId, TranscriptEvent } from "./types";

const PARTIAL = new Set(["conversation.item.input_audio_transcription.delta", "input_audio_transcription.delta"]);
const FINAL = new Set([
    "conversation.item.input_audio_transcription.completed",
    "input_audio_transcription.completed",
    "conversation.item.input_audio_transcription.done",
]);

export function parseRealtimeEvent(
    raw: string,
    provider: Exclude<LiveSttProviderId, "mock" | "deepgram">,
    tMs = Date.now()
): TranscriptEvent | null {
    const event = SafeJSON.parse(raw, { strict: true }) as {
        type?: string;
        delta?: string;
        transcript?: string;
        error?: { message?: string };
    };
    if (!event || typeof event.type !== "string") {
        return null;
    }
    if (event.type === "error" || event.type.endsWith(".error")) {
        return { type: "error", text: "", tMs, provider, error: event.error?.message ?? event.type };
    }
    if (PARTIAL.has(event.type) && event.delta) {
        return { type: "partial", text: event.delta, tMs, provider };
    }
    const text = event.transcript?.trim();
    if (FINAL.has(event.type) && text) {
        return { type: "final", text, tMs, provider };
    }
    return null;
}

export function realtimeSessionUpdate(transcriptionModel: string): Record<string, unknown> {
    return {
        type: "session.update",
        session: {
            modalities: ["text"],
            turn_detection: { type: "server_vad" },
            audio: {
                input: {
                    format: { type: "audio/pcm", rate: 24000 },
                    transcription: { model: transcriptionModel },
                },
            },
        },
    };
}
