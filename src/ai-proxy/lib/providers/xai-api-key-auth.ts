import { type ResolvedApiKey, resolveAccountApiKey } from "@app/ai-proxy/lib/providers/api-key-guard";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";

export const XAI_API_BASE_URL = "https://api.x.ai/v1";

/**
 * Resolve the inference API key for an xai-api-key account: the shared
 * precedence, with the XAI aliases (`XAI_API_KEY` / `X_AI_API_KEY`) as this
 * provider's default step.
 */
export function resolveXaiApiKey(account: AiProxyAccountConfig): ResolvedApiKey | undefined {
    return resolveAccountApiKey({
        account,
        defaultEnvKey: () => env.x.getApiKey(),
        knownEnvNames: env.ai.xai.getKeys(),
    });
}
