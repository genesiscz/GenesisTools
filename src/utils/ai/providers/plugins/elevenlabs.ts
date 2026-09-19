import { resolveCredential } from "../credentials";
import { AIElevenLabsTextToSpeechProvider } from "../elevenlabs/AIElevenLabsTextToSpeechProvider";
import { AIElevenLabsTranscriptionProvider } from "../elevenlabs/AIElevenLabsTranscriptionProvider";
import { ELEVENLABS_PROVIDER_ID } from "../elevenlabs/ElevenLabsClient";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../plugin-types";
import { toSpeechModel } from "../speech-adapter";
import { toTranscriptionModel } from "../transcription-adapter";

/**
 * ElevenLabs: voice only.
 *
 * It is the first plugin here with no chat model at all — every other API-key
 * provider is built on an ai-sdk factory whose `languageModel()` works — so
 * `language()` throws by design rather than returning something that 404s. The
 * three declared capabilities each have a real path behind them: `tts` through
 * the REST voice API, `transcribe` through batch Scribe, and `realtime` through
 * the Scribe WebSocket in `ai/stt/providers/elevenlabs.ts`, which the STT
 * resolver opens with the credential this same spec describes.
 */
export const elevenLabsPlugin: ProviderPlugin = {
    id: ELEVENLABS_PROVIDER_ID,
    kind: "api-key",
    capabilities: new Set(["tts", "transcribe", "realtime"]),
    credential: { fields: ["apiKey"], envKeys: ["ELEVENLABS_API_KEY"], required: ["apiKey"] },

    async bind(ctx: BindContext): Promise<ProviderBinding> {
        const { apiKey } = await resolveCredential(ctx.account, this.credential);

        if (!apiKey) {
            // `required` makes this unreachable; it exists so the engines below
            // take a `string` rather than a `string | undefined`.
            throw new Error(`No API key resolved for ${ELEVENLABS_PROVIDER_ID}`);
        }

        return {
            accountId: ctx.account.id,
            providerId: ELEVENLABS_PROVIDER_ID,
            billed: true,

            language(modelId: string): never {
                throw new Error(
                    `elevenlabs has no chat models (asked for "${modelId}"). ` +
                        "It serves text-to-speech and transcription only."
                );
            },

            // The engines are constructed WITH the account's key rather than
            // reached through `speechEngineFor()`, which builds a keyless engine
            // that would resolve the credential again on its own. A binding that
            // already knows which account was chosen must not let a second
            // lookup pick a different one.
            speech: (modelId: string) =>
                toSpeechModel({
                    provider: new AIElevenLabsTextToSpeechProvider({ apiKey, modelId }),
                    providerId: ELEVENLABS_PROVIDER_ID,
                    modelId,
                }),

            transcription: (modelId: string) =>
                toTranscriptionModel({
                    provider: new AIElevenLabsTranscriptionProvider({ apiKey, modelId }),
                    providerId: ELEVENLABS_PROVIDER_ID,
                    modelId,
                }),
        };
    },
};
