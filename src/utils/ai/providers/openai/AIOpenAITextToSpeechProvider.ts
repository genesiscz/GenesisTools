import logger from "@app/logger";
import { rateLimitAwareDelay, retry } from "@app/utils/async";
import type { AIProviderType } from "@app/utils/config/ai.types";
import { SafeJSON } from "@app/utils/json";
import type { AITask, AITextToSpeechProvider, TTSOptions, TTSResult, TTSVoice } from "../../types";

const BASE_URL = "https://api.openai.com/v1";
const MAX_INPUT_CHARS = 4096;

const SUPPORTED_TASKS: ReadonlySet<AITask> = new Set(["tts"]);
const SYNTHESIZE_RETRY_DELAY = rateLimitAwareDelay();

const DEFAULT_VOICES_TTS_1: TTSVoice[] = [
    { id: "alloy", name: "alloy", description: "Neutral, conversational" },
    { id: "echo", name: "echo", description: "Smooth male" },
    { id: "fable", name: "fable", description: "Expressive narrator" },
    { id: "onyx", name: "onyx", description: "Deep male" },
    { id: "nova", name: "nova", description: "Energetic female" },
    { id: "shimmer", name: "shimmer", description: "Warm female" },
];

const GPT_4O_VOICES: TTSVoice[] = [
    ...DEFAULT_VOICES_TTS_1,
    { id: "ash", name: "ash" },
    { id: "ballad", name: "ballad" },
    { id: "coral", name: "coral" },
    { id: "sage", name: "sage" },
    { id: "verse", name: "verse" },
];

function shouldRetrySynthesize(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);

    if (/\b(400|401|403|404)\b/.test(msg)) {
        return false;
    }

    return true;
}

function pickContentType(format?: TTSOptions["format"]): string {
    if (format === "wav") {
        return "audio/wav";
    }

    return "audio/mpeg";
}

function readApiKey(): string {
    const key = process.env.OPENAI_API_KEY;

    if (!key) {
        throw new Error("OPENAI_API_KEY environment variable is not set.");
    }

    return key;
}

function resolveModel(modelOpt?: string): string {
    return modelOpt ?? "tts-1";
}

export class AIOpenAITextToSpeechProvider implements AITextToSpeechProvider {
    readonly type: AIProviderType = "openai";

    async isAvailable(): Promise<boolean> {
        return !!process.env.OPENAI_API_KEY;
    }

    supports(task: AITask): boolean {
        return SUPPORTED_TASKS.has(task);
    }

    async synthesize(text: string, options?: TTSOptions & { model?: string }): Promise<TTSResult> {
        if (text.length > MAX_INPUT_CHARS) {
            throw new Error(
                `OpenAI TTS text exceeds ${MAX_INPUT_CHARS}-character limit. Split the input into smaller requests.`
            );
        }

        return retry(() => this.synthesizeOnce(text, options), {
            maxAttempts: 3,
            getDelay: SYNTHESIZE_RETRY_DELAY,
            shouldRetry: shouldRetrySynthesize,
        });
    }

    private async synthesizeOnce(text: string, options?: TTSOptions & { model?: string }): Promise<TTSResult> {
        const apiKey = readApiKey();
        const format = options?.format ?? "mp3";
        const body = {
            model: resolveModel(options?.model),
            input: text,
            voice: options?.voice ?? "alloy",
            response_format: format,
        };

        const response = await fetch(`${BASE_URL}/audio/speech`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: SafeJSON.stringify(body),
        });

        if (!response.ok) {
            const errBody = await response.text().catch(() => "");
            throw new Error(`OpenAI TTS failed: ${response.status} ${response.statusText} — ${errBody.slice(0, 500)}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const contentType = response.headers.get("content-type") ?? pickContentType(format);
        return { audio: Buffer.from(arrayBuffer), contentType };
    }

    /** HTTP chunked streaming — yields response.body chunks as they arrive. */
    synthesizeStream(
        text: string,
        options?: TTSOptions & { model?: string }
    ): { audio: AsyncIterable<Uint8Array>; contentType: string } {
        if (text.length > MAX_INPUT_CHARS) {
            throw new Error(
                `OpenAI TTS text exceeds ${MAX_INPUT_CHARS}-character limit. Split the input into smaller requests.`
            );
        }

        const apiKey = readApiKey();
        const format = options?.format ?? "mp3";
        const body = {
            model: resolveModel(options?.model),
            input: text,
            voice: options?.voice ?? "alloy",
            response_format: format,
        };

        const audio = (async function* iter(): AsyncIterable<Uint8Array> {
            const response = await fetch(`${BASE_URL}/audio/speech`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: SafeJSON.stringify(body),
            });

            if (!response.ok) {
                const errBody = await response.text().catch(() => "");
                throw new Error(
                    `OpenAI TTS failed: ${response.status} ${response.statusText} — ${errBody.slice(0, 500)}`
                );
            }

            if (!response.body) {
                throw new Error("OpenAI TTS: response.body is null");
            }

            const reader = response.body.getReader();

            try {
                while (true) {
                    const { value, done } = await reader.read();

                    if (done) {
                        return;
                    }

                    if (value && value.byteLength > 0) {
                        yield value;
                    }
                }
            } finally {
                try {
                    reader.releaseLock();
                } catch (err) {
                    logger.debug(`OpenAI TTS reader release: ${err}`);
                }
            }
        })();

        return { audio, contentType: pickContentType(format) };
    }

    async listVoices(options?: { model?: string }): Promise<TTSVoice[]> {
        const model = options?.model ?? "tts-1";
        return model.startsWith("gpt-4o") ? GPT_4O_VOICES : DEFAULT_VOICES_TTS_1;
    }
}
