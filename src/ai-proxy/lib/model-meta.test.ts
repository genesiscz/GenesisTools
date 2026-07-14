import { describe, expect, it } from "bun:test";
import { listAnthropicSubProxyModels, listOpenAiSubProxyModels } from "@app/ai-proxy/lib/model-meta";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { ANTHROPIC_SUB_ALIASES } from "@app/utils/ai/anthropic/models";

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
    it("always includes short aliases with correct context windows", async () => {
        const models = await listAnthropicSubProxyModels(account);
        const byAlias = Object.fromEntries(models.map((model) => [model.upstreamId, model.contextWindow]));

        expect(byAlias.sonnet).toBe(1_000_000);
        expect(byAlias.opus).toBe(1_000_000);
        expect(byAlias.fable).toBe(1_000_000);
        expect(byAlias.haiku).toBe(200_000);

        for (const alias of ANTHROPIC_SUB_ALIASES) {
            expect(models.some((model) => model.upstreamId === alias)).toBe(true);
        }
    });

    it("marks probeStatus ok when live or skipped on static fallback", async () => {
        const models = await listAnthropicSubProxyModels(account);
        const statuses = new Set(models.map((model) => model.probeStatus));

        // Live API → ok; no auth / fetch fail → skipped. Never n/a (undefined).
        expect([...statuses].every((status) => status === "ok" || status === "skipped")).toBe(true);
    });
});

describe("listOpenAiSubProxyModels", () => {
    it("returns at least one codex model with a proxy id", async () => {
        const models = await listOpenAiSubProxyModels(codexAccount);

        expect(models.length).toBeGreaterThan(0);
        expect(models.every((model) => model.proxyId.startsWith("codex/codex/"))).toBe(true);
        expect(models.every((model) => model.contextWindow == null || model.contextWindow > 0)).toBe(true);
    });

    it("marks probeStatus ok when live or skipped on static fallback", async () => {
        const models = await listOpenAiSubProxyModels(codexAccount);
        const statuses = new Set(models.map((model) => model.probeStatus));

        expect([...statuses].every((status) => status === "ok" || status === "skipped")).toBe(true);
    });
});
