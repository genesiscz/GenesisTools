import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { resolveCredential } from "@genesiscz/utils/ai/providers/credentials";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { providerPlugin } from "@genesiscz/utils/ai/providers/registry";
import { logger } from "@genesiscz/utils/logger";
import { createFixtureStt } from "./fixture";
import { openDeepgramStt } from "./providers/deepgram";
import { openElevenLabsStt } from "./providers/elevenlabs";
import { openOpenAiRealtimeStt } from "./providers/openai-realtime";
import { openXaiRealtimeStt } from "./providers/xai-realtime";
import {
    type LiveSttSession,
    type OpenLiveSttOptions,
    type ProviderSessionOptions,
    STT_DEFAULT_SAMPLE_RATE_HZ,
    STT_PROVIDER_ALIASES,
    STT_PROVIDER_IDS,
    type SttProviderId,
} from "./types";

const { log } = logger.scoped("ai-stt");

type CloudProvider = Exclude<SttProviderId, "fixture">;

const OPENERS: Record<CloudProvider, (options: ProviderSessionOptions) => Promise<LiveSttSession>> = {
    deepgram: openDeepgramStt,
    openai: openOpenAiRealtimeStt,
    xai: openXaiRealtimeStt,
    elevenlabs: openElevenLabsStt,
};

export function parseSttProvider(value: unknown): SttProviderId {
    if (typeof value !== "string") {
        throw new Error(`Unknown STT provider '${String(value)}'. Valid: ${STT_PROVIDER_IDS.join("|")}`);
    }

    const normalised = STT_PROVIDER_ALIASES[value] ?? value;
    if ((STT_PROVIDER_IDS as readonly string[]).includes(normalised)) {
        return normalised as SttProviderId;
    }

    throw new Error(`Unknown STT provider '${value}'. Valid: ${STT_PROVIDER_IDS.join("|")}`);
}

/**
 * Account ladder: explicit `--account` (id or name, must belong to the provider), then the
 * provider's first enabled account. The `transcribe` task default is deliberately not consulted:
 * it steers `tools transcribe` (batch) and may point at a local Whisper model.
 */
export async function resolveSttAccount(options: { provider: CloudProvider; account?: string }): Promise<AccountEntry> {
    registerBuiltInPlugins();
    const store = await AiConfigStore.readOnly();
    if (options.account) {
        const account = store.account(options.account);
        if (!account) {
            throw new Error(`No AI account '${options.account}'. List them with: tools ai config account list`);
        }

        if (account.provider !== options.provider) {
            throw new Error(`Account '${options.account}' is a ${account.provider} account, not ${options.provider}.`);
        }

        return account;
    }

    const candidates = store.accounts({ provider: options.provider, enabled: true });
    const account = candidates[0];
    if (!account) {
        throw new Error(
            `Live STT provider '${options.provider}' has no enabled account. Add one with: ` +
                `tools ai config account add --provider ${options.provider} --name ${options.provider} ` +
                `--use-env ${providerPlugin(options.provider).credential.envKeys[0] ?? "<KEY_VAR>"}`
        );
    }

    if (candidates.length > 1) {
        log.debug(
            { provider: options.provider, chosen: account.id, others: candidates.slice(1).map((entry) => entry.id) },
            "several accounts match the STT provider; using the first enabled one"
        );
    }

    return account;
}

export async function openLiveStt(options: OpenLiveSttOptions): Promise<LiveSttSession> {
    const provider = parseSttProvider(options.provider);
    const sampleRateHz = options.sampleRateHz ?? STT_DEFAULT_SAMPLE_RATE_HZ;
    log.debug(
        { provider, account: options.account, model: options.model, sampleRateHz, languages: options.languages },
        "opening live STT"
    );
    options.signal?.throwIfAborted();

    if (provider === "fixture") {
        return createFixtureStt({ events: options.events ?? [], accountId: options.account, signal: options.signal });
    }

    const account = await resolveSttAccount({ provider, account: options.account });
    const plugin = providerPlugin(provider);
    const credential = await resolveCredential(account, plugin.credential);
    if (!credential.apiKey) {
        throw new Error(`Account '${account.name}' (${provider}) resolved no API key for live STT.`);
    }

    log.info(
        { provider, accountId: account.id, source: credential.source, envKey: credential.envKey, sampleRateHz },
        "live STT credential resolved"
    );

    return OPENERS[provider]({
        apiKey: credential.apiKey,
        accountId: account.id,
        sampleRateHz,
        model: options.model,
        languages: options.languages,
        signal: options.signal,
    });
}
