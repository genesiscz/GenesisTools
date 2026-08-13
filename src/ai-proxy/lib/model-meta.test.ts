import { describe, expect, it } from "bun:test";
import {
    listAnthropicSubProxyModels,
    listOpenAiSubProxyModels,
    listOpenRouterProxyModels,
    listXaiStaticProxyModels,
} from "@app/ai-proxy/lib/model-meta";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { ANTHROPIC_SUB_ALIASES } from "@genesiscz/utils/ai/anthropic/models";
import { byProvider } from "@genesiscz/utils/ai/catalog";
import { isCuratedGrokModelId } from "@genesiscz/utils/ai/grok";

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

const xaiAccount: AiProxyAccountConfig = {
    name: "xkey",
    provider: "xai-api-key",
    providerSlug: "xai",
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

describe("listXaiStaticProxyModels", () => {
    it("offers every curated xAI id the shared catalog carries", () => {
        const models = listXaiStaticProxyModels(xaiAccount, "https://api.x.ai/v1");
        const expected = byProvider("xai")
            .map((entry) => entry.id)
            .filter(isCuratedGrokModelId);

        expect(models.map((model) => model.upstreamId).sort()).toEqual(expected.sort());
        // The list this replaced held six ids, of which curation kept two.
        expect(models.length).toBeGreaterThanOrEqual(2);
    });

    it("takes context windows from the catalog and marks the source static", () => {
        const models = listXaiStaticProxyModels(xaiAccount, "https://api.x.ai/v1");
        const fast = models.find((model) => model.upstreamId === "grok-4-fast");

        expect(fast?.contextWindow).toBe(2_000_000);
        expect(models.every((model) => model.source === "static" && model.probeStatus === "skipped")).toBe(true);
        expect(models.every((model) => model.proxyId.startsWith("xkey/xai/"))).toBe(true);
    });

    it("keeps ids curation excludes out of the client-facing list", () => {
        const ids = listXaiStaticProxyModels(xaiAccount, "https://api.x.ai/v1").map((model) => model.upstreamId);

        expect(ids).not.toContain("grok-3");
        expect(ids).not.toContain("grok-4.20-0309-reasoning");
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

describe("listOpenRouterProxyModels", () => {
    const openRouterAccount = (models?: { include?: string[]; exclude?: string[] }): AiProxyAccountConfig => ({
        name: "router",
        provider: "openrouter",
        providerSlug: "openrouter",
        enabled: true,
        ...(models ? { openrouter: { models } } : {}),
    });

    it("advertises the curated default when no filter is configured", async () => {
        const ids = (await listOpenRouterProxyModels(openRouterAccount())).map((model) => model.upstreamId);

        expect(ids.length).toBeGreaterThan(50);
        expect(ids).toContain("anthropic/claude-sonnet-5");
        // Not in the curated vendor list, so the default filter hides it.
        expect(ids.some((id) => id.startsWith("thedrummer/"))).toBe(false);
    });

    /**
     * `??` and not `||`: absent means "curated default", an explicit `[]` means
     * "no filter". Collapsing them makes `include: []` mean the opposite of what
     * it reads as.
     */
    it("distinguishes an absent include list from an empty one", async () => {
        const empty = (await listOpenRouterProxyModels(openRouterAccount({ include: [] }))).map(
            (model) => model.upstreamId
        );
        const star = (await listOpenRouterProxyModels(openRouterAccount({ include: ["*"] }))).map(
            (model) => model.upstreamId
        );
        const curated = (await listOpenRouterProxyModels(openRouterAccount())).map((model) => model.upstreamId);

        expect(empty).toEqual(star);
        expect(empty.length).toBeGreaterThan(curated.length);
        expect(empty.some((id) => id.startsWith("thedrummer/"))).toBe(true);
    });

    it("excludes free routes by default and honours an explicit empty exclude", async () => {
        const defaults = (await listOpenRouterProxyModels(openRouterAccount({ include: ["*"] }))).map(
            (model) => model.upstreamId
        );
        const nothingExcluded = (
            await listOpenRouterProxyModels(openRouterAccount({ include: ["*"], exclude: [] }))
        ).map((model) => model.upstreamId);

        expect(defaults.some((id) => id.endsWith(":free"))).toBe(false);
        expect(nothingExcluded.some((id) => id.endsWith(":free"))).toBe(true);
    });

    it("applies exclude after include", async () => {
        const ids = (
            await listOpenRouterProxyModels(openRouterAccount({ include: ["anthropic/*"], exclude: ["*haiku*"] }))
        ).map((model) => model.upstreamId);

        expect(ids.length).toBeGreaterThan(0);
        expect(ids.every((id) => id.startsWith("anthropic/"))).toBe(true);
        expect(ids.some((id) => id.includes("haiku"))).toBe(false);
    });

    /** The `-1`-priced router pseudo-models can never be priced, so they are never advertised. */
    it("always drops the meta routes, even under include ['*']", async () => {
        const ids = (await listOpenRouterProxyModels(openRouterAccount({ include: ["*"], exclude: [] }))).map(
            (model) => model.upstreamId
        );

        for (const meta of ["openrouter/auto", "openrouter/fusion", "openrouter/bodybuilder"]) {
            expect(ids).not.toContain(meta);
        }
    });

    it("maps real capability data rather than inferring it from the id", async () => {
        const models = await listOpenRouterProxyModels(openRouterAccount({ include: ["anthropic/claude-sonnet-5"] }));
        const sonnet = models.find((model) => model.upstreamId === "anthropic/claude-sonnet-5");

        expect(sonnet?.proxyId).toBe("router/openrouter/anthropic/claude-sonnet-5");
        expect(sonnet?.contextWindow).toBe(1_000_000);
        expect(sonnet?.inputModalities).toContain("image");
        expect(sonnet?.supportsTools).toBe(true);
        expect(sonnet?.thinking).toBe("optional");
        expect(sonnet?.billingPlane).toBe("api-key");
    });
});
