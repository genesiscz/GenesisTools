import type { SttProviderId } from "./types";

export const LIVE_STT_MODELS: Record<Exclude<SttProviderId, "fixture">, string> = {
    deepgram: "nova-3",
    openai: "gpt-live-transcribe",
    xai: "grok-voice-transcribe-2.0",
    elevenlabs: "scribe_v2_realtime",
};
