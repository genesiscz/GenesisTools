import type { ResolvedClient } from "@app/ai-proxy/lib/clients";
import { resolveClient } from "@app/ai-proxy/lib/clients";
import { jsonError } from "@app/ai-proxy/lib/http-error";
import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { type GateResult, gateModelRoute, openAiEnvelope, refusalResponse } from "@app/ai-proxy/lib/request-lifecycle";
import type { AiProxyConfig, ResolvedRoute } from "@app/ai-proxy/lib/types";

export { jsonError } from "@app/ai-proxy/lib/http-error";

export interface GuardedRoute {
    client: ResolvedClient;
    route: ResolvedRoute;
    provider: ProxyProvider;
    /** The validated (non-empty) proxy model id. */
    proxyModel: string;
}

/**
 * Auth, then the model doors' gate (`gateModelRoute`: session forms, route, session pin, denial, quota, provider) for
 * the endpoints that are not model doors (realtime, audio). Returns a Response on any rejection, else the guarded
 * route. A model id that does not resolve is a 400 with the reason.
 */
export async function guardProxyRoute(input: {
    authReq: Request;
    config: AiProxyConfig;
    providers: Map<string, ProxyProvider>;
    proxyModel: string | null | undefined;
    logLabel: string;
}): Promise<GuardedRoute | Response> {
    const client = await resolveClient(input.authReq, input.config);

    if (!client) {
        return jsonError(401, "Invalid proxy API key", { type: "auth_error" });
    }

    if (!input.proxyModel || typeof input.proxyModel !== "string") {
        return jsonError(400, "Missing model");
    }

    let gated: GateResult;
    try {
        gated = await gateModelRoute({
            client,
            config: input.config,
            model: input.proxyModel,
            providers: input.providers,
            logLabel: input.logLabel,
        });
    } catch (err) {
        return jsonError(400, err instanceof Error ? err.message : String(err));
    }

    if ("refusal" in gated) {
        return refusalResponse(openAiEnvelope, gated.refusal);
    }

    return { client, route: gated.route, provider: gated.provider, proxyModel: input.proxyModel };
}
