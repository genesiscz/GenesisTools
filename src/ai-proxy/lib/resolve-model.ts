import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";

export interface ParsedModelId {
    accountName: string;
    providerSlug: string;
    upstreamId: string;
}

export function parseProxyModelId(proxyModelId: string): ParsedModelId {
    const parts = proxyModelId.split("/");

    if (parts.length < 3) {
        throw new Error(`Model id must be <account>/<provider>/<model>, got: ${proxyModelId}`);
    }

    const accountName = parts[0]?.trim() ?? "";
    const providerSlug = parts[1]?.trim() ?? "";
    const upstreamId = parts.slice(2).join("/").trim();

    if (!accountName || !providerSlug || !upstreamId) {
        throw new Error(`Model id must be <account>/<provider>/<model>, got: ${proxyModelId}`);
    }

    return {
        accountName,
        providerSlug,
        upstreamId,
    };
}

export function resolveModel(proxyModelId: string, accounts: AiProxyAccountConfig[]) {
    const parsed = parseProxyModelId(proxyModelId);
    const account = accounts.find(
        (item) => item.enabled && item.name === parsed.accountName && item.providerSlug === parsed.providerSlug
    );

    if (!account) {
        throw new Error(
            `No enabled account for model '${proxyModelId}' (account='${parsed.accountName}', provider='${parsed.providerSlug}')`
        );
    }

    return {
        ...parsed,
        account,
    };
}
