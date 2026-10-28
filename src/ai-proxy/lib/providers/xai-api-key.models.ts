import { assertApiKeySourceAllowed } from "@app/ai-proxy/lib/providers/api-key-guard";
import { defaultApiKeyEnvName } from "@app/ai-proxy/lib/providers/api-key-state";
import { providerKey } from "@app/ai-proxy/lib/providers/registry";
import { resolveXaiApiKey, XAI_API_BASE_URL } from "@app/ai-proxy/lib/providers/xai-api-key-auth";
import type { AiProxyAccountConfig, ProxyModelMeta } from "@app/ai-proxy/lib/types";
import { byProvider } from "@genesiscz/utils/ai/catalog";
import {
    grokModelSpecs,
    inferModelSpeed,
    inferModelThinking,
    isCuratedGrokModelId,
    toProxyId,
} from "@genesiscz/utils/ai/grok";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { fetchDirect } from "@genesiscz/utils/net/fetch-direct";
import { isObject } from "@genesiscz/utils/object";

interface XaiApiModelRecord {
    id: string;
    context_length?: number;
    completion_text_token_price?: number;
    object?: string;
    owned_by?: string;
}

function isChatXaiModel(record: XaiApiModelRecord): boolean {
    if (/imagine|image|video|tts|embedding|whisper|transcri/i.test(record.id)) {
        return false;
    }

    // Live catalog marks chat models with a completion price; media models omit it.
    if (record.completion_text_token_price == null && /imagine/i.test(record.id)) {
        return false;
    }

    return true;
}

function xaiRecordToProxyMeta(
    account: AiProxyAccountConfig,
    record: {
        id: string;
        contextWindow?: number;
        source: ProxyModelMeta["source"];
        probeStatus?: ProxyModelMeta["probeStatus"];
    },
    baseUrl: string
): ProxyModelMeta {
    return {
        proxyId: toProxyId(account.name, account.providerSlug, record.id),
        accountName: account.name,
        providerSlug: account.providerSlug,
        upstreamId: record.id,
        provider: account.provider,
        baseUrl,
        visibility: /grok-4\.5|grok-4\.3|grok-build/i.test(record.id) ? "high" : "medium",
        speed: inferModelSpeed(record.id),
        thinking: inferModelThinking(record.id),
        contextWindow: record.contextWindow ?? grokModelSpecs(record.id)?.contextWindow,
        inputModalities: grokModelSpecs(record.id)?.inputModalities,
        supportsTools: true,
        billingPlane: "api-key",
        source: record.source,
        probeStatus: record.probeStatus,
        description: `${record.id} via xAI API key`,
        object: "model",
        created: 1_740_960_000,
        owned_by: providerKey(account),
    };
}

/**
 * Fallback when GET /models fails or the key is missing — chat models only.
 *
 * The ids come from the shared catalog rather than a six-entry array that used
 * to live here and drifted from the catalog it duplicated. `isCuratedGrokModelId`
 * still decides what a client is offered; that curation is proxy policy, not a
 * fact about the model, so it stays here.
 */
export function listXaiStaticProxyModels(account: AiProxyAccountConfig, baseUrl: string): ProxyModelMeta[] {
    return byProvider("xai")
        .filter((entry) => isCuratedGrokModelId(entry.id))
        .map((entry) =>
            xaiRecordToProxyMeta(
                account,
                {
                    id: entry.id,
                    contextWindow: entry.contextWindow,
                    source: "static",
                    probeStatus: "skipped",
                },
                baseUrl
            )
        );
}

/**
 * Live xAI API catalog (GET /v1/models), chat models only.
 * Falls back to a small static list when the key is missing or the request fails.
 */
export async function listXaiProxyModels(account: AiProxyAccountConfig): Promise<ProxyModelMeta[]> {
    const baseUrl = (account.baseUrl ?? XAI_API_BASE_URL).replace(/\/$/, "");
    const resolved = resolveXaiApiKey(account);

    if (!resolved) {
        logger.debug({ account: account.name }, "ai-proxy: xai catalog using static fallback (no API key)");
        return listXaiStaticProxyModels(account, baseUrl);
    }

    // Building the catalog is still spending the key, so it walks through the
    // same guard as provider construction — otherwise an account without
    // `allowEnvApiKey` would burn an ambient XAI_API_KEY here anyway.
    try {
        assertApiKeySourceAllowed({ account, source: resolved.source, envName: defaultApiKeyEnvName(account) });
    } catch (err) {
        logger.warn(
            { err, account: account.name },
            "ai-proxy: xai catalog refused the ambient environment key — static fallback"
        );

        return listXaiStaticProxyModels(account, baseUrl);
    }

    try {
        const response = await fetchDirect(`${baseUrl}/models`, {
            headers: {
                Authorization: `Bearer ${resolved.key}`,
                Accept: "application/json",
            },
        });

        if (!response.ok) {
            logger.warn(
                { account: account.name, status: response.status },
                "ai-proxy: xai GET /models failed — static fallback"
            );
            return listXaiStaticProxyModels(account, baseUrl);
        }

        const payload = SafeJSON.parse(await response.text(), { strict: true });

        if (!isObject(payload) || !Array.isArray(payload.data)) {
            logger.warn({ account: account.name }, "ai-proxy: xai /models payload unexpected — static fallback");
            return listXaiStaticProxyModels(account, baseUrl);
        }

        const records = payload.data
            .filter((item): item is XaiApiModelRecord => isObject(item) && typeof item.id === "string")
            .filter(isChatXaiModel)
            .filter((record) => isCuratedGrokModelId(record.id));

        if (records.length === 0) {
            return listXaiStaticProxyModels(account, baseUrl);
        }

        return records.map((record) =>
            xaiRecordToProxyMeta(
                account,
                {
                    id: record.id,
                    contextWindow: typeof record.context_length === "number" ? record.context_length : undefined,
                    source: "api-catalog",
                    probeStatus: "ok",
                },
                baseUrl
            )
        );
    } catch (err) {
        logger.warn({ err, account: account.name }, "ai-proxy: xai GET /models threw — static fallback");
        return listXaiStaticProxyModels(account, baseUrl);
    }
}
