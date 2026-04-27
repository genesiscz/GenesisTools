import logger from "@app/logger";
import { rateLimitAwareDelay, retry } from "@app/utils/async";
import type { AIProviderType } from "@app/utils/config/ai.types";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage/storage";
import type { AITask, AITextToSpeechProvider, TTSOptions, TTSResult, TTSVoice } from "../../types";
import { XAIClient } from "./XAIClient";

const MAX_TTS_DELTA_CHARS = 15_000;
const VOICE_CACHE_TTL = "7 days";
const VOICE_CACHE_KEY = "xai-voices.json";

/**
 * Realtime endpoint model — best quality for grok-voice-think-fast-1.0.
 * The `/v1/realtime` endpoint uses OpenAI-compatible event protocol.
 * Audio output is PCM16 24kHz mono, delivered as base64 in response.audio.delta.
 */
const REALTIME_MODEL = "grok-voice-think-fast-1.0";

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

// ---------------------------------------------------------------------------
// Realtime WebSocket event types (OpenAI-realtime-compatible protocol)
// ---------------------------------------------------------------------------

interface XAIRealtimeAudioDelta {
    type: "response.audio.delta";
    delta: string; // base64-encoded PCM16 24kHz mono
}

interface XAIRealtimeDone {
    type: "response.done";
}

interface XAIRealtimeError {
    type: "error";
    error: { message: string; code?: string };
}

interface XAIRealtimeConversationCreated {
    type: "conversation.created";
}

type XAIRealtimeEvent =
    | XAIRealtimeAudioDelta
    | XAIRealtimeDone
    | XAIRealtimeError
    | XAIRealtimeConversationCreated
    | { type: string };

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
     * Yields audio chunks via the xAI Realtime WebSocket (`wss://api.x.ai/v1/realtime`).
     *
     * Protocol (OpenAI-realtime-compatible):
     *   1. Server sends `conversation.created` on connect.
     *   2. Client sends `conversation.item.create` (input_text) + `response.create` (modalities: ["audio"]).
     *   3. Server sends `response.audio.delta` events (base64 PCM16 24kHz mono).
     *   4. Server sends `response.done` when finished.
     *
     * Audio format is PCM16 24kHz mono — content-type: audio/pcm.
     */
    synthesizeStream(text: string, options?: TTSOptions): { audio: AsyncIterable<Uint8Array>; contentType: string } {
        const client = this.client;
        const voice = options?.voice ?? "eve";
        const realtimeParams = new URLSearchParams({ model: REALTIME_MODEL });

        const audio = (async function* iter(): AsyncIterable<Uint8Array> {
            const queue: Uint8Array[] = [];
            let resolveNext: ((value: IteratorResult<Uint8Array>) => void) | null = null;
            let done = false;
            let error: Error | null = null;

            const ws = client.openWebSocket("/realtime", realtimeParams);

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
                // Send the text input and request an audio response
                ws.send(
                    SafeJSON.stringify({
                        type: "conversation.item.create",
                        item: {
                            type: "message",
                            role: "user",
                            content: [{ type: "input_text", text }],
                        },
                    })
                );
                ws.send(
                    SafeJSON.stringify({
                        type: "response.create",
                        response: {
                            modalities: ["audio"],
                            voice,
                        },
                    })
                );
            });

            ws.addEventListener("error", () => finish(new Error("xAI Realtime WebSocket error")));

            ws.addEventListener("close", (ev) => {
                if (!done) {
                    finish(new Error(`xAI Realtime WebSocket closed unexpectedly (code ${ev.code})`));
                }
            });

            ws.addEventListener("message", (event) => {
                let parsed: XAIRealtimeEvent;

                try {
                    parsed = SafeJSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
                } catch (err) {
                    logger.debug(`xAI Realtime: malformed event: ${err}`);
                    return;
                }

                switch (parsed.type) {
                    case "conversation.created":
                        // Connection established — messages already queued in open handler
                        break;
                    case "response.audio.delta": {
                        const delta = (parsed as XAIRealtimeAudioDelta).delta;
                        push(Buffer.from(delta, "base64"));
                        break;
                    }
                    case "response.done":
                        try {
                            ws.close();
                        } catch {
                            /* noop */
                        }
                        finish();
                        break;
                    case "error": {
                        const errEvent = parsed as XAIRealtimeError;
                        const msg = errEvent.error?.message ?? "Unknown realtime error";

                        try {
                            ws.close();
                        } catch {
                            /* noop */
                        }

                        finish(new Error(`xAI Realtime error: ${msg}`));
                        break;
                    }
                    default:
                        logger.debug(`xAI Realtime: unhandled event type: ${parsed.type}`);
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

        // Realtime endpoint delivers PCM16 24kHz mono
        return { audio, contentType: "audio/pcm" };
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
