import type { DetectedProvider, ModelInfo } from "@genesiscz/utils/ask/types";
import type { AIProvider } from "@genesiscz/utils/config/ai.types";
import type { AccountResolver, ResolveAccountOptions } from "./index";

export class OpenAISubResolver implements AccountResolver {
    readonly providerType: AIProvider = "openai-sub";

    async resolve(accountName: string, options?: ResolveAccountOptions): Promise<DetectedProvider> {
        const { WHAM_BASE_URL } = await import("../openai/codex-auth");
        const { CodexAccountBinding } = await import("../openai/account-binding");
        const binding = await CodexAccountBinding.create(accountName, { allowRefresh: !options?.noRefresh });
        const { accessToken: token, chatgptAccountId: accountId } = await binding.tokens();

        const { AiConfigStore } = await import("../config/AiConfigStore");
        const config = await AiConfigStore.readOnly();
        const entry = config.account(binding.accountId);

        const { createOpenAI } = await import("@ai-sdk/openai");
        const { toWhamRequest } = await import("../openai/wham-request");
        // Per-request token resolve so a long-running process follows CLI /
        // account refreshes instead of serving the token from detection time.
        // The body is rewritten for WHAM on the way out: the SDK's plain Responses
        // request got 400 "Stream must be set to true" (2026-09-10), so no `ai.chat`
        // on a codex subscription ever reached the model before this. WHAM only
        // streams, so callers stream too (`streaming: true`).
        const freshTokenFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const fresh = await binding.tokens();
            const wham = await toWhamRequest(input, init);
            const headers = new Headers(wham.headers);
            headers.set("Authorization", `Bearer ${fresh.accessToken}`);
            headers.set("ChatGPT-Account-Id", fresh.chatgptAccountId);

            return fetch(input, { ...wham, headers });
        };
        const provider = createOpenAI({
            apiKey: "codex-sub-placeholder",
            baseURL: WHAM_BASE_URL,
            fetch: freshTokenFetch as typeof fetch,
        });

        const { fetchWhamModels } = await import("../openai/sub-models");
        const records = await fetchWhamModels(token, accountId);

        const models: ModelInfo[] = records
            .filter((record) => record.visibility === "list")
            .map((record) => {
                const capabilities: string[] = ["chat"];

                if (record.inputModalities?.includes("image")) {
                    capabilities.push("vision");
                }

                if (record.supportsParallelToolCalls) {
                    capabilities.push("function-calling");
                }

                if (record.slug.includes("codex")) {
                    capabilities.push("code");
                }

                return {
                    id: record.slug,
                    name: record.displayName,
                    contextWindow: record.contextWindow,
                    capabilities,
                    provider: "openai",
                    category: record.slug.includes("mini") ? "mini" : "standard",
                };
            });

        return {
            name: "openai",
            type: "openai-sub",
            key: `${token.slice(0, 20)}...`,
            provider,
            models,
            config: {
                name: "openai",
                type: "openai-sub",
                envKey: "",
                priority: 1,
            },
            subscription: true,
            account: { name: entry?.name ?? accountName, label: entry?.label },
        };
    }
}
