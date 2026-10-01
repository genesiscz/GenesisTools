import { resolve } from "node:path";
import { fetchXDurationSec } from "@app/transcribe/lib/acquire";
import type { ClassifiedSource } from "@app/transcribe/lib/drivers";
import { orderQuotes, runLabel } from "@app/transcribe/lib/price";
import { youtubeDurationSec } from "@app/transcribe/lib/youtube-source";
import { type QuoteChoice, quotesFor, type TranscriptionQuote } from "@genesiscz/utils/ai/catalog/speech";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { AICloudProvider } from "@genesiscz/utils/ai/providers/AICloudProvider";
import { getAllProviders } from "@genesiscz/utils/ai/providers/index.ts";
import { getAudioInfo } from "@genesiscz/utils/audio/probe";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("transcribe-quote");

const LOCAL_TRANSCRIBE_PROVIDERS = new Set(["local-hf", "darwinkit", "coreml"]);
/** A remote source that does not answer is a quote with no duration, never a hang. */
export const REMOTE_PROBE_TIMEOUT_MS = 20_000;

/** The provider a run would use: `--local` wins over `--provider`, exactly as a real transcription resolves it. */
export function effectiveProvider(opts: { provider?: string; local?: boolean }): string | undefined {
    return opts.local ? "local-hf" : opts.provider;
}

export interface QuoteRow extends TranscriptionQuote {
    available: boolean;
    run: string;
}

export interface PriceQuote {
    durationSec: number;
    via: string;
    quotes: QuoteRow[];
    /** Providers whose availability check failed, with the reason. */
    problems: string[];
}

/** The source's length, read without downloading the media and without writing anything. */
export async function durationForQuote(
    file: string,
    classified: ClassifiedSource
): Promise<{ seconds: number; via: string }> {
    if (classified.driver === "local") {
        const info = await getAudioInfo(resolve(file));

        if (!info.duration) {
            throw new Error(`Could not read a duration from ${file}.`);
        }

        return { seconds: info.duration, via: "the local file" };
    }

    if (classified.driver === "x") {
        return { seconds: await fetchXDurationSec(classified.statusId), via: "X post metadata" };
    }

    if (classified.driver === "youtube") {
        return {
            seconds: await youtubeDurationSec(classified.videoId, { timeoutMs: REMOTE_PROBE_TIMEOUT_MS }),
            via: "YouTube metadata",
        };
    }

    if (classified.driver === "direct") {
        const info = await getAudioInfo(classified.url, { timeoutMs: REMOTE_PROBE_TIMEOUT_MS });

        if (!info.duration) {
            throw new Error("Could not read a duration from the file header. --price-only does not download the file.");
        }

        return { seconds: info.duration, via: "the file header" };
    }

    throw new Error(classified.reason);
}

/**
 * The providers that could transcribe here, read-only: an enabled account from a read-only config
 * snapshot (no migration, no vault write), else an on-device or env-key check that never loads the store.
 */
export async function readyProviders(): Promise<{ ready: Set<string>; problems: string[] }> {
    const providers = getAllProviders().filter((provider) => provider.supports("transcribe"));
    const ready = new Set<string>();
    const problems: string[] = [];
    const configured = new Set(
        (await AiConfigStore.readOnly())
            .accounts()
            .filter((account) => account.enabled)
            .map((account) => account.provider)
    );

    for (const provider of providers) {
        if (configured.has(provider.type)) {
            ready.add(provider.type);
            continue;
        }

        const readOnlyCheck = LOCAL_TRANSCRIBE_PROVIDERS.has(provider.type) || provider instanceof AICloudProvider;

        if (!readOnlyCheck) {
            if (provider.type === "xai" && env.getXAIApiKey()) {
                ready.add(provider.type);
            }

            continue;
        }

        try {
            if (await provider.isAvailable()) {
                ready.add(provider.type);
            }
        } catch (error) {
            problems.push(`${provider.type}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    log.debug({ ready: [...ready], problems: problems.length }, "transcribe quote: ready providers");
    return { ready, problems };
}

/** Every provider's price for this source, ready ones first, with the row a real run would use marked. */
export async function priceQuote({
    file,
    classified,
    provider,
    local,
    model,
}: {
    file: string;
    classified: ClassifiedSource;
    provider?: string;
    local?: boolean;
    model?: string;
}): Promise<PriceQuote> {
    const timed = await durationForQuote(file, classified);
    const { ready, problems } = await readyProviders();
    const choice: QuoteChoice = { provider: effectiveProvider({ provider, local }), model };
    const quotes = orderQuotes(quotesFor(timed.seconds, choice), ready).map((quote) => ({
        ...quote,
        available: ready.has(quote.provider),
        run: runLabel(quote, choice),
    }));

    return { durationSec: timed.seconds, via: timed.via, quotes, problems };
}

/** Flags the YouTube pipeline cannot honour; it would drop them silently, so they are refused. */
export function unsupportedYoutubeFlags(opts: {
    model?: string;
    raw?: boolean;
    clean?: boolean;
    diarize?: boolean;
    speakers?: number;
}): string[] {
    const unsupported: string[] = [];

    if (opts.model) {
        unsupported.push("--model");
    }

    if (opts.raw || opts.clean === false) {
        unsupported.push("--raw/--no-clean");
    }

    if (opts.diarize) {
        unsupported.push("--diarize");
    }

    if (opts.speakers !== undefined) {
        unsupported.push("--speakers");
    }

    return unsupported;
}
