import logger from "@app/logger";
import { rateLimitAwareDelay, retry } from "@app/utils/async";
import { convertToWhisperWav } from "@app/utils/audio/converter";
import type { AIProviderType } from "@app/utils/config/ai.types";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage/storage";
import type {
    AITask,
    AITextToSpeechProvider,
    AITranscriptionProvider,
    OnSegment,
    TranscribeOptions,
    TranscriptionResult,
    TranscriptionSegment,
    TTSOptions,
    TTSResult,
    TTSVoice,
} from "../types";

const BASE_URL = "https://api.x.ai/v1";
const WS_BASE_URL = "wss://api.x.ai/v1";
const MAX_TTS_DELTA_CHARS = 15_000;
const VOICE_CACHE_TTL = "7 days";
const VOICE_CACHE_KEY = "xai-voices.json";

const SUPPORTED_TASKS: ReadonlySet<AITask> = new Set(["transcribe", "tts"]);

const SYNTHESIZE_RETRY_DELAY = rateLimitAwareDelay();

interface XAITranscriptionWord {
    text: string;
    start: number;
    end: number;
    speaker?: number;
}

interface XAITranscriptionResponse {
    text: string;
    language?: string;
    duration?: number;
    words?: XAITranscriptionWord[];
}

interface XAIVoiceResponse {
    voices: Array<{
        voice_id: string;
        name: string;
        description?: string;
        locale?: string;
    }>;
}

interface XAIWsTranscriptPartial {
    type: "transcript.partial";
    text: string;
    is_final: boolean;
    speech_final?: boolean;
    start?: number;
    duration?: number;
    words?: XAITranscriptionWord[];
}

interface XAIWsTranscriptDone {
    type: "transcript.done";
    text: string;
    duration?: number;
    words?: XAITranscriptionWord[];
}

interface XAIWsAudioDelta {
    type: "audio.delta";
    delta: string;
}

interface XAIWsAudioDone {
    type: "audio.done";
    trace_id?: string;
}

interface XAIWsError {
    type: "error";
    message: string;
}

type XAIWsTranscriptEvent = { type: "transcript.created" } | XAIWsTranscriptPartial | XAIWsTranscriptDone | XAIWsError;

type XAIWsTtsEvent = XAIWsAudioDelta | XAIWsAudioDone | XAIWsError;

function shouldRetrySynthesize(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);

    if (/\b(400|401|403|404)\b/.test(msg)) {
        return false;
    }

    return true;
}

function readApiKey(): string {
    const key = process.env.X_AI_API_KEY;

    if (!key) {
        throw new Error(
            "X_AI_API_KEY environment variable is not set. Get a key at https://console.x.ai/team/default/api-keys"
        );
    }

    return key;
}

function pickContentType(format?: TTSOptions["format"]): string {
    if (format === "wav") {
        return "audio/wav";
    }

    return "audio/mpeg";
}

function wordsToSegments(words: XAITranscriptionWord[] | undefined): TranscriptionSegment[] | undefined {
    if (!words || words.length === 0) {
        return undefined;
    }

    return words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
}

export interface AIXAIProviderOptions {
    /** Bypass the voice list cache (for tests). */
    forceFreshVoices?: boolean;
}

export class AIXAIProvider implements AITranscriptionProvider, AITextToSpeechProvider {
    readonly type: AIProviderType = "xai";
    private readonly storage = new Storage("ai");
    private readonly forceFreshVoices: boolean;

    constructor(options?: AIXAIProviderOptions) {
        this.forceFreshVoices = options?.forceFreshVoices ?? false;
    }

    async isAvailable(): Promise<boolean> {
        return !!process.env.X_AI_API_KEY;
    }

    supports(task: AITask): boolean {
        return SUPPORTED_TASKS.has(task);
    }

    async transcribe(audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult> {
        const apiKey = readApiKey();
        const form = new FormData();

        if (options?.language) {
            form.append("language", options.language);
            form.append("format", "true");
        }

        if (options?.diarize) {
            form.append("diarize", "true");
        }

        // file MUST be appended last per xAI docs.
        const blob = new Blob([new Uint8Array(audio)], { type: "audio/mpeg" });
        form.append("file", blob, "audio.mp3");

        const response = await fetch(`${BASE_URL}/stt`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
        });

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`xAI STT failed: ${response.status} ${response.statusText} — ${body.slice(0, 500)}`);
        }

        const data = (await response.json()) as XAITranscriptionResponse;

        return {
            text: data.text,
            duration: data.duration,
            language: data.language,
            segments: wordsToSegments(data.words),
        };
    }

    async transcribeStream(audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult> {
        const apiKey = readApiKey();
        const wav = await convertToWhisperWav(audio);
        const pcm = stripWavHeader(wav);
        const sampleRate = 16_000;
        const bytesPer100ms = (sampleRate * 2) / 10; // 16-bit mono PCM at 16 kHz

        const params = new URLSearchParams({
            sample_rate: String(sampleRate),
            encoding: "pcm",
            interim_results: "false",
            endpointing: "10",
        });

        if (options?.language) {
            params.set("language", options.language);
        }

        if (options?.diarize) {
            params.set("diarize", "true");
        }

        const url = `${WS_BASE_URL}/stt?${params.toString()}`;

        return new Promise<TranscriptionResult>((resolve, reject) => {
            const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } } as never);
            const collectedSegments: TranscriptionSegment[] = [];
            let aggregatedText = "";
            let aggregatedDuration: number | undefined;
            let serverReady = false;
            let onSegmentCb: OnSegment | undefined = options?.onSegment;

            const fail = (err: Error): void => {
                onSegmentCb = undefined;
                try {
                    ws.close();
                } catch {
                    /* noop */
                }
                reject(err);
            };

            ws.addEventListener("error", () => fail(new Error("xAI STT WebSocket error")));

            ws.addEventListener("close", (ev) => {
                if (!serverReady) {
                    fail(new Error(`xAI STT WebSocket closed before ready (code ${ev.code})`));
                }
            });

            ws.addEventListener("message", (event) => {
                let parsed: XAIWsTranscriptEvent;

                try {
                    parsed = SafeJSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
                } catch (err) {
                    logger.debug(`xAI STT: malformed event: ${err}`);
                    return;
                }

                switch (parsed.type) {
                    case "transcript.created":
                        serverReady = true;
                        void streamPcmFrames(ws, pcm, bytesPer100ms).catch((err) => fail(err));
                        break;
                    case "transcript.partial":
                        if (parsed.is_final) {
                            const seg: TranscriptionSegment = {
                                text: parsed.text,
                                start: parsed.start ?? 0,
                                end: (parsed.start ?? 0) + (parsed.duration ?? 0),
                            };
                            collectedSegments.push(seg);
                            onSegmentCb?.(seg);
                        }
                        break;
                    case "transcript.done":
                        aggregatedText = parsed.text;
                        aggregatedDuration = parsed.duration;
                        try {
                            ws.close();
                        } catch {
                            /* noop */
                        }
                        resolve({
                            text: aggregatedText,
                            duration: aggregatedDuration,
                            segments:
                                wordsToSegments(parsed.words) ??
                                (collectedSegments.length > 0 ? collectedSegments : undefined),
                        });
                        break;
                    case "error":
                        fail(new Error(`xAI STT stream error: ${parsed.message}`));
                        break;
                }
            });
        });
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
        const apiKey = readApiKey();
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

        const response = await fetch(`${BASE_URL}/tts`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: SafeJSON.stringify(body),
        });

        if (!response.ok) {
            const errBody = await response.text().catch(() => "");
            throw new Error(`xAI TTS failed: ${response.status} ${response.statusText} — ${errBody.slice(0, 500)}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const contentType = response.headers.get("content-type") ?? pickContentType(format);

        return {
            audio: Buffer.from(arrayBuffer),
            contentType,
        };
    }

    async synthesizeStream(text: string, options?: TTSOptions): Promise<TTSResult> {
        const apiKey = readApiKey();
        const format = options?.format ?? "mp3";

        const params = new URLSearchParams({
            language: options?.language ?? "auto",
            voice: options?.voice ?? "eve",
            codec: format,
            optimize_streaming_latency: "1",
        });

        if (options?.textNormalization) {
            params.set("text_normalization", "true");
        }

        const url = `${WS_BASE_URL}/tts?${params.toString()}`;

        return new Promise<TTSResult>((resolve, reject) => {
            const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } } as never);
            const audioChunks: Buffer[] = [];
            let opened = false;

            const fail = (err: Error): void => {
                try {
                    ws.close();
                } catch {
                    /* noop */
                }
                reject(err);
            };

            ws.addEventListener("open", () => {
                opened = true;

                for (let i = 0; i < text.length; i += MAX_TTS_DELTA_CHARS) {
                    const chunk = text.slice(i, i + MAX_TTS_DELTA_CHARS);
                    ws.send(SafeJSON.stringify({ type: "text.delta", delta: chunk }));
                }

                ws.send(SafeJSON.stringify({ type: "text.done" }));
            });

            ws.addEventListener("error", () => fail(new Error("xAI TTS WebSocket error")));

            ws.addEventListener("close", (ev) => {
                if (!opened) {
                    fail(new Error(`xAI TTS WebSocket closed before open (code ${ev.code})`));
                }
            });

            ws.addEventListener("message", (event) => {
                let parsed: XAIWsTtsEvent;

                try {
                    parsed = SafeJSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
                } catch (err) {
                    logger.debug(`xAI TTS: malformed event: ${err}`);
                    return;
                }

                switch (parsed.type) {
                    case "audio.delta":
                        audioChunks.push(Buffer.from(parsed.delta, "base64"));
                        break;
                    case "audio.done":
                        try {
                            ws.close();
                        } catch {
                            /* noop */
                        }
                        resolve({
                            audio: Buffer.concat(audioChunks),
                            contentType: pickContentType(format),
                        });
                        break;
                    case "error":
                        fail(new Error(`xAI TTS stream error: ${parsed.message}`));
                        break;
                }
            });
        });
    }

    async listVoices(): Promise<TTSVoice[]> {
        if (this.forceFreshVoices) {
            return this.fetchVoices();
        }

        return this.storage.getFileOrPut(VOICE_CACHE_KEY, () => this.fetchVoices(), VOICE_CACHE_TTL);
    }

    private async fetchVoices(): Promise<TTSVoice[]> {
        const apiKey = readApiKey();

        const response = await fetch(`${BASE_URL}/tts/voices`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });

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

async function streamPcmFrames(ws: WebSocket, pcm: Buffer, frameBytes: number): Promise<void> {
    for (let offset = 0; offset < pcm.length; offset += frameBytes) {
        const frame = pcm.subarray(offset, Math.min(offset + frameBytes, pcm.length));

        if (ws.readyState !== WebSocket.OPEN) {
            return;
        }

        ws.send(new Uint8Array(frame));
        await new Promise((r) => setTimeout(r, 100));
    }

    if (ws.readyState === WebSocket.OPEN) {
        ws.send(SafeJSON.stringify({ type: "audio.done" }));
    }
}

function stripWavHeader(wav: Buffer): Buffer {
    if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
        return wav;
    }

    let offset = 12;

    while (offset + 8 <= wav.length) {
        const chunkId = wav.toString("ascii", offset, offset + 4);
        const chunkSize = wav.readUInt32LE(offset + 4);
        const dataStart = offset + 8;

        if (chunkId === "data") {
            return wav.subarray(dataStart, dataStart + chunkSize);
        }

        offset = dataStart + chunkSize;
    }

    return wav;
}
