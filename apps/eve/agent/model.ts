import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * Context-window size handed to eve's compaction compiler. ai-proxy model ids
 * are not Vercel AI Gateway ids, so eve cannot look this up — without it, boot
 * fails with "does not have known AI Gateway context window metadata".
 */
export const EVE_MODEL_CONTEXT_TOKENS = 128_000;

/**
 * A LanguageModel bound to the local ai-proxy (OpenAI-compatible). Every call
 * bills the subscription account behind the chosen model id, never a per-token
 * API key. Defaults to the grok subscription model, which is proven working;
 * set EVE_MODEL_ID to a claude-sub/… or codex/… id once ai-proxy Plan P0 lands.
 */
export function createProxyModel(env: Record<string, string | undefined>): LanguageModel {
  const baseURL = env.AI_PROXY_BASE_URL ?? "http://127.0.0.1:8317/v1";
  const apiKey = env.AI_PROXY_API_KEY;

  if (!apiKey) {
    throw new Error("AI_PROXY_API_KEY is required (see ~/.genesis-tools/ai-proxy/config.json → proxyApiKey)");
  }

  const modelId = env.EVE_MODEL_ID ?? "martin/grok/grok-4-fast";
  const proxy = createOpenAICompatible({ name: "ai-proxy", baseURL, apiKey });
  return proxy(modelId);
}
