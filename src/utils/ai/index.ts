import { Embedder } from "./tasks/Embedder";
import { Summarizer } from "./tasks/Summarizer";
import { Transcriber } from "./tasks/Transcriber";
import { Translator } from "./tasks/Translator";
import type {
    EmbeddingResult,
    EmbedOptions,
    SummarizationResult,
    SummarizeOptions,
    TranscribeOptions,
    TranscriptionResult,
    TranslateOptions,
    TranslationResult,
} from "./types";

export { AIConfig } from "./AIConfig";
export type {
    LanguageDetectionDriver,
    LanguageDetectionResult,
    LanguageDetectorOptions,
    TextLanguageDetectionDriver,
} from "./LanguageDetector";
export { createLanguageDetector, LanguageDetector } from "./LanguageDetector";
export { ModelManager } from "./ModelManager";
export { Embedder } from "./tasks/Embedder";
export { Summarizer } from "./tasks/Summarizer";
export { Transcriber } from "./tasks/Transcriber";
export { Translator } from "./tasks/Translator";
export * from "./types";

export const AI = {
    Embedder,
    Transcriber,
    Translator,
    Summarizer,

    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
        const e = await Embedder.create();

        try {
            return await e.embed(text, options);
        } finally {
            e.dispose();
        }
    },

    async transcribe(audio: Buffer | string, options?: TranscribeOptions): Promise<TranscriptionResult> {
        const t = await Transcriber.create();
        try {
            return await t.transcribe(audio, options);
        } finally {
            t.dispose();
        }
    },

    async translate(text: string, options: TranslateOptions): Promise<TranslationResult> {
        const t = await Translator.create();
        try {
            return await t.translate(text, options);
        } finally {
            t.dispose();
        }
    },

    async summarize(text: string, options?: SummarizeOptions): Promise<SummarizationResult> {
        const s = await Summarizer.create();
        try {
            return await s.summarize(text, options);
        } finally {
            s.dispose();
        }
    },
};
