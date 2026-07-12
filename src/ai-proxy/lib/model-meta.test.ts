import { describe, expect, it } from "bun:test";
import { listAnthropicSubProxyModels, listOpenAiSubProxyModels } from "@app/ai-proxy/lib/model-meta";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { ANTHROPIC_SUB_STATIC_CATALOG } from "@app/utils/ai/anthropic/models";
import { OPENAI_SUB_STATIC_CATALOG } from "@app/utils/ai/openai/sub-models";

const account: AiProxyAccountConfig = {
    name: "martin",
    provider: "anthropic-subscription",
    providerSlug: "claude-sub",
    enabled: true,
};

const codexAccount: AiProxyAccountConfig = {
    name: "codex",
    provider: "openai-subscription",
    providerSlug: "codex",
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

    it("advertises every concrete catalog id alongside the aliases", () => {
        const models = listAnthropicSubProxyModels(account);
        const upstreamIds = new Set(models.map((model) => model.upstreamId));

        for (const record of ANTHROPIC_SUB_STATIC_CATALOG) {
            expect(upstreamIds.has(record.id)).toBe(true);
        }

        expect(models.find((model) => model.upstreamId === "claude-sonnet-5")?.proxyId).toBe(
            "martin/claude-sub/claude-sonnet-5"
        );
    });
});

describe("listOpenAiSubProxyModels", () => {
    it("maps catalog records to proxy metas with their real context windows", () => {
        const models = listOpenAiSubProxyModels(codexAccount);
        const byId = Object.fromEntries(models.map((model) => [model.upstreamId, model]));

        expect(byId["gpt-5.6-sol"].contextWindow).toBe(372_000);
        expect(byId["gpt-5.5"].contextWindow).toBe(272_000);
        expect(byId["gpt-5.5"].proxyId).toBe("codex/codex/gpt-5.5");
    });

    it("only advertises visibility=list catalog entries", () => {
        const models = listOpenAiSubProxyModels(codexAccount);
        const listed = OPENAI_SUB_STATIC_CATALOG.filter((record) => record.visibility === "list");

        expect(models.length).toBe(listed.length);
    });
});
