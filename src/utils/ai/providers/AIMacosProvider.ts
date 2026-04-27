import type { AIProviderType } from "@app/utils/config/ai.types";
import { listVoicesStructured, renderToBuffer } from "@app/utils/macos/tts";
import type { AITask, AITextToSpeechProvider, TTSOptions, TTSResult, TTSVoice } from "../types";

/**
 * macOS TTS provider — wraps the native `say` command and exposes it via the
 * AITextToSpeechProvider interface so callers can route through the registry.
 */
export class AIMacosProvider implements AITextToSpeechProvider {
    readonly type: AIProviderType = "macos";

    async isAvailable(): Promise<boolean> {
        return process.platform === "darwin";
    }

    supports(task: AITask): boolean {
        return task === "tts";
    }

    async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
        const audio = await renderToBuffer(text, { voice: options?.voice });

        return {
            audio,
            contentType: "audio/x-aiff",
        };
    }

    async listVoices(): Promise<TTSVoice[]> {
        const voices = await listVoicesStructured();

        return voices.map((v) => ({
            id: v.name,
            name: v.name,
            locale: v.locale,
            description: v.sample,
        }));
    }
}
