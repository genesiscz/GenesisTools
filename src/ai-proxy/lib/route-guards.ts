import type { ResolvedClient } from "@app/ai-proxy/lib/clients";
import { clientProviderDenial, resolveClient } from "@app/ai-proxy/lib/clients";
import { acquireProvider, routeProviderKey } from "@app/ai-proxy/lib/providers/registry";
import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { resolveModel } from "@app/ai-proxy/lib/resolve-model";
import type { AiProxyConfig, ResolvedRoute } from "@app/ai-proxy/lib/types";
import { checkClientQuota } from "@app/ai-proxy/lib/usage/client-ledger";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export function jsonError(status: number, message: string, extra?: { type?: string; code?: string }): Response {
    return new Response(SafeJSON.stringify({ error: { message, ...extra } }), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

export interface GuardedRoute {
    client: ResolvedClient;
    route: ResolvedRoute;
    provider: ProxyProvider;
    /** The validated (non-empty) proxy model id. */
    proxyModel: string;
}

/**
 * The shared auth → resolveModel → provider-denial → quota → acquireProvider
 * sequence for endpoints that route a proxy model id to an upstream account.
 * Returns a Response on any rejection, else the guarded route.
 */
export async function guardProxyRoute(input: {
    authReq: Request;
    config: AiProxyConfig;
    providers: Map<string, ProxyProvider>;
    proxyModel: string | null | undefined;
    logLabel: string;
}): Promise<GuardedRoute | Response> {
    const client = resolveClient(input.authReq, input.config);

    if (!client) {
        return jsonError(401, "Invalid proxy API key", { type: "auth_error" });
    }

    if (!input.proxyModel || typeof input.proxyModel !== "string") {
        return jsonError(400, "Missing model");
    }

    let route: ResolvedRoute;
    try {
        route = resolveModel(input.proxyModel, input.config.accounts);
    } catch (err) {
        return jsonError(400, err instanceof Error ? err.message : String(err));
    }

    const denial = clientProviderDenial(client, route.account.provider);

    if (denial) {
        logger.warn(
            { client: client.name, model: input.proxyModel, denial },
            `ai-proxy: ${input.logLabel} provider denied`
        );
        return jsonError(403, denial, { type: "forbidden", code: "provider_not_allowed" });
    }

    const quota = checkClientQuota(client);

    if (!quota.ok) {
        logger.warn({ client: client.name, reason: quota.reason }, `ai-proxy: ${input.logLabel} quota exceeded`);
        return jsonError(429, quota.reason, { type: "quota_exceeded", code: "monthly_quota_exceeded" });
    }

    const provider = await acquireProvider(input.providers, route);

    if (!provider) {
        return jsonError(500, `Provider not loaded: ${routeProviderKey(route)}`);
    }

    return { client, route, provider, proxyModel: input.proxyModel };
}
