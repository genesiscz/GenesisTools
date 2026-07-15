import type { AIProvider } from "@app/utils/config/ai.types";
import type { DetectedProvider, ModelInfo } from "@ask/types";
import type { AccountResolver } from "./index";

/**
 * Grok CLI subscription: bills the user's SuperGrok plan via the CLI chat
 * proxy (OpenAI-compatible). The JWT is live-read from the Grok CLI auth file
 * referenced by the `grok-sub` account — see `resolveGrokSubToken`.
 */
export class GrokSubResolver implements AccountResolver {
    readonly providerType: AIProvider = "grok-sub";

    async resolve(accountName: string): Promise<DetectedProvider> {
        const { resolveGrokSubToken } = await import("../grok/account");
        const { token, account } = await resolveGrokSubToken(accountName);

        const { GROK_CLI_CHAT_PROXY_BASE_URL } = await import("../grok/paths");
        const { buildCliProxyHeaders } = await import("../grok/headers");
        const { createOpenAI } = await import("@ai-sdk/openai");
        // The CLI chat proxy 426s without the Grok CLI identification headers.
        // Token + headers are resolved per REQUEST (live file read) so a
        // long-running process picks up CLI-refreshed JWTs automatically.
        const freshTokenFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const { token: fresh } = await resolveGrokSubToken(accountName);
            const headers = new Headers(init?.headers);

            for (const [name, value] of Object.entries(buildCliProxyHeaders({ token: fresh }))) {
                headers.set(name, value);
            }

            return fetch(input, { ...init, headers });
        };
        const provider = createOpenAI({
            baseURL: GROK_CLI_CHAT_PROXY_BASE_URL,
            apiKey: "grok-sub-placeholder",
            fetch: freshTokenFetch as typeof fetch,
        });

        const { GROK_STATIC_CATALOG } = await import("../grok/models");
        const models: ModelInfo[] = GROK_STATIC_CATALOG.filter((record) => record.probeStatus === "ok").map(
            (record) => ({
                id: record.id,
                name: record.id,
                contextWindow: record.context_window ?? 131_072,
                capabilities: record.thinking === "none" ? ["chat"] : ["chat", "reasoning"],
                provider: "grok",
            })
        );

        const { getProviderConfigs } = await import("@ask/providers/providers");
        const config = getProviderConfigs().find((c) => c.name === "xai");

        if (!config) {
            throw new Error("xai provider config missing from PROVIDER_CONFIGS");
        }

        return {
            name: "grok",
            type: "grok-sub",
            key: `${token.slice(0, 16)}...`,
            provider,
            models,
            config,
            subscription: true,
            account: { name: account.name, label: account.label },
        };
    }
}
