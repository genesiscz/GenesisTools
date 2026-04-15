import logger from "@app/logger";
import type { AIProvider } from "@app/utils/config/ai.types";
import type { DetectedProvider, ModelInfo } from "@ask/types";
import type { AccountResolver } from "./index";

/** WHAM /models response schema (differs from standard OpenAI API) */
interface WhamModel {
    slug: string;
    display_name: string;
    context_window: number;
    visibility: "list" | "hide";
    input_modalities?: string[];
    supports_parallel_tool_calls?: boolean;
}

interface WhamModelsResponse {
    models: WhamModel[];
}

const WHAM_CLIENT_VERSION = "1.0.26";

export class OpenAISubResolver implements AccountResolver {
    readonly providerType: AIProvider = "openai-sub";

    async resolve(accountName: string): Promise<DetectedProvider> {
        const { AIConfig } = await import("../AIConfig");
        const config = await AIConfig.load();
        const entry = config.getAccount(accountName);

        if (!entry) {
            throw new Error(`Account "${accountName}" not found in AI config.`);
        }

        let accessToken = entry.tokens.accessToken;
        const refreshToken = entry.tokens.refreshToken;

        if (!accessToken) {
            throw new Error(
                `No access token for OpenAI subscription account "${accountName}". ` +
                    `Run \`tools ask config\` → Add account → OpenAI/Codex.`
            );
        }

        // Refresh if expired
        const { codexOAuth, extractAccountId, WHAM_BASE_URL } = await import("../openai/codex-auth");

        if (entry.tokens.expiresAt && codexOAuth.needsRefresh(entry.tokens.expiresAt)) {
            if (!refreshToken) {
                throw new Error(
                    `Token for "${accountName}" is expired and no refresh token is available. ` +
                        `Run \`tools ask config\` and re-authenticate.`
                );
            }

            const refreshed = await codexOAuth.refresh(refreshToken);

            await config.mutate((data) => {
                const acc = data.accounts.find((a) => a.name === accountName);

                if (acc) {
                    acc.tokens.accessToken = refreshed.accessToken;
                    acc.tokens.refreshToken = refreshed.refreshToken;
                    acc.tokens.expiresAt = refreshed.expiresAt;
                }
            });

            accessToken = refreshed.accessToken;
        }

        const accountId = extractAccountId(accessToken);

        const { createOpenAI } = await import("@ai-sdk/openai");
        const provider = createOpenAI({
            apiKey: accessToken,
            baseURL: WHAM_BASE_URL,
            headers: accountId ? { "ChatGPT-Account-Id": accountId } : undefined,
        });

        // Fetch live models from WHAM (non-standard schema)
        const models = await this.fetchWhamModels(accessToken, accountId, WHAM_BASE_URL);

        return {
            name: "openai",
            type: "openai-sub",
            key: `${accessToken.slice(0, 20)}...`,
            provider,
            models,
            config: {
                name: "openai",
                type: "openai-sub",
                envKey: "",
                priority: 1,
            },
            account: { name: entry.name, label: entry.label },
        };
    }

    private async fetchWhamModels(
        accessToken: string,
        accountId: string | undefined,
        baseURL: string
    ): Promise<ModelInfo[]> {
        try {
            const headers: Record<string, string> = {
                Authorization: `Bearer ${accessToken}`,
            };

            if (accountId) {
                headers["ChatGPT-Account-Id"] = accountId;
            }

            const res = await fetch(`${baseURL}/models?client_version=${WHAM_CLIENT_VERSION}`, { headers });

            if (!res.ok) {
                throw new Error(`WHAM /models returned ${res.status}`);
            }

            const data = (await res.json()) as WhamModelsResponse;

            return data.models
                .filter((m) => m.visibility === "list")
                .map((m) => {
                    const capabilities: string[] = ["chat"];

                    if (m.input_modalities?.includes("image")) {
                        capabilities.push("vision");
                    }

                    if (m.supports_parallel_tool_calls) {
                        capabilities.push("function-calling");
                    }

                    if (m.slug.includes("codex")) {
                        capabilities.push("code");
                    }

                    return {
                        id: m.slug,
                        name: m.display_name,
                        contextWindow: m.context_window,
                        capabilities,
                        provider: "openai",
                        category: m.slug.includes("mini") ? "mini" : "standard",
                    };
                });
        } catch (err) {
            logger.warn(`Failed to fetch WHAM models: ${err}`);
            // Fallback to a minimal known set
            return [
                {
                    id: "gpt-5.4",
                    name: "gpt-5.4",
                    contextWindow: 272000,
                    capabilities: ["chat", "vision", "function-calling"],
                    provider: "openai",
                    category: "standard",
                },
                {
                    id: "gpt-5.4-mini",
                    name: "GPT-5.4-Mini",
                    contextWindow: 272000,
                    capabilities: ["chat", "vision", "function-calling"],
                    provider: "openai",
                    category: "mini",
                },
            ];
        }
    }
}
