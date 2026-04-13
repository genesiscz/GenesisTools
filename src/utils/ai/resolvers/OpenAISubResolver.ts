import type { AIProvider } from "@app/utils/config/ai.types";
import type { DetectedProvider } from "@ask/types";
import type { AccountResolver } from "./index";
import { resolveModelsWithPricing } from "./resolve-models";

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

            // Persist new tokens
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

        const { models, config: providerConfig } = await resolveModelsWithPricing("openai");

        return {
            name: "openai",
            type: "openai-sub",
            key: `${accessToken.slice(0, 20)}...`,
            provider,
            models,
            config: providerConfig,
            account: { name: entry.name, label: entry.label },
        };
    }
}
