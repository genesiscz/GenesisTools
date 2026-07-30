import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { agentEnv, eveEnv } from "./lib/env";

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
 *
 * Phase 8d specified `resolveModel("@proxy/<slug>/<model>").binding.language(…)`
 * here instead of a raw OpenAI-compatible client. That is not reachable from
 * this package and was not forced: `resolveModel` lives in
 * `@genesiscz/utils/ai/core`, and apps/eve is outside the root `workspaces`
 * array with no dependency on it. Reaching it means either pulling eve into the
 * parent workspace or vendoring the whole AI layer, and both contradict the
 * boundary eve is built on — eve is an ai-proxy CLIENT that talks HTTP, not an
 * in-process consumer of the resolver.
 *
 * The part of 8d that mattered is done regardless: the proxy is a first-class
 * AI-config account (`tools ai-proxy link`), so the credential this reads is
 * managed and vault-backed on the GenesisTools side rather than being an
 * unmanaged shared secret. What stays different is only WHERE the binding is
 * constructed.
 */
export function createProxyModel(env: Record<string, string | undefined> = agentEnv): LanguageModel {
  const baseURL = eveEnv.getAiProxyBaseUrl(env);
  const apiKey = eveEnv.getAiProxyApiKey(env);

  if (!apiKey) {
    throw new Error("AI_PROXY_API_KEY is required (see ~/.genesis-tools/ai-proxy/config.json → proxyApiKey)");
  }

  const proxy = createOpenAICompatible({ name: "ai-proxy", baseURL, apiKey });
  return proxy(eveEnv.getModelId(env));
}
