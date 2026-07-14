import { loadCatalogFile } from "@app/ai-proxy/lib/catalog-file";
import { resolveCopilotModelRecords } from "@app/ai-proxy/lib/copilot-models-cache";
import { resolveOpenAiSubToken } from "@app/ai-proxy/lib/providers/openai-sub-token";
import { providerKey } from "@app/ai-proxy/lib/providers/registry";
import { resolveXaiApiKey, XAI_API_BASE_URL } from "@app/ai-proxy/lib/providers/xai-api-key-auth";
import type { AiProxyAccountConfig, ProxyModelMeta } from "@app/ai-proxy/lib/types";
import { logger } from "@app/logger";
import {
    ANTHROPIC_SUB_ALIASES,
    ANTHROPIC_SUB_STATIC_CATALOG,
    type AnthropicSubModelRecord,
    inferAnthropicContextWindow,
    resolveAnthropicSubModel,
    tryFetchAnthropicSubModels,
} from "@app/utils/ai/anthropic/models";
import { toProxyId as toCopilotProxyId } from "@app/utils/ai/github-copilot/models";
import { COPILOT_INDIVIDUAL_API } from "@app/utils/ai/github-copilot/paths";
import type { CopilotModelRecord } from "@app/utils/ai/github-copilot/types";
import type { GrokModelRecord } from "@app/utils/ai/grok";
import { GROK_STATIC_CATALOG, inferModelSpeed, inferModelThinking, toProxyId } from "@app/utils/ai/grok";
import { WHAM_BASE_URL } from "@app/utils/ai/openai/codex-auth";
import { OPENAI_SUB_STATIC_CATALOG, tryFetchWhamModels, type WhamModelRecord } from "@app/utils/ai/openai/sub-models";
import { resolveAccountToken } from "@app/utils/claude/subscription-auth";
import { SafeJSON } from "@app/utils/json";
import { fetchDirect } from "@app/utils/net/fetch-direct";
import { isObject } from "@app/utils/object";

export function buildGrokModelDescription(meta: {
    visibility: string;
    speed: string;
    thinking: string;
    contextWindow?: number;
    agentType?: string;
    probeStatus?: string;
}): string {
    return SafeJSON.stringify({
        visibility: meta.visibility,
        speed: meta.speed,
        thinking: meta.thinking,
        contextWindow: meta.contextWindow,
        agentType: meta.agentType,
        probeStatus: meta.probeStatus,
    });
}

export function grokRecordToProxyMeta(
    account: AiProxyAccountConfig,
    record: GrokModelRecord,
    baseUrl: string
): ProxyModelMeta {
    const proxyId = toProxyId(account.name, account.providerSlug, record.id);

    return {
        proxyId,
        accountName: account.name,
        providerSlug: account.providerSlug,
        upstreamId: record.id,
        provider: account.provider,
        baseUrl,
        visibility: record.visibility,
        speed: record.speed,
        thinking: record.thinking,
        contextWindow: record.context_window,
        agentType: record.agent_type,
        apiBackend: record.api_backend,
        supportsTools: true,
        billingPlane: "subscription",
        source: record.source,
        probeStatus: record.probeStatus,
        description:
            record.description ??
            buildGrokModelDescription({
                visibility: record.visibility,
                speed: record.speed,
                thinking: record.thinking,
                contextWindow: record.context_window,
                agentType: record.agent_type,
                probeStatus: record.probeStatus,
            }),
        object: "model",
        created: 1_740_960_000,
        owned_by: providerKey(account),
    };
}

export function copilotRecordToProxyMeta(
    account: AiProxyAccountConfig,
    record: CopilotModelRecord,
    baseUrl: string
): ProxyModelMeta {
    const proxyId = toCopilotProxyId(account.name, record.id);
    const contextWindow = record.capabilities?.limits?.max_context_window_tokens;

    return {
        proxyId,
        accountName: account.name,
        providerSlug: account.providerSlug,
        upstreamId: record.id,
        provider: account.provider,
        baseUrl,
        visibility: record.preview ? "low" : "high",
        speed: "medium",
        thinking: /thinking|reason/i.test(record.id) ? "reasoning" : "none",
        contextWindow,
        supportsTools: record.capabilities?.supports?.tool_calls ?? true,
        billingPlane: "subscription",
        source: record.source === "live" ? "api-catalog" : "static",
        description: record.description ?? record.name ?? record.id,
        object: "model",
        created: 1_740_960_000,
        owned_by: providerKey(account),
    };
}

/**
 * Grok models advertised to clients. Never lists probeStatus=fail — dead ids
 * stay out of the picker (they may still be re-probed via update-models).
 * Prefers live models-catalog.json when present for this account.
 */
export function listGrokProxyModels(account: AiProxyAccountConfig, baseUrl: string): ProxyModelMeta[] {
    const records = loadGrokCatalogRecords(account) ?? GROK_STATIC_CATALOG;

    return records
        .filter((record) => record.probeStatus !== "fail")
        .map((record) => grokRecordToProxyMeta(account, record, baseUrl));
}

function loadGrokCatalogRecords(account: AiProxyAccountConfig): GrokModelRecord[] | null {
    const catalog = loadCatalogFile();
    const entry = catalog?.accounts.find(
        (item) => item.accountName === account.name && item.provider === "grok-subscription"
    );

    if (!entry) {
        return null;
    }

    const picker = Array.isArray(entry.pickerModels) ? (entry.pickerModels as GrokModelRecord[]) : [];
    const probed = Array.isArray(entry.probedModels) ? (entry.probedModels as GrokModelRecord[]) : [];
    const merged = [...picker, ...probed].filter(
        (record): record is GrokModelRecord =>
            Boolean(record) && typeof record === "object" && typeof record.id === "string"
    );

    if (merged.length === 0) {
        return null;
    }

    const byId = new Map<string, GrokModelRecord>();

    for (const record of merged) {
        byId.set(record.id, record);
    }

    return [...byId.values()];
}

export const ANTHROPIC_MESSAGES_BASE_URL = "https://api.anthropic.com/v1";

/**
 * Claude subscription catalog for the proxy model list.
 *
 * Prefers live GET api.anthropic.com/v1/models (same as accounts test). That is
 * availability for Claude — not a per-id chat "probe" like Grok. On failure,
 * falls back to the static catalog with probeStatus=skip.
 */
export async function listAnthropicSubProxyModels(account: AiProxyAccountConfig): Promise<ProxyModelMeta[]> {
    let records: AnthropicSubModelRecord[] = ANTHROPIC_SUB_STATIC_CATALOG;
    let source: ProxyModelMeta["source"] = "static";
    let probeStatus: ProxyModelMeta["probeStatus"] = "skipped";

    try {
        const billingName = account.anthropicSub?.accountName ?? account.name;
        const { token } = await resolveAccountToken(billingName);
        const live = await tryFetchAnthropicSubModels(token);

        if (live && live.length > 0) {
            records = live;
            source = "api-catalog";
            probeStatus = "ok";
        } else {
            logger.debug({ account: account.name }, "ai-proxy: anthropic catalog static fallback");
        }
    } catch (err) {
        logger.debug({ err, account: account.name }, "ai-proxy: anthropic catalog auth/list failed — static fallback");
    }

    const shared = (upstreamId: string) => ({
        proxyId: toProxyId(account.name, account.providerSlug, upstreamId),
        accountName: account.name,
        providerSlug: account.providerSlug,
        upstreamId,
        provider: account.provider,
        baseUrl: ANTHROPIC_MESSAGES_BASE_URL,
        visibility: "high" as const,
        speed: "medium" as const,
        supportsTools: true,
        billingPlane: "subscription" as const,
        source,
        probeStatus,
        object: "model" as const,
        created: 1_740_960_000,
        owned_by: providerKey(account),
    });

    // Short aliases always advertised; they resolve to the current family head.
    const aliases: ProxyModelMeta[] = ANTHROPIC_SUB_ALIASES.map((alias) => {
        const concrete = resolveAnthropicSubModel(alias);

        return {
            ...shared(alias),
            thinking: (alias === "haiku" ? "none" : "reasoning") as ProxyModelMeta["thinking"],
            contextWindow: inferAnthropicContextWindow(concrete),
            description: `Claude ${alias} via subscription (${concrete})`,
        };
    });

    const concrete: ProxyModelMeta[] = records.map((record) => ({
        ...shared(record.id),
        thinking: record.thinking,
        contextWindow: record.contextWindow,
        description: `${record.displayName} via subscription`,
    }));

    return [...aliases, ...concrete];
}

export const WHAM_RESPONSES_BASE_URL = WHAM_BASE_URL;

/**
 * Codex/ChatGPT catalog. Prefers live WHAM GET /models (plan-filtered).
 * That is the availability signal for Codex — not a chat probe.
 */
export async function listOpenAiSubProxyModels(account: AiProxyAccountConfig): Promise<ProxyModelMeta[]> {
    let records: WhamModelRecord[] = OPENAI_SUB_STATIC_CATALOG.filter((record) => record.visibility === "list");
    let source: ProxyModelMeta["source"] = "static";
    let probeStatus: ProxyModelMeta["probeStatus"] = "skipped";

    try {
        const { token, accountId } = await resolveOpenAiSubToken(account);
        const live = await tryFetchWhamModels(token, accountId);

        if (live && live.length > 0) {
            records = live.filter((record) => record.visibility === "list");
            source = "api-catalog";
            probeStatus = "ok";
        } else {
            logger.debug({ account: account.name }, "ai-proxy: codex catalog static fallback");
        }
    } catch (err) {
        logger.debug({ err, account: account.name }, "ai-proxy: codex catalog auth/list failed — static fallback");
    }

    return records.map((record) => ({
        proxyId: toProxyId(account.name, account.providerSlug, record.slug),
        accountName: account.name,
        providerSlug: account.providerSlug,
        upstreamId: record.slug,
        provider: account.provider,
        baseUrl: WHAM_RESPONSES_BASE_URL,
        visibility: "high" as const,
        speed: "medium" as const,
        thinking: "reasoning" as const,
        contextWindow: record.contextWindow,
        supportsTools: true,
        billingPlane: "subscription" as const,
        source,
        probeStatus,
        description: `${record.displayName} via ChatGPT/Codex subscription`,
        object: "model" as const,
        created: 1_740_960_000,
        owned_by: providerKey(account),
    }));
}

function catalogCopilotRecords(account: AiProxyAccountConfig): CopilotModelRecord[] {
    const catalog = loadCatalogFile();
    const accountCatalog = catalog?.accounts.find(
        (entry) => entry.accountName === account.name && entry.provider === "github-copilot-subscription"
    );

    const pickerModels = Array.isArray(accountCatalog?.pickerModels)
        ? (accountCatalog.pickerModels as CopilotModelRecord[])
        : [];
    const probedModels = Array.isArray(accountCatalog?.probedModels)
        ? (accountCatalog.probedModels as CopilotModelRecord[])
        : [];

    return [...pickerModels, ...probedModels];
}

function dedupeCopilotProxyModels(models: ProxyModelMeta[]): ProxyModelMeta[] {
    const seen = new Set<string>();

    return models.filter((model) => {
        if (seen.has(model.proxyId)) {
            return false;
        }

        seen.add(model.proxyId);
        return true;
    });
}

export async function listCopilotProxyModels(
    account: AiProxyAccountConfig,
    baseUrl?: string
): Promise<ProxyModelMeta[]> {
    const resolvedBaseUrl = baseUrl ?? account.baseUrl ?? COPILOT_INDIVIDUAL_API;

    const live = await resolveCopilotModelRecords(account);
    const records = live.length > 0 ? live : catalogCopilotRecords(account);

    return dedupeCopilotProxyModels(
        records.map((record) => copilotRecordToProxyMeta(account, record, resolvedBaseUrl))
    );
}

/** Fallback when GET /models fails or key is missing — chat models only. */
export const XAI_STATIC_CHAT_MODELS: Array<{ id: string; contextWindow: number }> = [
    { id: "grok-4.5", contextWindow: 500_000 },
    { id: "grok-4.3", contextWindow: 1_000_000 },
    { id: "grok-4.20-0309-reasoning", contextWindow: 1_000_000 },
    { id: "grok-4.20-0309-non-reasoning", contextWindow: 1_000_000 },
    { id: "grok-4.20-multi-agent-0309", contextWindow: 1_000_000 },
    { id: "grok-build-0.1", contextWindow: 256_000 },
];

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
        contextWindow: record.contextWindow,
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

function listXaiStaticProxyModels(account: AiProxyAccountConfig, baseUrl: string): ProxyModelMeta[] {
    return XAI_STATIC_CHAT_MODELS.map((record) =>
        xaiRecordToProxyMeta(
            account,
            {
                id: record.id,
                contextWindow: record.contextWindow,
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
    const apiKey = resolveXaiApiKey(account);

    if (!apiKey) {
        logger.debug({ account: account.name }, "ai-proxy: xai catalog using static fallback (no API key)");
        return listXaiStaticProxyModels(account, baseUrl);
    }

    try {
        const response = await fetchDirect(`${baseUrl}/models`, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
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
            .filter(isChatXaiModel);

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
