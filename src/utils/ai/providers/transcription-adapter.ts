import type { AIProviderType } from "@genesiscz/utils/config/ai.types";
import type { TranscriptionModel } from "ai";
import { transcribe as sdkTranscribe } from "ai";
import type { ResolvedBinding } from "../core/types";
import { buildTranscriptionProviderOptions, mapSdkTranscription } from "../transcription/sdk-result";
import type { AITask, AITranscriptionProvider, TranscribeOptions, TranscriptionResult } from "../types";

/**
 * Presents one of the repo's own transcription providers (transformers.js
 * whisper, the xAI STT client) as an ai-sdk transcription model.
 *
 * The sibling of `embedding-adapter.ts`, and for the same reason: the local
 * providers predate the ai-sdk shape and speak `transcribe(Buffer, options)`.
 * Wrapping them here means `ProviderBinding.transcription()` is the ONLY way the
 * task facade ever asks for a transcript, whether the audio goes to Deepgram or
 * to a model on this laptop.
 *
 * `providerOptions` is where a language hint arrives (the SDK has no top-level
 * `language` parameter — see TranscriptionManager.buildProviderOptions), so this
 * reads its own provider id out of that record rather than inventing a channel.
 */
export function toTranscriptionModel({
    provider,
    providerId,
    modelId,
}: {
    provider: AITranscriptionProvider;
    providerId: string;
    modelId: string;
}): TranscriptionModel {
    return {
        specificationVersion: "v3",
        provider: providerId,
        modelId,

        async doGenerate(options) {
            const audio =
                typeof options.audio === "string" ? Buffer.from(options.audio, "base64") : Buffer.from(options.audio);

            const own = options.providerOptions?.[providerId] ?? {};
            const transcribeOptions: TranscribeOptions = {
                model: modelId,
                ...(typeof own.language === "string" ? { language: own.language } : {}),
                ...(typeof own.diarize === "boolean" ? { diarize: own.diarize } : {}),
                ...(typeof own.speakers === "number" ? { speakers: own.speakers } : {}),
            };

            const result = await provider.transcribe(audio, transcribeOptions);

            return {
                text: result.text,
                segments: (result.segments ?? []).map((segment) => ({
                    text: segment.text,
                    startSecond: segment.start,
                    endSecond: segment.end,
                })),
                language: result.language,
                durationInSeconds: result.duration,
                warnings: [],
                response: { timestamp: new Date(), modelId },
            };
        },
    } as TranscriptionModel;
}

/**
 * The inverse: a bound provider presented as one of the repo's own transcription
 * providers.
 *
 * `Transcriber` owns the parts of transcription that are not the request —
 * splitting audio too large for a single upload, retrying transient failures,
 * cleaning repetition loops, running local diarization on the whole buffer — and
 * none of that is vendor-specific. Rather than reimplement it above the binding,
 * the binding is dressed as the interface `Transcriber` already drives, so the
 * plugin layer replaces only the part it should: who gets asked.
 */
export function fromTranscriptionModel(resolved: ResolvedBinding): AITranscriptionProvider {
    const providerId = resolved.plugin.id;
    const model = resolved.binding.transcription?.(resolved.model.id);

    if (!model) {
        throw new Error(`${providerId} exposes no transcription model`);
    }

    return {
        // `AIProviderType` is the legacy union; plugin ids are a superset of it
        // and this value is only ever compared against provider names (the
        // deepgram and CLOUD_PROVIDER_TYPES checks in tasks/Transcriber.ts).
        type: providerId as AIProviderType,

        async isAvailable(): Promise<boolean> {
            return true;
        },

        supports(task: AITask): boolean {
            return task === "transcribe";
        },

        async transcribe(audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult> {
            const providerOptions = buildTranscriptionProviderOptions(providerId, {
                language: options?.language,
                diarize: options?.diarize,
                speakers: options?.speakers,
            });

            const raw = await sdkTranscribe({
                model,
                audio,
                ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
            });

            // Cleanup stays OFF here: `Transcriber` runs it once over the
            // stitched result, and running it per chunk as well would collapse
            // repeated phrases that only look repeated inside one window.
            const mapped = mapSdkTranscription({
                result: raw,
                provider: providerId,
                diarize: options?.diarize,
                clean: false,
            });

            return {
                text: mapped.text,
                segments: mapped.segments,
                language: raw.language ?? options?.language,
                duration: raw.durationInSeconds,
            };
        },

        dispose(): void {
            resolved.binding.dispose?.();
        },
    };
}
