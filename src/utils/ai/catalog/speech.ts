import { speechDurationCostUsd } from "@genesiscz/utils/ai/llm-cost";

/**
 * Billable speech products, one row per model and mode.
 *
 * Token prices stay on `ModelPricing`. Speech is billed on audio duration, so
 * it does not belong in that shape or in the chat catalog (`ask` would offer
 * whisper as a model you can talk to).
 *
 * Duration rates are `input_cost_per_second` from the LiteLLM price file. That
 * file also sets Whisper's `output_cost_per_second` to the same number; adding
 * it would charge $0.012 a minute, and OpenAI's published rate is $0.006. xAI
 * is not in that file: REST batch is $0.10 per hour and streaming is $0.20,
 * for both grok-voice-transcribe-1.0 and 2.0
 * (https://docs.x.ai/developers/models/speech-to-text).
 *
 * Deepgram domain models (nova-2-finance, base-phonecall, …) are not listed.
 * They inherit the parent rate when named.
 */

export type SpeechMode = "batch" | "stream";

export interface SpeechOffer {
    provider: string;
    model: string;
    mode: SpeechMode;
    /** USD per second of audio. Null means there is no duration list price. */
    usdPerSecond: number | null;
    /** What a transcribe call uses for this provider when no model is named. */
    transcribeDefault?: boolean;
    note?: string;
}

const XAI_BATCH_PER_SECOND = 0.1 / 3600;
const XAI_STREAM_PER_SECOND = 0.2 / 3600;

export const SPEECH_OFFERS: readonly SpeechOffer[] = [
    {
        provider: "local-hf",
        model: "onnx-community/whisper-large-v3-turbo",
        mode: "batch",
        usdPerSecond: 0,
        transcribeDefault: true,
        note: "on this machine; other local whisper ids are also $0",
    },
    {
        provider: "xai",
        model: "grok-voice-transcribe-2.0",
        mode: "batch",
        usdPerSecond: XAI_BATCH_PER_SECOND,
        transcribeDefault: true,
        note: "REST /v1/stt. 1.0 is the same batch price",
    },
    {
        provider: "xai",
        model: "grok-voice-transcribe-1.0",
        mode: "batch",
        usdPerSecond: XAI_BATCH_PER_SECOND,
        note: "same batch price as 2.0",
    },
    {
        provider: "xai",
        model: "grok-voice-transcribe-2.0",
        mode: "stream",
        usdPerSecond: XAI_STREAM_PER_SECOND,
        note: "realtime path, not a batch transcribe",
    },
    {
        provider: "xai",
        model: "grok-voice-transcribe-1.0",
        mode: "stream",
        usdPerSecond: XAI_STREAM_PER_SECOND,
        note: "realtime path, same stream price as 2.0",
    },
    {
        provider: "groq",
        model: "distil-whisper-large-v3-en",
        mode: "batch",
        usdPerSecond: 5.56e-6,
        note: "English only",
    },
    {
        provider: "groq",
        model: "whisper-large-v3-turbo",
        mode: "batch",
        usdPerSecond: 1.111e-5,
    },
    {
        provider: "groq",
        model: "whisper-large-v3",
        mode: "batch",
        usdPerSecond: 3.083e-5,
        transcribeDefault: true,
    },
    {
        provider: "assemblyai",
        model: "best",
        mode: "batch",
        usdPerSecond: 3.333e-5,
        transcribeDefault: true,
    },
    {
        provider: "assemblyai",
        model: "nano",
        mode: "batch",
        usdPerSecond: 0.00010278,
    },
    {
        provider: "deepgram",
        model: "nova-3",
        mode: "batch",
        usdPerSecond: 7.167e-5,
        transcribeDefault: true,
        note: "list price, before prepaid credit. nova-3-general matches",
    },
    {
        provider: "deepgram",
        model: "nova-2",
        mode: "batch",
        usdPerSecond: 7.167e-5,
        note: "domain variants (finance, phonecall, …) match",
    },
    {
        provider: "deepgram",
        model: "nova-3-medical",
        mode: "batch",
        usdPerSecond: 8.667e-5,
    },
    {
        provider: "deepgram",
        model: "whisper-large",
        mode: "batch",
        usdPerSecond: 0.0001,
        note: "tiny, base, small, medium and large match",
    },
    {
        provider: "deepgram",
        model: "base",
        mode: "batch",
        usdPerSecond: 0.00020833,
        note: "domain variants match",
    },
    {
        provider: "deepgram",
        model: "enhanced",
        mode: "batch",
        usdPerSecond: 0.00024167,
        note: "domain variants match",
    },
    {
        provider: "elevenlabs",
        model: "scribe_v1",
        mode: "batch",
        usdPerSecond: 6.11e-5,
        note: "rate only; not wired as a transcribe provider",
    },
    {
        provider: "openai",
        model: "whisper-1",
        mode: "batch",
        usdPerSecond: 0.0001,
        transcribeDefault: true,
        note: "$0.006 per minute of audio",
    },
    {
        provider: "openai",
        model: "gpt-4o-mini-transcribe",
        mode: "batch",
        usdPerSecond: null,
        note: "no per-second rate in the price file",
    },
    {
        provider: "openai",
        model: "gpt-4o-transcribe",
        mode: "batch",
        usdPerSecond: null,
        note: "no per-second rate in the price file",
    },
    {
        provider: "openrouter",
        model: "openai/whisper-1",
        mode: "batch",
        usdPerSecond: null,
        transcribeDefault: true,
        note: "no speech rate in the price file",
    },
    {
        provider: "gladia",
        model: "default",
        mode: "batch",
        usdPerSecond: null,
        transcribeDefault: true,
        note: "no speech rate in the price file",
    },
    {
        provider: "cloud",
        model: "—",
        mode: "batch",
        usdPerSecond: null,
        transcribeDefault: true,
        note: "picks another provider when the call runs",
    },
];

/** Longer prefixes first so nova-3-medical does not inherit nova-3. */
const DEEPGRAM_FAMILIES: readonly { prefix: string; usdPerSecond: number }[] = [
    { prefix: "nova-3-medical", usdPerSecond: 8.667e-5 },
    { prefix: "nova-3", usdPerSecond: 7.167e-5 },
    { prefix: "nova-2", usdPerSecond: 7.167e-5 },
    { prefix: "nova", usdPerSecond: 7.167e-5 },
    { prefix: "enhanced", usdPerSecond: 0.00024167 },
    { prefix: "base", usdPerSecond: 0.00020833 },
    { prefix: "whisper", usdPerSecond: 0.0001 },
];

export interface TranscriptionQuote {
    provider: string;
    model: string;
    mode: SpeechMode;
    usdPerHour: number | null;
    usd: number | null;
    note: string;
    transcribeDefault: boolean;
}

export interface QuoteChoice {
    provider?: string;
    model?: string;
}

export function quoteTranscription(provider: string, durationSec: number): TranscriptionQuote {
    const offer =
        SPEECH_OFFERS.find((row) => row.provider === provider && row.transcribeDefault && row.mode === "batch") ??
        SPEECH_OFFERS.find((row) => row.provider === provider && row.mode === "batch");

    if (!offer) {
        return {
            provider,
            model: "—",
            mode: "batch",
            usdPerHour: null,
            usd: null,
            note: "no list price",
            transcribeDefault: false,
        };
    }

    return priceOffer(offer, durationSec);
}

/** Every listed product, plus one extra row when a caller names a model outside the list. */
export function quotesFor(durationSec: number, choice?: QuoteChoice): TranscriptionQuote[] {
    const quotes = SPEECH_OFFERS.map((offer) => priceOffer(offer, durationSec));
    const model = choice?.model;
    const provider = choice?.provider;

    if (!provider || !model || quotes.some((quote) => speechModelMatches(quote, provider, model))) {
        return quotes;
    }

    const inherited = inheritOffer(provider, model);

    if (inherited) {
        quotes.push(priceOffer(inherited, durationSec));

        return quotes;
    }

    quotes.push({
        provider,
        model,
        mode: "batch",
        usdPerHour: null,
        usd: null,
        note: "no list price for this model",
        transcribeDefault: false,
    });

    return quotes;
}

export function speechModelMatches(
    quote: Pick<TranscriptionQuote, "provider" | "model" | "transcribeDefault">,
    provider: string,
    model: string
): boolean {
    if (quote.provider !== provider) {
        return false;
    }

    if (quote.model === model) {
        return true;
    }

    return model === "xai-stt" && provider === "xai" && quote.transcribeDefault;
}

function priceOffer(offer: SpeechOffer, durationSec: number): TranscriptionQuote {
    const perSecond = offer.usdPerSecond;

    return {
        provider: offer.provider,
        model: offer.model,
        mode: offer.mode,
        usdPerHour: speechDurationCostUsd(perSecond, 3600),
        usd: speechDurationCostUsd(perSecond, durationSec),
        note: offer.note ?? "",
        transcribeDefault: offer.transcribeDefault === true,
    };
}

function inheritOffer(provider: string, model: string): SpeechOffer | null {
    if (provider === "deepgram") {
        const family = DEEPGRAM_FAMILIES.find((row) => model === row.prefix || model.startsWith(`${row.prefix}-`));

        if (!family) {
            return null;
        }

        return {
            provider,
            model,
            mode: "batch",
            usdPerSecond: family.usdPerSecond,
            note: `same list price as ${family.prefix}`,
        };
    }

    if (provider === "xai" && model.startsWith("grok-voice-transcribe")) {
        return {
            provider,
            model,
            mode: "batch",
            usdPerSecond: XAI_BATCH_PER_SECOND,
            note: "assumes the published batch rate",
        };
    }

    return null;
}
