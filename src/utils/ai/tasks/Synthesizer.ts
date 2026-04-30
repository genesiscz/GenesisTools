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
    /**
     * Normalized rate on a 0..2 scale: 0 = slowest the provider produces intelligibly, 1 =
     * provider default cadence, 2 = fastest. Linearly interpolated to `say -r N` (80..175..350 wpm)
     * for macOS native, and to ffmpeg `atempo` (0.5..1.0..2.0, pitch-preserving) for cloud providers.
     * Values outside [0, 2] are clamped.
     */
    rate?: number;
    wait?: boolean;
    app?: string;
}

const MACOS_MIN_WPM = 80;
const MACOS_DEFAULT_WPM = 175;
const MACOS_MAX_WPM = 350;
/**
 * macOS `say -r` is heavily non-linear (engine clamps for intelligibility):
 *   -r 80  → 0.81× actual playback speed
 *   -r 128 → 0.90×
 *   -r 175 → 1.00× (default)
 *   -r 263 → 1.43×
 *   -r 350 → 1.86×
 * To make `--rate N` sound the same across providers, we clamp xAI atempo to the same delivered
 * range — so rate=0 plays at ~0.81× on both providers, rate=2 at ~1.86× on both.
 */
const ATEMPO_MIN = 0.81;
const ATEMPO_DEFAULT = 1;
const ATEMPO_MAX = 1.86;

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/**
 * Accept either 0..2 (multiplier) or 0..200 (percent). Anything > 2 is treated as percent and
 * divided by 100 — so `--rate 150` and `--rate 1.5` both mean "150% of default cadence".
 */
function normalizeRate(rate: number): number {
    const v = rate > 2 ? rate / 100 : rate;
    return Math.max(0, Math.min(2, v));
}

function rateToMacosWpm(rate: number): number {
    const r = normalizeRate(rate);

    if (r <= 1) {
        return Math.round(lerp(MACOS_MIN_WPM, MACOS_DEFAULT_WPM, r));
    }

    return Math.round(lerp(MACOS_DEFAULT_WPM, MACOS_MAX_WPM, r - 1));
}

function rateToAtempo(rate: number): number {
    const r = normalizeRate(rate);

    if (r <= 1) {
        return lerp(ATEMPO_MIN, ATEMPO_DEFAULT, r);
    }

    return lerp(ATEMPO_DEFAULT, ATEMPO_MAX, r - 1);
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
        const rate = options?.rate;
        const macRateWpm = rate != null ? rateToMacosWpm(rate) : undefined;
        const atempo = rate != null ? rateToAtempo(rate) : undefined;

        // 1. Native short-circuit — macOS provider has a speak() that avoids temp-file roundtrip.
        if (provider.speak) {
            await provider.speak(text, {
                ...ttsOpts,
                volume: options?.volume,
                rate: macRateWpm,
                wait: options?.wait,
            });
            return;
        }

        const wantStream = shouldStream(text, options);
        const gainDb = provider.loudnessOffsetDb;
        const tempo = atempo;

        // 2. Streaming → playStream.
        if (wantStream && provider.synthesizeStream) {
            const { audio, contentType } = provider.synthesizeStream(text, ttsOpts);
            await playStream(audio, contentType, {
                volume: options?.volume,
                gainDb,
                tempo,
                wait: options?.wait,
            });
            return;
        }

        // 3. Fallback: synthesize → playBuffer.
        const result = await provider.synthesize(text, ttsOpts);
        await playBuffer(result.audio, result.contentType, {
            volume: options?.volume,
            gainDb,
            tempo,
            wait: options?.wait,
        });
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
