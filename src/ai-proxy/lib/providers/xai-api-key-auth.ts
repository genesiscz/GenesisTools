import type { ResolvedApiKey } from "@app/ai-proxy/lib/providers/api-key-guard";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";

export const XAI_API_BASE_URL = "https://api.x.ai/v1";

/**
 * Resolve the inference API key for an xai-api-key account.
 * Config `apiKey` wins so the account survives an environment without the shell
 * vars, then the env var named in config (`apiKeyEnv`), then the XAI aliases.
 */
export function resolveXaiApiKey(account: AiProxyAccountConfig): ResolvedApiKey | undefined {
    const configured = account.apiKey?.trim();

    if (configured) {
        return { key: configured, source: "config" };
    }

    if (account.apiKeyEnv) {
        const named = env.getTrimmed(account.apiKeyEnv as never);

        if (named) {
            return { key: named, source: "configEnv" };
        }
    }

    const fallback = env.x.getApiKey();

    if (fallback) {
        return { key: fallback, source: "defaultEnv" };
    }

    return undefined;
}
