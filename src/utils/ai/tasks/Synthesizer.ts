import logger from "@app/logger";
import { playBuffer, playStream } from "@app/utils/audio/playback";
import { isInteractive } from "@app/utils/cli/executor";
import type { AIProviderType } from "@app/utils/config/ai.types";
import { CLOUD_PROVIDER_TYPES } from "@app/utils/config/ai.types";
import { AIConfig } from "../AIConfig";
import { getProvidersForTask, getTextToSpeechProvider } from "../providers";
import type { AITextToSpeechProvider, TTSOptions, TTSResult, TTSVoice } from "../types";

export type ProviderSelector = AIProviderType | "local" | "cloud" | "any";

export interface VoicesByProvider {
    [providerType: string]: TTSVoice[];
}

export interface SynthesizerCreateOptions {
    provider?: ProviderSelector;
    persist?: boolean;
}

export interface SpeakOptions extends TTSOptions {
    provider?: ProviderSelector;
    model?: string;
    volume?: number;
    rate?: number;
    wait?: boolean;
    app?: string;
}

const REST_STREAM_THRESHOLD_CHARS = 80;

export class Synthesizer {
    private constructor(
        private provider: AITextToSpeechProvider,
        private readonly defaultSelector: ProviderSelector
    ) {}

    get providerType(): string {
        return this.provider.type;
    }

    static async create(options?: SynthesizerCreateOptions): Promise<Synthesizer> {
        const selector = options?.provider ?? "local";
        const provider = await resolveProvider(selector);

        if (options?.persist) {
            const config = await AIConfig.load();
            await config.setTask("tts", { provider: provider.type as AIProviderType });
        }

        return new Synthesizer(provider, selector);
    }

    async speak(text: string, options?: SpeakOptions): Promise<void> {
        const provider = await this.providerFor(options);
        const ttsOpts = toTTSOptions(options);

        // 1. Native short-circuit — macOS provider has a speak() that avoids temp-file roundtrip.
        if (provider.speak) {
            await provider.speak(text, {
                ...ttsOpts,
                volume: options?.volume,
                rate: options?.rate,
                wait: options?.wait,
            });
            return;
        }

        const wantStream = shouldStream(text, options);

        // 2. Streaming → playStream.
        if (wantStream && provider.synthesizeStream) {
            const { audio, contentType } = provider.synthesizeStream(text, ttsOpts);
            await playStream(audio, contentType, { volume: options?.volume, wait: options?.wait });
            return;
        }

        // 3. Fallback: synthesize → playBuffer.
        const result = await provider.synthesize(text, ttsOpts);
        await playBuffer(result.audio, result.contentType, { volume: options?.volume, wait: options?.wait });
    }

    async synthesize(text: string, options?: SpeakOptions): Promise<TTSResult> {
        const provider = await this.providerFor(options);
        const ttsOpts = toTTSOptions(options);
        return provider.synthesize(text, ttsOpts);
    }

    /**
     * List voices grouped by provider type. With opts.provider passed, returns
     * just that one group; otherwise iterates every available TTS provider.
     */
    async listVoices(opts?: { provider?: ProviderSelector }): Promise<VoicesByProvider> {
        const result: VoicesByProvider = {};

        if (opts?.provider) {
            const provider = await resolveProvider(opts.provider);
            result[provider.type] = provider.listVoices ? await provider.listVoices() : [];
            return result;
        }

        const candidates = getProvidersForTask("tts").filter(
            (p): p is AITextToSpeechProvider => typeof (p as AITextToSpeechProvider).synthesize === "function"
        );

        for (const provider of candidates) {
            if (!(await provider.isAvailable())) {
                continue;
            }

            try {
                if (provider.listVoices) {
                    result[provider.type] = await provider.listVoices();
                } else {
                    result[provider.type] = [];
                }
            } catch (err) {
                logger.debug(`listVoices(${provider.type}) failed: ${err}`);
                result[provider.type] = [];
            }
        }

        return result;
    }

    private async providerFor(options: SpeakOptions | undefined): Promise<AITextToSpeechProvider> {
        if (options?.provider && options.provider !== this.defaultSelector) {
            return resolveProvider(options.provider);
        }

        return this.provider;
    }
}

function toTTSOptions(options: SpeakOptions | undefined): TTSOptions {
    if (!options) {
        return {};
    }

    return {
        voice: options.voice,
        language: options.language,
        format: options.format,
        textNormalization: options.textNormalization,
        stream: options.stream,
    };
}

function shouldStream(text: string, options: SpeakOptions | undefined): boolean {
    if (options?.stream === true) {
        return true;
    }

    if (options?.stream === false) {
        return false;
    }

    return text.length > REST_STREAM_THRESHOLD_CHARS;
}

async function resolveProvider(selector: ProviderSelector): Promise<AITextToSpeechProvider> {
    if (selector === "any") {
        // Prefer local first, then cloud — iterate all TTS-capable providers in registration order.
        const localCandidates = getProvidersForTask("tts", { kind: "local" });
        const cloudCandidates = getProvidersForTask("tts", { kind: "cloud" });

        for (const p of [...localCandidates, ...cloudCandidates]) {
            if (await p.isAvailable()) {
                if (typeof (p as AITextToSpeechProvider).synthesize !== "function") {
                    continue;
                }

                return p as AITextToSpeechProvider;
            }
        }

        throw new Error('No TTS provider is available for selector "any".');
    }

    if (selector === "local" || selector === "cloud") {
        const candidates = getProvidersForTask("tts", { kind: selector });

        for (const p of candidates) {
            if (await p.isAvailable()) {
                if (typeof (p as AITextToSpeechProvider).synthesize !== "function") {
                    continue;
                }

                return p as AITextToSpeechProvider;
            }
        }

        throw new Error(`No ${selector} TTS provider is available.`);
    }

    // Specific type string.
    const provider = getTextToSpeechProvider(selector as AIProviderType);

    if (!(await provider.isAvailable())) {
        throw new Error(`Provider "${selector}" is not available (missing API key or not installed).`);
    }

    return provider;
}

// `isInteractive` import retained for upcoming CLI helpers; silence unused-warn for now.
void isInteractive;
// `CLOUD_PROVIDER_TYPES` retained for future cloud detection helpers.
void CLOUD_PROVIDER_TYPES;
