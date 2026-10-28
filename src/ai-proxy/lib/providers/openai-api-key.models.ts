import { OPENAI_API_BASE_URL, OpenAiApiKeyProvider } from "@app/ai-proxy/lib/providers/openai-api-key";
import { providerKey } from "@app/ai-proxy/lib/providers/registry";
import type { AiProxyAccountConfig, ProxyModelMeta } from "@app/ai-proxy/lib/types";
import { toProxyId } from "@genesiscz/utils/ai/grok";
import { logger } from "@genesiscz/utils/logger";

/**
 * OpenAI ids a chat client can actually call.
 *
 * `GET /v1/models` on the platform key returns everything the account can reach,
 * embeddings, moderation, TTS, transcription and image models included. Handing
 * that list to a chat client floods its picker with ids that 400 on
 * `/chat/completions`, so the catalog is narrowed to the chat families by prefix.
 */
// lint-rules-ignore: family prefixes that filter the live list (moved from model-meta.ts, a ratchet entry)
const OPENAI_CHAT_MODEL_PREFIXES = ["gpt-", "o1", "o3", "o4", "chatgpt-"];

/** Chat-shaped prefixes still carry non-chat products; these are excluded by name. */
const OPENAI_NON_CHAT_MARKERS = [
    "audio",
    "realtime",
    "transcribe",
    "tts",
    "image",
    "search",
    "embedding",
    "moderation",
    "dall-e",
];

function isOpenAiChatModelId(id: string): boolean {
    const lower = id.toLowerCase();

    if (!OPENAI_CHAT_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
        return false;
    }

    return !OPENAI_NON_CHAT_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * The OpenAI api-key catalog, from the provider's own live `GET /v1/models`.
 *
 * No static fallback, deliberately: this provider has been catalog-blind since it
 * was added (it exists mainly for the realtime voice tunnel), so there is no
 * curated OpenAI list in this repo to fall back TO. An empty result therefore
 * means "the key could not list models", which is the honest answer, and it is
 * what the account already reported before this branch existed.
 *
 * Model listing authenticates, so it goes through `createProvider` rather than
 * reaching for the key itself — that is where `assertApiKeySourceAllowed` lives.
 */
export async function listOpenAiProxyModels(account: AiProxyAccountConfig): Promise<ProxyModelMeta[]> {
    const baseUrl = (account.baseUrl ?? OPENAI_API_BASE_URL).replace(/\/$/, "");

    try {
        const provider = await OpenAiApiKeyProvider.create(account);
        const models = await provider.listModels();

        return models
            .map((model) => model.id.split("/").slice(2).join("/"))
            .filter((upstreamId) => upstreamId.length > 0 && isOpenAiChatModelId(upstreamId))
            .map((upstreamId) => ({
                proxyId: toProxyId(account.name, account.providerSlug, upstreamId),
                accountName: account.name,
                providerSlug: account.providerSlug,
                upstreamId,
                provider: account.provider,
                baseUrl,
                visibility: "medium" as const,
                speed: "medium" as const,
                // The list endpoint says nothing about reasoning, and this repo has
                // no curated OpenAI entries to read it from; "not stated" beats a
                // guess from the id.
                thinking: "none" as const,
                supportsTools: true,
                billingPlane: "api-key" as const,
                source: "api-catalog" as const,
                description: `${upstreamId} via the OpenAI platform key`,
                object: "model" as const,
                created: 1_740_960_000,
                owned_by: providerKey(account),
            }));
    } catch (err) {
        logger.warn({ err, account: account.name }, "ai-proxy: openai model listing failed — advertising no models");
        return [];
    }
}
