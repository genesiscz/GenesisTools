import { rateLimitAwareDelay, retry } from "@app/utils/async";
import type { AIProviderType } from "@app/utils/config/ai.types";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage/storage";
import type { AITask, AITextToSpeechProvider, TTSOptions, TTSResult, TTSVoice } from "../../types";
import { XAIClient } from "./XAIClient";

const MAX_TTS_DELTA_CHARS = 15_000;
const VOICE_CACHE_TTL = "7 days";
const VOICE_CACHE_KEY = "xai-voices.json";
const TEXT_DELTA_CHUNK_SIZE = 5_000;

const SUPPORTED_TASKS: ReadonlySet<AITask> = new Set(["tts"]);
const SYNTHESIZE_RETRY_DELAY = rateLimitAwareDelay();

interface XAIVoiceResponse {
    voices: Array<{
        voice_id: string;
        name: string;
        description?: string;
        locale?: string;
    }>;
}

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

export interface AIXAITextToSpeechProviderOptions {
    /** Bypass the 7-day voice list cache (used by tests). */
    forceFreshVoices?: boolean;
}

export class AIXAITextToSpeechProvider implements AITextToSpeechProvider {
    readonly type: AIProviderType = "xai";
    /**
     * Measured against macOS `say` rendered to AIFF (Samantha voice) using `ffmpeg volumedetect`:
     *   macOS native: mean -16.2 dB / peak -1.6 dB / -16.5 LUFS
     *   xAI mp3 raw:  mean -23.3 dB / peak -6.7 dB / -23.0 LUFS
     * Mean delta = 7.1 dB. With `volume=7dB,alimiter=limit=0.97`, xAI lands at mean -16.3 dB /
     * peak -0.3 dB / -16.1 LUFS — within 0.1 dB of native on the channel humans perceive as
     * loudness. The limiter keeps peaks below -0.3 dBFS so no audible distortion at any user volume.
     */
    readonly loudnessOffsetDb = 7;
    private readonly client = new XAIClient();
    private readonly storage = new Storage("ai");
    private readonly forceFreshVoices: boolean;

    constructor(options?: AIXAITextToSpeechProviderOptions) {
        this.forceFreshVoices = options?.forceFreshVoices ?? false;
    }

    async isAvailable(): Promise<boolean> {
        return this.client.isConfigured();
    }

    supports(task: AITask): boolean {
        return SUPPORTED_TASKS.has(task);
    }

    async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
        if (text.length > MAX_TTS_DELTA_CHARS) {
            throw new Error(
                `xAI TTS text exceeds ${MAX_TTS_DELTA_CHARS}-character REST limit. Use streaming via --stream.`
            );
        }

        return retry(() => this.synthesizeOnce(text, options), {
            maxAttempts: 3,
            getDelay: SYNTHESIZE_RETRY_DELAY,
            shouldRetry: shouldRetrySynthesize,
        });
    }

    private async synthesizeOnce(text: string, options?: TTSOptions): Promise<TTSResult> {
        const format = options?.format ?? "mp3";
        const body: Record<string, unknown> = {
            text,
            voice_id: options?.voice ?? "eve",
            language: options?.language ?? "auto",
        };

        if (format !== "mp3") {
            body.output_format = { codec: format };
        }

        if (options?.textNormalization) {
            body.text_normalization = true;
        }

        const response = await this.client.fetch("/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify(body),
        });

        if (!response.ok) {
            const errBody = await response.text().catch(() => "");
            throw new Error(`xAI TTS failed: ${response.status} ${response.statusText} — ${errBody.slice(0, 500)}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const contentType = response.headers.get("content-type") ?? pickContentType(format);
        return { audio: Buffer.from(arrayBuffer), contentType };
    }

    /**
     * Streams audio from xAI's dedicated TTS WebSocket (`wss://api.x.ai/v1/tts`).
     *
     * Protocol:
     *   client → {type: "text.delta", delta: <chunk>} (one or many)
     *   client → {type: "text.done"}
     *   server → {type: "audio.delta", delta: <base64>}
     *   server → {type: "audio.done"}            // graceful end
     *   server → {type: "error", message: <msg>} // failure
     *
     * Cost is identical to REST ($4.20 / 1M input chars). No total-text limit.
     */
    synthesizeStream(text: string, options?: TTSOptions): { audio: AsyncIterable<Uint8Array>; contentType: string } {
        const client = this.client;
        const voice = options?.voice ?? "eve";
        const language = options?.language ?? "auto";
        const codec = options?.format ?? "mp3";
        const contentType = codec === "wav" ? "audio/wav" : "audio/mpeg";

        const params = new URLSearchParams({
            language,
            voice,
            codec,
            sample_rate: "24000",
        });

        const audio = (async function* iter(): AsyncIterable<Uint8Array> {
            const queue: Uint8Array[] = [];
            let resolveNext: ((value: IteratorResult<Uint8Array>) => void) | null = null;
            let done = false;
            let error: Error | null = null;

            const ws = client.openWebSocket("/tts", params);

            const push = (chunk: Uint8Array): void => {
                if (resolveNext) {
                    const r = resolveNext;
                    resolveNext = null;
                    r({ value: chunk, done: false });
                } else {
                    queue.push(chunk);
                }
            };

            const finish = (err?: Error): void => {
                if (done) {
                    return;
                }

                done = true;

                if (err) {
                    error = err;
                }

                if (resolveNext) {
                    const r = resolveNext;
                    resolveNext = null;
                    r({ value: undefined as unknown as Uint8Array, done: true });
                }
            };

            ws.addEventListener("open", () => {
                for (let i = 0; i < text.length; i += TEXT_DELTA_CHUNK_SIZE) {
                    ws.send(
                        SafeJSON.stringify({
                            type: "text.delta",
                            delta: text.slice(i, i + TEXT_DELTA_CHUNK_SIZE),
                        })
                    );
                }

                ws.send(SafeJSON.stringify({ type: "text.done" }));
            });

            ws.addEventListener("error", () => finish(new Error("xAI TTS WebSocket transport error")));

            ws.addEventListener("close", (ev) => {
                if (!done) {
                    finish(new Error(`xAI TTS WebSocket closed before audio.done (code ${ev.code})`));
                }
            });

            ws.addEventListener("message", (event) => {
                let parsed: { type: string; delta?: string; message?: string };

                try {
                    parsed = SafeJSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
                } catch {
                    return;
                }

                switch (parsed.type) {
                    case "audio.delta":
                        if (parsed.delta) {
                            push(Buffer.from(parsed.delta, "base64"));
                        }
                        break;
                    case "audio.done":
                        finish();

                        try {
                            ws.close();
                        } catch {
                            /* noop */
                        }
                        break;
                    case "error":
                        finish(new Error(`xAI TTS error: ${parsed.message ?? "unknown"}`));

                        try {
                            ws.close();
                        } catch {
                            /* noop */
                        }
                        break;
                    default:
                        break;
                }
            });

            try {
                while (true) {
                    if (queue.length > 0) {
                        yield queue.shift() as Uint8Array;
                        continue;
                    }

                    if (done) {
                        if (error) {
                            throw error;
                        }

                        return;
                    }

                    const result = await new Promise<IteratorResult<Uint8Array>>((r) => {
                        resolveNext = r;
                    });

                    if (result.done) {
                        if (error) {
                            throw error;
                        }

                        return;
                    }

                    yield result.value;
                }
            } finally {
                try {
                    ws.close();
                } catch {
                    /* noop */
                }
            }
        })();

        return { audio, contentType };
    }

    async listVoices(): Promise<TTSVoice[]> {
        if (this.forceFreshVoices) {
            return this.fetchVoices();
        }

        return this.storage.getFileOrPut(VOICE_CACHE_KEY, () => this.fetchVoices(), VOICE_CACHE_TTL);
    }

    private async fetchVoices(): Promise<TTSVoice[]> {
        const response = await this.client.fetch("/tts/voices");

        if (!response.ok) {
            const errBody = await response.text().catch(() => "");
            throw new Error(
                `xAI list voices failed: ${response.status} ${response.statusText} — ${errBody.slice(0, 500)}`
            );
        }

        const data = (await response.json()) as XAIVoiceResponse;
        return data.voices.map((v) => ({
            id: v.voice_id,
            name: v.name,
            description: v.description,
            locale: v.locale,
        }));
    }
}
