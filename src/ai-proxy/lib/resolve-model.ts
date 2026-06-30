import { isProviderImplemented } from "@app/ai-proxy/lib/providers/registry";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";

export interface ParsedModelId {
    accountName: string;
    providerSlug: string;
    upstreamId: string;
}

const FULL_MODEL_ID_HINT = "Use a full <account>/<provider>/<model> id.";

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

function enabledImplementedAccounts(accounts: AiProxyAccountConfig[]) {
    return accounts.filter((item) => item.enabled && isProviderImplemented(item.provider));
}

function resolveFromAccountMatches(matches: AiProxyAccountConfig[], upstreamId: string, requestedId: string) {
    if (matches.length === 0) {
        return undefined;
    }

    if (matches.length > 1) {
        const labels = matches.map((account) => `${account.name}/${account.providerSlug}`).join(", ");

        throw new Error(
            `Ambiguous model '${requestedId}': multiple enabled accounts match (${labels}). ${FULL_MODEL_ID_HINT}`
        );
    }

    const account = matches[0];

    return {
        accountName: account.name,
        providerSlug: account.providerSlug,
        upstreamId,
        account,
    };
}

function resolveBareUpstreamModel(upstreamId: string, accounts: AiProxyAccountConfig[]) {
    const enabled = enabledImplementedAccounts(accounts);
    const matches = enabled.filter((account) => account.providerSlug.length > 0);

    return resolveFromAccountMatches(matches, upstreamId, upstreamId);
}

function resolveProviderUpstreamModel(providerSlug: string, upstreamId: string, accounts: AiProxyAccountConfig[]) {
    const enabled = enabledImplementedAccounts(accounts);
    const matches = enabled.filter((account) => account.providerSlug === providerSlug);

    return resolveFromAccountMatches(matches, upstreamId, `${providerSlug}/${upstreamId}`);
}

export function resolveModel(proxyModelId: string, accounts: AiProxyAccountConfig[]) {
    const trimmed = proxyModelId.trim();

    if (!trimmed) {
        throw new Error(`Model id must be <account>/<provider>/<model>, got: ${proxyModelId}`);
    }

    const slashCount = (trimmed.match(/\//g) ?? []).length;

    if (slashCount === 0) {
        const bareRoute = resolveBareUpstreamModel(trimmed, accounts);

        if (bareRoute) {
            return bareRoute;
        }

        throw new Error(`No enabled account for model '${proxyModelId}'. ${FULL_MODEL_ID_HINT}`);
    }

    if (slashCount === 1) {
        const [rawProviderSlug = "", rawUpstreamId = ""] = trimmed.split("/", 2);
        const providerSlug = rawProviderSlug.trim();
        const upstreamId = rawUpstreamId.trim();

        if (!providerSlug || !upstreamId) {
            throw new Error(
                `Model id must be <provider>/<model> or <account>/<provider>/<model>, got: ${proxyModelId}`
            );
        }

        const providerRoute = resolveProviderUpstreamModel(providerSlug, upstreamId, accounts);

        if (providerRoute) {
            return providerRoute;
        }

        throw new Error(
            `No enabled account for model '${proxyModelId}' (provider='${providerSlug}'). ${FULL_MODEL_ID_HINT}`
        );
    }

    const parsed = parseProxyModelId(trimmed);
    const account = enabledImplementedAccounts(accounts).find(
        (item) => item.name === parsed.accountName && item.providerSlug === parsed.providerSlug
    );

    if (!account) {
        throw new Error(
            `No enabled account for model '${proxyModelId}' (account='${parsed.accountName}', provider='${parsed.providerSlug}'). ${FULL_MODEL_ID_HINT}`
        );
    }

    return {
        ...parsed,
        account,
    };
}
