import type { AITask, AITextToSpeechProvider, TTSOptions, TTSResult, TTSVoice } from "@genesiscz/utils/ai/types";
import { rateLimitAwareDelay, retry } from "@genesiscz/utils/async";
import type { AIProviderType } from "@genesiscz/utils/config/ai.types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import { shouldRetrySynthesize } from "../synthesize-retry";
import { ElevenLabsClient } from "./ElevenLabsClient";

/** ElevenLabs' flagship multilingual voice model, and the API's own default. */
export const ELEVENLABS_DEFAULT_MODEL_ID = "eleven_multilingual_v2";

const VOICE_CACHE_KEY = "elevenlabs-voices.json";
const VOICE_CACHE_TTL = "7 days";
const MP3_OUTPUT_FORMAT = "mp3_44100_128";
/**
 * 24 kHz rather than 44.1 kHz: `wav_44100` and `pcm_44100` are gated behind the
 * Pro subscription tier, so a free or Creator key asking for `--format wav` would
 * get a 401 that reads like a broken credential.
 */
const WAV_OUTPUT_FORMAT = "wav_24000";

const SUPPORTED_TASKS: ReadonlySet<AITask> = new Set(["tts"]);
const SYNTHESIZE_RETRY_DELAY = rateLimitAwareDelay();

interface ElevenLabsVoiceListResponse {
    voices?: Array<{
        voice_id: string;
        name?: string;
        description?: string;
        labels?: Record<string, string>;
    }>;
}

/** Voice settings the API accepts per request, overriding the voice's stored ones. */
export interface ElevenLabsVoiceSettings {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
    speed?: number;
}

export interface AIElevenLabsTextToSpeechProviderOptions {
    /** Resolved by the plugin binding from the account's credential. Omit to resolve lazily. */
    apiKey?: string;
    /** Overrides `eleven_multilingual_v2`. */
    modelId?: string;
    voiceSettings?: ElevenLabsVoiceSettings;
    /** Bypass the 7-day voice list cache (used by tests). */
    forceFreshVoices?: boolean;
}

function pickContentType(format?: TTSOptions["format"]): string {
    if (format === "wav") {
        return "audio/wav";
    }

    return "audio/mpeg";
}

function outputFormatFor(format?: TTSOptions["format"]): string {
    if (format === "wav") {
        return WAV_OUTPUT_FORMAT;
    }

    return MP3_OUTPUT_FORMAT;
}

async function readErrorBody(response: Response): Promise<string> {
    try {
        const body = await response.text();
        return body.slice(0, 500);
    } catch (err) {
        logger.debug({ err, status: response.status }, "could not read the ElevenLabs error body");
        return "";
    }
}

export class AIElevenLabsTextToSpeechProvider implements AITextToSpeechProvider {
    readonly type: AIProviderType = "elevenlabs";
    /**
     * 🛑 UNMEASURED, deliberately 0 — do not copy xAI's 7 dB here on the
     * assumption that "cloud TTS is quieter".
     *
     * The xAI value came from `ffmpeg volumedetect` over several seconds of
     * speech rendered by both engines (providers/xai/AIXAITextToSpeechProvider.ts:51).
     * The ElevenLabs key on this machine (2026-09-18) carries a hard quota of 10
     * credits at roughly one credit per character, so the longest sample it can
     * buy is under a second — one or two phonemes, whose mean dB says more about
     * which vowel was spoken than about mastering level. A number derived from
     * that would look measured and be noise.
     *
     * 0 means playback applies no gain, so the voice is quieter than macOS `say`
     * at the same `--volume` rather than potentially clipped. To fix it: render
     * ~10 s through both engines, run `ffmpeg -i <file> -af volumedetect -f null -`
     * on each, and set this to the mean_volume delta.
     */
    readonly loudnessOffsetDb = 0;
    private readonly client: ElevenLabsClient;
    private readonly modelId: string;
    private readonly voiceSettings?: ElevenLabsVoiceSettings;
    /**
     * The voice list is a 7-day presentation cache, not configuration, so it goes
     * beside the other `say` caches and never near the credential config.
     */
    private readonly storage = new Storage("say");
    private readonly forceFreshVoices: boolean;

    constructor(options?: AIElevenLabsTextToSpeechProviderOptions) {
        this.client = new ElevenLabsClient(options?.apiKey);
        this.modelId = options?.modelId ?? ELEVENLABS_DEFAULT_MODEL_ID;
        this.voiceSettings = options?.voiceSettings;
        this.forceFreshVoices = options?.forceFreshVoices ?? false;
    }

    async isAvailable(): Promise<boolean> {
        return this.client.isConfigured();
    }

    supports(task: AITask): boolean {
        return SUPPORTED_TASKS.has(task);
    }

    async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
        return retry(() => this.synthesizeOnce(text, options), {
            maxAttempts: 3,
            getDelay: SYNTHESIZE_RETRY_DELAY,
            shouldRetry: (error: unknown) => shouldRetrySynthesize(error, [422]),
        });
    }

    /**
     * ElevenLabs streams over chunked HTTP on a `/stream` sibling of the REST
     * endpoint, not over a WebSocket: unlike xAI there is no length limit to work
     * around, so streaming here buys first-audio latency and nothing else.
     */
    synthesizeStream(text: string, options?: TTSOptions): { audio: AsyncIterable<Uint8Array>; contentType: string } {
        const contentType = pickContentType(options?.format);
        const request = this.postSpeech({ text, options, stream: true });

        const audio = (async function* iterate(): AsyncIterable<Uint8Array> {
            const response = await request;
            const body = response.body;

            if (!body) {
                throw new Error("ElevenLabs TTS stream returned no response body");
            }

            const reader = body.getReader();

            try {
                while (true) {
                    const { done, value } = await reader.read();

                    if (done) {
                        return;
                    }

                    if (value) {
                        yield value;
                    }
                }
            } finally {
                reader.releaseLock();
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

    private async synthesizeOnce(text: string, options?: TTSOptions): Promise<TTSResult> {
        const response = await this.postSpeech({ text, options, stream: false });
        const arrayBuffer = await response.arrayBuffer();
        const contentType = response.headers.get("content-type") ?? pickContentType(options?.format);
        return { audio: Buffer.from(arrayBuffer), contentType };
    }

    private async postSpeech(args: { text: string; options?: TTSOptions; stream: boolean }): Promise<Response> {
        const { text, options, stream } = args;
        const voiceId = await this.resolveVoiceId(options?.voice);
        const query = new URLSearchParams({ output_format: outputFormatFor(options?.format) });
        const body: Record<string, unknown> = { text, model_id: this.modelId };

        // `eleven_multilingual_v2` documents `language_code` as unsupported and
        // ignores it. Sending it anyway would look like a working `--language`
        // flag while changing nothing, so the field goes only to models that read it.
        if (options?.language && options.language !== "auto" && this.modelId !== ELEVENLABS_DEFAULT_MODEL_ID) {
            body.language_code = options.language;
        }

        if (options?.textNormalization) {
            body.apply_text_normalization = "on";
        }

        if (this.voiceSettings) {
            body.voice_settings = this.voiceSettings;
        }

        const path = `/v1/text-to-speech/${encodeURIComponent(voiceId)}${stream ? "/stream" : ""}`;
        logger.debug({ voiceId, model: this.modelId, stream, chars: text.length }, "ElevenLabs TTS request");

        const response = await this.client.fetch(`${path}?${query.toString()}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify(body),
        });

        if (!response.ok) {
            const errBody = await readErrorBody(response);
            throw new Error(`ElevenLabs TTS failed: ${response.status} ${response.statusText} — ${errBody}`);
        }

        return response;
    }

    /**
     * ElevenLabs has no account-independent default voice — the id is part of the
     * URL — so an unset `--voice` means "the first voice this key can see", read
     * from the same 7-day cache the `voices` listing uses.
     */
    private async resolveVoiceId(voice?: string): Promise<string> {
        if (voice) {
            return voice;
        }

        const voices = await this.listVoices();
        const first = voices[0];

        if (!first) {
            throw new Error(
                "ElevenLabs returned no voices for this account, so there is no default voice. " +
                    "Pass one with: tools say <text> --provider elevenlabs --voice <voice_id>"
            );
        }

        logger.debug({ voiceId: first.id, name: first.name }, "ElevenLabs default voice");
        return first.id;
    }

    private async fetchVoices(): Promise<TTSVoice[]> {
        const response = await this.client.fetch("/v1/voices");

        if (!response.ok) {
            const errBody = await readErrorBody(response);
            throw new Error(`ElevenLabs list voices failed: ${response.status} ${response.statusText} — ${errBody}`);
        }

        const data = (await response.json()) as ElevenLabsVoiceListResponse;

        return (data.voices ?? []).map((voice) => ({
            id: voice.voice_id,
            name: voice.name ?? voice.voice_id,
            description: voice.description ?? voice.labels?.description,
            locale: voice.labels?.language,
        }));
    }
}
