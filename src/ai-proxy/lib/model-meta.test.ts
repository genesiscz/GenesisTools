import { describe, expect, it } from "bun:test";
import { listAnthropicSubProxyModels } from "@app/ai-proxy/lib/model-meta";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";

const account: AiProxyAccountConfig = {
    name: "martin",
    provider: "anthropic-subscription",
    providerSlug: "claude-sub",
    enabled: true,
};

describe("listAnthropicSubProxyModels", () => {
    it("reports the real 1M context window for sonnet/opus/fable, 200K for haiku", () => {
        const models = listAnthropicSubProxyModels(account);
        const byAlias = Object.fromEntries(models.map((model) => [model.upstreamId, model.contextWindow]));

        expect(byAlias.sonnet).toBe(1_000_000);
        expect(byAlias.opus).toBe(1_000_000);
        expect(byAlias.fable).toBe(1_000_000);
        expect(byAlias.haiku).toBe(200_000);
    });
});
