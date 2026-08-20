import { dirname } from "node:path";
import { resolveGrokAuthPath } from "@app/ai-proxy/lib/account-config";
import { loadCatalogFile } from "@app/ai-proxy/lib/catalog-file";
import { resolveCopilotModelRecords } from "@app/ai-proxy/lib/copilot-models-cache";
import { assertApiKeySourceAllowed } from "@app/ai-proxy/lib/providers/api-key-guard";
import { defaultApiKeyEnvName } from "@app/ai-proxy/lib/providers/api-key-state";
import { OPENAI_API_BASE_URL, OpenAiApiKeyProvider } from "@app/ai-proxy/lib/providers/openai-api-key";
import { resolveOpenAiSubToken } from "@app/ai-proxy/lib/providers/openai-sub-token";
import { OPENROUTER_API_BASE_URL } from "@app/ai-proxy/lib/providers/openrouter-api-key";
import { providerKey } from "@app/ai-proxy/lib/providers/registry";
import { resolveXaiApiKey, XAI_API_BASE_URL } from "@app/ai-proxy/lib/providers/xai-api-key-auth";
import type { AiProxyAccountConfig, ProxyModelMeta } from "@app/ai-proxy/lib/types";
import {
    ANTHROPIC_SUB_ALIASES,
    ANTHROPIC_SUB_STATIC_CATALOG,
    type AnthropicSubModelRecord,
    inferAnthropicContextWindow,
    resolveAnthropicSubModel,
    tryFetchAnthropicSubModels,
} from "@genesiscz/utils/ai/anthropic/models";
import {
    byProvider,
    DEFAULT_OPENROUTER_EXCLUDE,
    DEFAULT_OPENROUTER_INCLUDE,
    fetchOpenRouterCatalog,
    isDatedModelId,
    OPENROUTER_META_MODEL_IDS,
    type OpenRouterModelRecord,
} from "@genesiscz/utils/ai/catalog";
import { toProxyId as toCopilotProxyId } from "@genesiscz/utils/ai/github-copilot/models";
import { COPILOT_INDIVIDUAL_API } from "@genesiscz/utils/ai/github-copilot/paths";
import type { CopilotModelRecord } from "@genesiscz/utils/ai/github-copilot/types";
import type { GrokModelRecord } from "@genesiscz/utils/ai/grok";
import {
    GROK_STATIC_CATALOG,
    grokModelSpecs,
    inferModelSpeed,
    inferModelThinking,
    isCuratedGrokModelId,
    pickerCacheRecords,
    readModelsCache,
    toProxyId,
} from "@genesiscz/utils/ai/grok";
import { grokModelsCachePath } from "@genesiscz/utils/ai/grok/paths";
import { WHAM_BASE_URL } from "@genesiscz/utils/ai/openai/codex-auth";
import {
    OPENAI_SUB_BUILTIN_ALIAS_NAMES,
    OPENAI_SUB_STATIC_CATALOG,
    resolveOpenAiSubModel,
    tryFetchWhamModels,
    type WhamModelRecord,
} from "@genesiscz/utils/ai/openai/sub-models";
import { resolveAccountToken } from "@genesiscz/utils/claude/subscription-auth";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { fetchDirect } from "@genesiscz/utils/net/fetch-direct";
import { isObject } from "@genesiscz/utils/object";
import { matchGlob } from "@genesiscz/utils/string";

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
        contextWindow: record.context_window ?? grokModelSpecs(record.id)?.contextWindow,
        inputModalities: grokModelSpecs(record.id)?.inputModalities,
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
 *
 * Three sources, live first, so a model xAI ships tomorrow is offered WITHOUT a
 * repo edit: the grok CLI's own picker cache (it refreshes itself from
 * /v1/models), then this account's probe cache, then the curated static list.
 * Later sources only fill gaps — a live entry always wins, because it carries
 * the real context window and the static hints are guesses.
 */
export function listGrokProxyModels(account: AiProxyAccountConfig, baseUrl: string): ProxyModelMeta[] {
    // The picker cache lives next to the account's own auth file, and a live
    // entry outranks the static list — so an unattributable cache must not be
    // read at all, or it advertises models the selected credential cannot call.
    //
    // An `accountName`-backed account resolves its auth file through the AI
    // config, which is async and cannot be read from this sync listing path.
    // Abstaining costs live discovery for those accounts (static + this
    // account's own probe cache still apply); guessing would cost correctness.
    const live = account.grok?.accountName
        ? []
        : pickerCacheRecords(readModelsCache(grokModelsCachePath(dirname(resolveGrokAuthPath(account)))));

    if (account.grok?.accountName) {
        logger.debug(
            { account: account.name, grokAccount: account.grok.accountName },
            "ai-proxy: skipped the grok picker cache — an accountName-backed account's cache cannot be attributed here"
        );
    }
    const probed = loadGrokCatalogRecords(account) ?? [];

    const byId = new Map<string, GrokModelRecord>();

    for (const record of [...GROK_STATIC_CATALOG, ...probed, ...live]) {
        byId.set(record.id, { ...byId.get(record.id), ...record });
    }

    const records = [...byId.values()].filter(
        (record) => record.probeStatus !== "fail" && isCuratedGrokModelId(record.id)
    );

    return records.map((record) => grokRecordToProxyMeta(account, record, baseUrl));
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
        // Every current Claude model accepts text + images.
        inputModalities: ["text", "image"],
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

    const concrete: ProxyModelMeta[] = records
        .filter((record) => !isDatedModelId(record.id))
        .map((record) => ({
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

    const toMeta = (id: string, record: WhamModelRecord, description: string): ProxyModelMeta => ({
        proxyId: toProxyId(account.name, account.providerSlug, id),
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
        inputModalities: record.inputModalities,
        supportsParallelToolCalls: record.supportsParallelToolCalls,
        billingPlane: "subscription" as const,
        source,
        probeStatus,
        description,
        object: "model" as const,
        created: 1_740_960_000,
        owned_by: providerKey(account),
    });

    // Aliases (builtin + per-account config) advertised when they resolve to a
    // record on this plan's list.
    const aliasNames = [...OPENAI_SUB_BUILTIN_ALIAS_NAMES, ...Object.keys(account.openaiSub?.aliases ?? {})];
    const aliases: ProxyModelMeta[] = [];

    for (const alias of aliasNames) {
        const concrete = resolveOpenAiSubModel(alias, account.openaiSub?.aliases);
        const record = records.find((item) => item.slug === concrete);

        if (concrete === alias || !record) {
            continue;
        }

        aliases.push(toMeta(alias, record, `Codex ${alias} alias (${concrete})`));
    }

    return [
        ...aliases,
        ...records.map((record) => toMeta(record.slug, record, `${record.displayName} via ChatGPT/Codex subscription`)),
    ];
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

/**
 * Which OpenRouter ids this account advertises.
 *
 * `??` and not `||`: absent means "use the curated default", while an explicit
 * `[]` means "no filter at all". Collapsing the two would make `include: []`
 * silently mean the opposite of what it reads as.
 */
function openRouterFilters(account: AiProxyAccountConfig): { include: readonly string[]; exclude: readonly string[] } {
    const configured = account.openrouter?.models;
    const include = configured?.include ?? DEFAULT_OPENROUTER_INCLUDE;

    return {
        // An empty include list, like ["*"], means every model OpenRouter serves.
        include: include.length === 0 ? ["*"] : include,
        exclude: configured?.exclude ?? DEFAULT_OPENROUTER_EXCLUDE,
    };
}

function matchesAny(value: string, patterns: readonly string[]): boolean {
    return patterns.some((pattern) => matchGlob(value, pattern));
}

function openRouterRecordToProxyMeta(
    account: AiProxyAccountConfig,
    model: OpenRouterModelRecord,
    baseUrl: string
): ProxyModelMeta {
    const inputModalities = model.architecture?.input_modalities;
    const parameters = model.supported_parameters ?? [];

    return {
        proxyId: toProxyId(account.name, account.providerSlug, model.id),
        accountName: account.name,
        providerSlug: account.providerSlug,
        upstreamId: model.id,
        provider: account.provider,
        baseUrl,
        visibility: "medium",
        speed: "medium",
        // Real data, not inferred from the id: OpenRouter declares reasoning
        // support per model, and whether it is mandatory.
        thinking: model.reasoning ? (model.reasoning.mandatory ? "reasoning" : "optional") : "none",
        ...(typeof model.context_length === "number" ? { contextWindow: model.context_length } : {}),
        ...(inputModalities && inputModalities.length > 0 ? { inputModalities } : {}),
        supportsTools: parameters.includes("tools"),
        billingPlane: "api-key",
        source: "api-catalog",
        description: `${model.name ?? model.id} via OpenRouter`,
        object: "model",
        created: 1_740_960_000,
        owned_by: providerKey(account),
    };
}

/**
 * OpenRouter models advertised to clients, from the shared catalog module.
 *
 * ⚠️ No `assertApiKeySourceAllowed` here, deliberately, and not an oversight:
 * `/api/v1/models` is PUBLIC and this path spends no key, so guarding it would
 * only hide the catalog from an account whose key happens to come from the
 * environment. The xai equivalent needs the guard because it authenticates.
 */
export async function listOpenRouterProxyModels(account: AiProxyAccountConfig): Promise<ProxyModelMeta[]> {
    const baseUrl = (account.baseUrl ?? OPENROUTER_API_BASE_URL).replace(/\/$/, "");
    const catalog = await fetchOpenRouterCatalog();
    const { include, exclude } = openRouterFilters(account);

    if (!catalog) {
        logger.warn({ account: account.name }, "ai-proxy: openrouter catalog unavailable — advertising no models");
        return [];
    }

    const meta = new Set(OPENROUTER_META_MODEL_IDS);

    return (
        catalog.models
            // The five `-1`-priced router pseudo-models are always dropped: they are
            // not models, and they cannot be priced.
            .filter((model) => !meta.has(model.id))
            .filter((model) => matchesAny(model.id, include) && !matchesAny(model.id, exclude))
            .map((model) => openRouterRecordToProxyMeta(account, model, baseUrl))
    );
}

/**
 * OpenAI ids a chat client can actually call.
 *
 * `GET /v1/models` on the platform key returns everything the account can reach,
 * embeddings, moderation, TTS, transcription and image models included. Handing
 * that list to a chat client floods its picker with ids that 400 on
 * `/chat/completions`, so the catalog is narrowed to the chat families by prefix.
 */
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
