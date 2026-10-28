import { dirname } from "node:path";
import { resolveGrokAuthPath } from "@app/ai-proxy/lib/account-config";
import { loadCatalogFile } from "@app/ai-proxy/lib/catalog-file";
import { providerKey } from "@app/ai-proxy/lib/providers/registry";
import type { AiProxyAccountConfig, ProxyModelMeta } from "@app/ai-proxy/lib/types";
import type { GrokModelRecord } from "@genesiscz/utils/ai/grok";
import {
    GROK_STATIC_CATALOG,
    grokModelSpecs,
    isCuratedGrokModelId,
    pickerCacheRecords,
    readModelsCache,
    toProxyId,
} from "@genesiscz/utils/ai/grok";
import { grokModelsCachePath } from "@genesiscz/utils/ai/grok/paths";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

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
        (item) => item.accountName === account.name && item.provider === account.provider
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
