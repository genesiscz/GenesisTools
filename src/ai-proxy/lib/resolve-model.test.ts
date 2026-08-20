import { describe, expect, it } from "bun:test";
import { parseProxyModelId, resolveModel } from "@app/ai-proxy/lib/resolve-model";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";

function grokAccount(name: string): AiProxyAccountConfig {
    return { name, provider: "grok-subscription", providerSlug: "grok", enabled: true };
}

describe("resolve-model", () => {
    it("parses three-segment proxy ids", () => {
        expect(parseProxyModelId("genesiscz/grok/grok-build")).toEqual({
            accountName: "genesiscz",
            providerSlug: "grok",
            upstreamId: "grok-build",
        });
    });

    it("preserves slashes in upstream model id", () => {
        expect(parseProxyModelId("genesiscz/grok/grok-build/extra").upstreamId).toBe("grok-build/extra");
    });

    it("rejects bare upstream ids in parseProxyModelId", () => {
        expect(() => parseProxyModelId("grok-build")).toThrow("must be <account>/<provider>/<model>");
    });

    it("rejects unknown bare ids when no account matches", () => {
        expect(() => resolveModel("composer-2.5", [])).toThrow("No enabled account for model");
        expect(() => resolveModel("composer-2.5[fast=false]", [])).toThrow("No enabled account for model");
    });

    it("resolves bare upstream ids", () => {
        const accounts = [grokAccount("martin")];

        const route = resolveModel("grok-build-0.1", accounts);

        expect(route.accountName).toBe("martin");
        expect(route.providerSlug).toBe("grok");
        expect(route.upstreamId).toBe("grok-build-0.1");
    });

    it("resolves provider/upstream shorthand ids", () => {
        const accounts = [grokAccount("martin")];

        const route = resolveModel("grok/grok-build-0.1", accounts);

        expect(route.accountName).toBe("martin");
        expect(route.providerSlug).toBe("grok");
        expect(route.upstreamId).toBe("grok-build-0.1");
    });

    it("rejects bare upstream ids as ambiguous when grok + xai accounts are both implemented", () => {
        const accounts: AiProxyAccountConfig[] = [
            grokAccount("martin"),
            { name: "work", provider: "xai-api-key", providerSlug: "xai", enabled: true },
        ];

        expect(() => resolveModel("grok-build-0.1", accounts)).toThrow("Ambiguous model");
    });

    it("resolves provider/upstream to the xai account when slug is unique", () => {
        const accounts: AiProxyAccountConfig[] = [
            grokAccount("martin"),
            { name: "work", provider: "xai-api-key", providerSlug: "xai", enabled: true },
        ];

        const route = resolveModel("xai/grok-4.5", accounts);

        expect(route.accountName).toBe("work");
        expect(route.providerSlug).toBe("xai");
        expect(route.upstreamId).toBe("grok-4.5");
    });

    it("rejects ambiguous bare upstream ids across multiple implemented grok accounts", () => {
        const accounts = [grokAccount("martin"), grokAccount("work")];

        expect(() => resolveModel("grok-build-0.1", accounts)).toThrow("Ambiguous model");
    });

    it("strips a trailing :<effort> suffix and returns reasoningEffort", () => {
        const accounts = [grokAccount("martin")];

        const route = resolveModel("martin/grok/grok-4.6:xhigh", accounts);

        expect(route.upstreamId).toBe("grok-4.6");
        expect(route.reasoningEffort).toBe("xhigh");
        expect(route.accountName).toBe("martin");
    });

    it("leaves OpenRouter :batch suffixes on the upstream id", () => {
        const accounts: AiProxyAccountConfig[] = [
            { name: "openrouter", provider: "openrouter", providerSlug: "openrouter", enabled: true },
        ];

        const route = resolveModel("openrouter/openrouter/anthropic/claude-opus-4.6:batch", accounts);

        expect(route.upstreamId).toBe("anthropic/claude-opus-4.6:batch");
        expect(route.reasoningEffort).toBeUndefined();
    });

    it("rejects ambiguous provider/upstream ids across multiple accounts", () => {
        const accounts = [grokAccount("martin"), grokAccount("work")];

        expect(() => resolveModel("grok/grok-build-0.1", accounts)).toThrow("Ambiguous model");
    });

    it("rejects empty model-id segments", () => {
        expect(() => parseProxyModelId("genesiscz/grok/")).toThrow("must be <account>/<provider>/<model>");
        expect(() => parseProxyModelId("/grok/model")).toThrow("must be <account>/<provider>/<model>");
    });

    it("resolves account by name and provider slug", () => {
        const route = resolveModel("genesiscz/grok/grok-build", [grokAccount("genesiscz")]);

        expect(route.account.provider).toBe("grok-subscription");
        expect(route.upstreamId).toBe("grok-build");
    });
});

/**
 * OpenRouter ids contain a slash, which collides head-on with this module's
 * `<account>/<provider>/<model>` grammar. These cases pin BOTH directions: what
 * newly resolves, and what must keep throwing.
 */
describe("resolve-model with openrouter accounts", () => {
    const openRouterAccount = (name: string): AiProxyAccountConfig => ({
        name,
        provider: "openrouter",
        providerSlug: "openrouter",
        enabled: true,
    });

    it("resolves the fully qualified four-segment id", () => {
        const route = resolveModel("default/openrouter/anthropic/claude-sonnet-5", [openRouterAccount("default")]);

        expect(route.accountName).toBe("default");
        expect(route.providerSlug).toBe("openrouter");
        expect(route.upstreamId).toBe("anthropic/claude-sonnet-5");
    });

    /**
     * This is the shape `core/model-ref.ts` produces for
     * `@proxy/<slug>/openrouter/anthropic/...`: the account name is missing, so
     * `parseProxyModelId` reads "openrouter" as the account and "anthropic" as the
     * provider. Without the retry the utils-to-proxy path is broken end to end.
     */
    it("resolves the provider-slug shorthand the @proxy path produces", () => {
        const route = resolveModel("openrouter/anthropic/claude-sonnet-5", [openRouterAccount("default")]);

        expect(route.accountName).toBe("default");
        expect(route.providerSlug).toBe("openrouter");
        expect(route.upstreamId).toBe("anthropic/claude-sonnet-5");
    });

    it("resolves a bare openrouter id, slash preserved", () => {
        const route = resolveModel("anthropic/claude-sonnet-5", [openRouterAccount("default")]);

        expect(route.accountName).toBe("default");
        expect(route.upstreamId).toBe("anthropic/claude-sonnet-5");
    });

    /** The provider-slug reading is tried first, so it still wins where it applies. */
    it("prefers an account whose providerSlug is literally the vendor prefix", () => {
        const accounts: AiProxyAccountConfig[] = [
            openRouterAccount("router"),
            { name: "direct", provider: "anthropic-subscription", providerSlug: "anthropic", enabled: true },
        ];

        const route = resolveModel("anthropic/claude-sonnet-5", accounts);

        expect(route.accountName).toBe("direct");
        expect(route.providerSlug).toBe("anthropic");
        expect(route.upstreamId).toBe("claude-sonnet-5");
    });

    it("reports two openrouter accounts as ambiguous rather than guessing", () => {
        const accounts = [openRouterAccount("personal"), openRouterAccount("work")];

        expect(() => resolveModel("anthropic/claude-sonnet-5", accounts)).toThrow("Ambiguous model");
    });

    /**
     * 🛑 The gate. Ungated, this would stop throwing a clear local error and become
     * an upstream 404 charged through a BILLED account. OpenRouter serves
     * `x-ai/grok-4.5`, never `xai/grok-4.5`, so the catalog says no.
     */
    it("still throws for a slashed id openrouter does not serve", () => {
        expect(() => resolveModel("xai/grok-4.5", [openRouterAccount("default")])).toThrow(
            "No enabled account for model"
        );
    });

    it("still throws when no openrouter account exists at all", () => {
        expect(() => resolveModel("anthropic/claude-sonnet-5", [grokAccount("martin")])).toThrow(
            "No enabled account for model"
        );
    });
});
