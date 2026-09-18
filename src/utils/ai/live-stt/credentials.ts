import { env } from "@genesiscz/utils/env";
import type { LiveSttProviderId } from "./types";

export function sttCredential(id: LiveSttProviderId): { key: string; envKey: string } {
    if (id === "deepgram") {
        const key = env.ai.deepgram.getKey();
        const envKey = env.ai.deepgram.getEnvKey();
        if (!key || !envKey) {
            throw new Error("STT account has no Deepgram key. Use tools ai accounts, or --stt grok-live.");
        }
        return { key, envKey };
    }
    if (id === "grok-live") {
        const key = env.x.getApiKey();
        const envKey = env.x.getApiEnvKey();
        if (!key || !envKey) {
            throw new Error("STT account has no xAI key. Use tools ai accounts.");
        }
        return { key, envKey };
    }
    if (id === "gpt-realtime") {
        const key = env.ai.openai.getKey();
        const envKey = env.ai.openai.getEnvKey();
        if (!key || !envKey) {
            throw new Error("gpt-realtime quota or key missing for this account. Not falling back.");
        }
        return { key, envKey };
    }
    throw new Error("mock STT does not use credentials");
}
