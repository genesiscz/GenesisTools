import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { env } from "@app/utils/env";

export const XAI_API_BASE_URL = "https://api.x.ai/v1";

/**
 * Resolve the inference API key for an xai-api-key account.
 * Prefers the env var named in config (`apiKeyEnv`), then the standard XAI aliases.
 */
export function resolveXaiApiKey(account: AiProxyAccountConfig): string | undefined {
    if (account.apiKeyEnv) {
        const named = env.getTrimmed(account.apiKeyEnv as never);

        if (named) {
            return named;
        }
    }

    return env.x.getApiKey();
}
