import type { AIProvider } from "@app/utils/config/ai.types";
import type { DetectedProvider, ModelInfo } from "@ask/types";
import type { AccountResolver } from "./index";

export class OpenAISubResolver implements AccountResolver {
    readonly providerType: AIProvider = "openai-sub";

    async resolve(accountName: string): Promise<DetectedProvider> {
        const { resolveCodexAccountToken, WHAM_BASE_URL } = await import("../openai/codex-auth");
        const { token, accountId } = await resolveCodexAccountToken(accountName);

        const { AIConfig } = await import("../AIConfig");
        const config = await AIConfig.load();
        const entry = config.getAccount(accountName);

        const { createOpenAI } = await import("@ai-sdk/openai");
        // Per-request token resolve so a long-running process follows CLI /
        // account refreshes instead of serving the token from detection time.
        const freshTokenFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const fresh = await resolveCodexAccountToken(accountName);
            const headers = new Headers(init?.headers);
            headers.set("Authorization", `Bearer ${fresh.token}`);

            if (fresh.accountId) {
                headers.set("ChatGPT-Account-Id", fresh.accountId);
            }

            return fetch(input, { ...init, headers });
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
