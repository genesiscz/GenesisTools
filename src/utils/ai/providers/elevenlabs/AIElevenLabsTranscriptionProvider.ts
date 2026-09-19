import type {
    AITask,
    AITranscriptionProvider,
    TranscribeOptions,
    TranscriptionResult,
    TranscriptionSegment,
} from "@genesiscz/utils/ai/types";
import { detectAudioFormat } from "@genesiscz/utils/audio/detect-format";
import type { AIProviderType } from "@genesiscz/utils/config/ai.types";
import { logger } from "@genesiscz/utils/logger";
import { ElevenLabsClient } from "./ElevenLabsClient";

/** Scribe v1 is the batch STT model; `scribe_v2_realtime` serves the WebSocket only. */
export const ELEVENLABS_DEFAULT_STT_MODEL_ID = "scribe_v1";

const SUPPORTED_TASKS: ReadonlySet<AITask> = new Set(["transcribe"]);

interface ElevenLabsTranscriptionWord {
    text: string;
    type?: "word" | "spacing" | "audio_event";
    start?: number | null;
    end?: number | null;
    speaker_id?: string | null;
}

interface ElevenLabsTranscriptionResponse {
    text: string;
    language_code?: string;
    words?: ElevenLabsTranscriptionWord[];
}

export interface AIElevenLabsTranscriptionProviderOptions {
    /** Resolved by the plugin binding from the account's credential. Omit to resolve lazily. */
    apiKey?: string;
    modelId?: string;
}

/**
 * Batch transcription over `POST /v1/speech-to-text`.
 *
 * It exists so the plugin's declared `transcribe` capability is honest: a
 * capability the binding cannot serve answers "yes" to a capability check and
 * then fails at the call, which is the exact trap `speech-adapter.ts` documents
 * for `tts`. Live microphone transcription is a different endpoint entirely and
 * lives in `ai/stt/providers/elevenlabs.ts`.
 */
export class AIElevenLabsTranscriptionProvider implements AITranscriptionProvider {
    readonly type: AIProviderType = "elevenlabs";
    private readonly client: ElevenLabsClient;
    private readonly modelId: string;

    constructor(options?: AIElevenLabsTranscriptionProviderOptions) {
        this.client = new ElevenLabsClient(options?.apiKey);
        this.modelId = options?.modelId ?? ELEVENLABS_DEFAULT_STT_MODEL_ID;
    }

    async isAvailable(): Promise<boolean> {
        return this.client.isConfigured();
    }

    supports(task: AITask): boolean {
        return SUPPORTED_TASKS.has(task);
    }

    async transcribe(audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult> {
        const form = new FormData();
        form.append("model_id", options?.model ?? this.modelId);

        if (options?.language) {
            form.append("language_code", options.language);
        }

        if (options?.diarize) {
            form.append("diarize", "true");
        }

        if (options?.speakers) {
            form.append("num_speakers", String(options.speakers));
        }

        // Magic bytes, not the caller's word: a voice memo is m4a and mislabelling
        // it as mp3 is a 422 that reads like a bad key.
        const { contentType, filename } = detectAudioFormat(audio);
        form.append("file", new Blob([new Uint8Array(audio)], { type: contentType }), filename);

        logger.debug({ model: this.modelId, bytes: audio.byteLength, filename }, "ElevenLabs STT request");
        const response = await this.client.fetch("/v1/speech-to-text", { method: "POST", body: form });

        if (!response.ok) {
            const body = await response
                .text()
                .catch((err: unknown) => {
                    logger.debug({ err, status: response.status }, "could not read the ElevenLabs STT error body");
                    return "";
                })
                .then((text) => text.slice(0, 500));

            throw new Error(`ElevenLabs STT failed: ${response.status} ${response.statusText} — ${body}`);
        }

        const data = (await response.json()) as ElevenLabsTranscriptionResponse;

        return {
            text: data.text,
            language: data.language_code,
            segments: wordsToSegments(data.words),
        };
    }
}

function wordsToSegments(words: ElevenLabsTranscriptionWord[] | undefined): TranscriptionSegment[] | undefined {
    if (!words || words.length === 0) {
        return undefined;
    }

    // `spacing` entries carry the whitespace between words and no useful span, so
    // keeping them would produce empty segments with identical start and end.
    const spoken = words.filter((word) => word.type !== "spacing" && word.start != null && word.end != null);

    if (spoken.length === 0) {
        return undefined;
    }

    return spoken.map((word) => ({ text: word.text, start: word.start ?? 0, end: word.end ?? 0 }));
}
