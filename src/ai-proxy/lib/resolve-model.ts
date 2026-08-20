import { isProviderImplemented } from "@app/ai-proxy/lib/providers/registry";
import type { AiProxyAccountConfig, ReasoningEffort, ResolvedRoute } from "@app/ai-proxy/lib/types";
import { openRouterModelSync } from "@genesiscz/utils/ai/catalog/openrouter";

export const REASONING_EFFORT_SUFFIXES = [
    "low",
    "medium",
    "high",
    "xhigh",
    "minimal",
    "max",
] as const satisfies readonly ReasoningEffort[];

const REASONING_EFFORT_SET = new Set<string>(REASONING_EFFORT_SUFFIXES);

/**
 * Split a trailing `:<effort>` off a proxy model id.
 *
 * OpenRouter ids also use colons (`claude-opus-4.6:batch`), so only known
 * effort tokens are stripped. Unknown suffixes stay on the upstream id.
 */
export function splitReasoningEffortSuffix(modelId: string): {
    modelId: string;
    reasoningEffort?: ReasoningEffort;
} {
    const colon = modelId.lastIndexOf(":");

    if (colon <= 0) {
        return { modelId };
    }

    const suffix = modelId
        .slice(colon + 1)
        .trim()
        .toLowerCase();

    if (!REASONING_EFFORT_SET.has(suffix)) {
        return { modelId };
    }

    const base = modelId.slice(0, colon).trim();

    if (!base) {
        return { modelId };
    }

    return { modelId: base, reasoningEffort: suffix as ReasoningEffort };
}

export interface ParsedModelId {
    accountName: string;
    providerSlug: string;
    upstreamId: string;
}

const FULL_MODEL_ID_HINT =
    "Use a full <account>/<provider>/<model> id, e.g. default/openrouter/anthropic/claude-sonnet-5.";

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

/**
 * The last resort: a whole slashed string IS one upstream model id.
 *
 * OpenRouter's ids contain a slash (`anthropic/claude-sonnet-5`), which collides
 * head-on with this module's `<account>/<provider>/<model>` grammar. Only
 * openrouter accounts can answer such a request, so only they are considered.
 *
 * 🛑 **Catalog-gated, not unconditional.** Ungated, `xai/grok-4.5` on a box with
 * no xai account would stop throwing a clear local error and instead become an
 * upstream 404 charged through a BILLED account. Gated, `anthropic/claude-sonnet-5`
 * resolves because OpenRouter really serves it, and `xai/grok-4.5` keeps throwing
 * because it does not. When the catalog is unavailable the gate never opens and
 * behaviour is bit-identical to before this fallback existed.
 *
 * `openRouterModelSync` reads a memoized file and never the network — this runs
 * on every routed request.
 */
function resolveCatalogGatedUpstreamModel(upstreamId: string, accounts: AiProxyAccountConfig[]) {
    if (!openRouterModelSync(upstreamId)) {
        return undefined;
    }

    const candidates = enabledImplementedAccounts(accounts).filter((account) => account.provider === "openrouter");

    return resolveFromAccountMatches(candidates, upstreamId, upstreamId);
}

export function resolveModel(proxyModelId: string, accounts: AiProxyAccountConfig[]): ResolvedRoute {
    const { modelId, reasoningEffort } = splitReasoningEffortSuffix(proxyModelId.trim());
    const route = resolveModelWithoutEffort(modelId, accounts);

    if (!reasoningEffort) {
        return route;
    }

    return { ...route, reasoningEffort };
}

function resolveModelWithoutEffort(proxyModelId: string, accounts: AiProxyAccountConfig[]): ResolvedRoute {
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

        // The provider-slug reading is tried FIRST and therefore still wins, so an
        // account whose slug is literally `anthropic` keeps answering
        // `anthropic/claude-sonnet-5` exactly as it does today.
        const providerRoute = resolveProviderUpstreamModel(providerSlug, upstreamId, accounts);

        if (providerRoute) {
            return providerRoute;
        }

        const catalogRoute = resolveCatalogGatedUpstreamModel(trimmed, accounts);

        if (catalogRoute) {
            return catalogRoute;
        }

        throw new Error(
            `No enabled account for model '${proxyModelId}' (provider='${providerSlug}'). ${FULL_MODEL_ID_HINT}`
        );
    }

    const parsed = parseProxyModelId(trimmed);
    const account = enabledImplementedAccounts(accounts).find(
        (item) => item.name === parsed.accountName && item.providerSlug === parsed.providerSlug
    );

    if (account) {
        return {
            ...parsed,
            account,
        };
    }

    // `@proxy/<slug>/anthropic/claude-sonnet-5` lands here: `parseProxyModelId`
    // read the PROVIDER SLUG as the account name and the vendor prefix as the
    // provider, because it counts slashes and an OpenRouter id contains one. This
    // is the utils-to-proxy path, and without the retry it is broken end to end.
    const shorthandRoute = resolveProviderUpstreamModel(
        parsed.accountName,
        `${parsed.providerSlug}/${parsed.upstreamId}`,
        accounts
    );

    if (shorthandRoute) {
        return shorthandRoute;
    }

    const catalogRoute = resolveCatalogGatedUpstreamModel(trimmed, accounts);

    if (catalogRoute) {
        return catalogRoute;
    }

    throw new Error(
        `No enabled account for model '${proxyModelId}' (account='${parsed.accountName}', provider='${parsed.providerSlug}'). ${FULL_MODEL_ID_HINT}`
    );
}
