import { playBuffer, playStream } from "@genesiscz/utils/audio/playback";
import { isInteractive } from "@genesiscz/utils/cli/executor";
import type { AIProviderType } from "@genesiscz/utils/config/ai.types";
import { logger } from "@genesiscz/utils/logger";
import { AIConfig } from "../AIConfig";
import type { ModelRef } from "../core/model-ref";
import { registerBuiltInPlugins } from "../providers/plugins";
import { pluginsByCapability } from "../providers/registry";
import { speechEngineFor, speechEngineIds } from "../providers/speech-engines";
import type { AITextToSpeechProvider, TTSOptions, TTSResult, TTSVoice } from "../types";
import { resolveForTask } from "./resolve-task";

export type ProviderSelector = AIProviderType | "local" | "cloud" | "any";

export interface VoicesByProvider {
    [providerType: string]: TTSVoice[];
}

export interface SynthesizerCreateOptions {
    provider?: ProviderSelector;
    persist?: boolean;
    /** A ModelRef. Names a provider outright and switches the availability scan off. */
    model?: ModelRef;
    /** Tool name, for `defaults.app.<app>.tts`. */
    app?: string;
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

    /**
     * The default selector stays `"local"`, not `"macos"`: `say/lib/speak.ts`
     * passed `provider: "local"` before this phase, which means "the first
     * available local TTS provider" rather than one named engine. Hard-coding
     * macos here would look equivalent and quietly stop honouring anything else
     * that registers as a local speaker.
     */
    static async create(options?: SynthesizerCreateOptions): Promise<Synthesizer> {
        const selector = options?.provider ?? "local";
        const provider = await resolveProvider({ selector, model: options?.model, app: options?.app });

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
            const provider = await resolveProvider({ selector: opts.provider });
            result[provider.type] = provider.listVoices ? await provider.listVoices() : [];
            return result;
        }

        const candidates = speechPluginIds("any")
            .map((id) => speechEngineFor(id))
            .filter((engine): engine is AITextToSpeechProvider => engine !== undefined);

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
            return resolveProvider({ selector: options.provider });
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

/**
 * TTS-capable plugins, in the order the old `getProvidersForTask` returned them:
 * local kinds first, then the rest. The kind now comes from `plugin.kind` rather
 * than a `CLOUD_PROVIDER_TYPES` set, which is the same distinction spelled once
 * instead of twice.
 */
function speechPluginIds(kind: "local" | "cloud" | "any"): string[] {
    registerBuiltInPlugins();

    const plugins = pluginsByCapability("tts").filter((plugin) => speechEngineFor(plugin.id));
    const local = plugins.filter((plugin) => plugin.kind === "local").map((plugin) => plugin.id);
    const remote = plugins.filter((plugin) => plugin.kind !== "local").map((plugin) => plugin.id);

    if (kind === "local") {
        return local;
    }

    if (kind === "cloud") {
        return remote;
    }

    return [...local, ...remote];
}

async function firstAvailable(providerIds: string[]): Promise<AITextToSpeechProvider | undefined> {
    for (const id of providerIds) {
        const engine = speechEngineFor(id);

        if (engine && (await engine.isAvailable())) {
            return engine;
        }
    }

    return undefined;
}

/**
 * Which provider speaks, in one place.
 *
 * A ModelRef or an app name goes through the single resolution ladder (so
 * `defaults.app.say.tts` and `@account/...` refs both work); a bare kind hint
 * falls back to scanning the TTS-capable plugins, which is what makes `tools say`
 * work on a laptop with no AI config at all. A named provider is a decision and
 * fails loudly rather than degrading.
 */
async function resolveProvider(opts: {
    selector: ProviderSelector;
    model?: ModelRef;
    app?: string;
}): Promise<AITextToSpeechProvider> {
    const { selector } = opts;
    const { log } = logger.scoped("ai-tts");

    if (selector !== "any" && selector !== "local" && selector !== "cloud") {
        const engine = speechEngineFor(selector);

        if (!engine) {
            throw new Error(`Provider "${selector}" has no speech engine. Known: ${speechEngineIds().join(", ")}.`);
        }

        if (!(await engine.isAvailable())) {
            throw new Error(`Provider "${selector}" is not available (missing API key or not installed).`);
        }

        return engine;
    }

    if (opts.model || opts.app) {
        try {
            const resolved = await resolveForTask({
                task: "tts",
                model: opts.model,
                app: opts.app,
                needs: "speech",
            });
            // The binding is only consulted for WHO; the rich engine carries the
            // native speak/stream/loudness behaviour the SDK shape cannot.
            resolved.binding.dispose?.();
            const engine = speechEngineFor(resolved.plugin.id);

            if (engine && (await engine.isAvailable())) {
                return engine;
            }

            log.debug(
                { provider: resolved.plugin.id },
                "resolved TTS provider has no usable engine; falling back to the kind scan"
            );
        } catch (err) {
            if (opts.model) {
                throw err;
            }

            log.debug({ err, app: opts.app }, "no configured TTS default; falling back to the kind scan");
        }
    }

    const engine = await firstAvailable(speechPluginIds(selector));

    if (engine) {
        return engine;
    }

    throw new Error(
        selector === "any"
            ? 'No TTS provider is available for selector "any".'
            : `No ${selector} TTS provider is available.`
    );
}

// `isInteractive` import retained for upcoming CLI helpers; silence unused-warn for now.
void isInteractive;
