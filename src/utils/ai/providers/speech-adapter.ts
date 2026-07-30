import type { SpeechModel } from "ai";
import type { AITextToSpeechProvider } from "../types";

/**
 * Presents one of the repo's own TTS providers (macOS `say`, the xAI voice
 * client) as an ai-sdk speech model.
 *
 * Third sibling of `embedding-adapter.ts` and `transcription-adapter.ts`. It
 * exists so a binding's declared `tts` capability is honest: before this, the
 * macos plugin advertised `tts` while its binding exposed no `speech()` at all
 * (local/adapters/index.ts:64-69 deferred it to this phase), which meant a
 * capability check said yes and the call then failed.
 *
 * ⚠️ The ai-sdk speech shape is text-in / audio-out and nothing else, so it
 * cannot express the three things that make our TTS providers worth having: the
 * macOS native `speak()` short-circuit (audio straight to the speakers, no temp
 * file), xAI's WebSocket streaming, and per-provider loudness offsets. Callers
 * that need those must go through `Synthesizer`, which drives the rich interface
 * directly. This adapter is for consumers that only want bytes.
 */
export function toSpeechModel({
    provider,
    providerId,
    modelId,
}: {
    provider: AITextToSpeechProvider;
    providerId: string;
    modelId: string;
}): SpeechModel {
    return {
        specificationVersion: "v3",
        provider: providerId,
        modelId,

        async doGenerate(options) {
            const result = await provider.synthesize(options.text, {
                ...(options.voice ? { voice: options.voice } : {}),
                ...(options.language ? { language: options.language } : {}),
                ...(options.outputFormat === "mp3" || options.outputFormat === "wav"
                    ? { format: options.outputFormat }
                    : {}),
            });

            return {
                audio: new Uint8Array(result.audio),
                warnings: [],
                response: { timestamp: new Date(), modelId, headers: undefined },
            };
        },
    } as SpeechModel;
}
