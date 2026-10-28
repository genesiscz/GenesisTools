import { loadCatalogFile } from "@app/ai-proxy/lib/catalog-file";
import { resolveCopilotModelRecords } from "@app/ai-proxy/lib/copilot-models-cache";
import { providerKey } from "@app/ai-proxy/lib/providers/registry";
import type { AiProxyAccountConfig, ProxyModelMeta } from "@app/ai-proxy/lib/types";
import { toProxyId as toCopilotProxyId } from "@genesiscz/utils/ai/github-copilot/models";
import { COPILOT_INDIVIDUAL_API } from "@genesiscz/utils/ai/github-copilot/paths";
import type { CopilotModelRecord } from "@genesiscz/utils/ai/github-copilot/types";

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

function catalogCopilotRecords(account: AiProxyAccountConfig): CopilotModelRecord[] {
    const catalog = loadCatalogFile();
    const accountCatalog = catalog?.accounts.find(
        (entry) => entry.accountName === account.name && entry.provider === account.provider
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
