import { describe, expect, it, mock } from "bun:test";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";

/**
 * The degradation contract, in its own file because `mock.module` is
 * process-wide: with no OpenRouter catalog on disk and no committed snapshot,
 * resolution must behave EXACTLY as it did before the catalog-gated fallback
 * existed — a clear local throw, never a bare id relayed to a billed upstream.
 *
 * Only `openRouterModelSync` is replaced; every other export of the module is
 * passed through, so unrelated consumers in the import graph are unaffected.
 */
const real = await import("@genesiscz/utils/ai/catalog/openrouter");

mock.module("@genesiscz/utils/ai/catalog/openrouter", () => ({
    ...real,
    openRouterModelSync: () => undefined,
    openRouterCatalogSync: () => undefined,
}));

const { resolveModel } = await import("@app/ai-proxy/lib/resolve-model");

describe("resolve-model with no openrouter catalog available", () => {
    const openRouterAccount: AiProxyAccountConfig = {
        name: "default",
        provider: "openrouter",
        providerSlug: "openrouter",
        enabled: true,
    };

    it("the bare-id fallback never fires, so the error is the pre-fallback one", () => {
        expect(() => resolveModel("anthropic/claude-sonnet-5", [openRouterAccount])).toThrow(
            "No enabled account for model 'anthropic/claude-sonnet-5' (provider='anthropic')"
        );
    });

    /** The fully qualified and shorthand forms need no catalog, so they keep working. */
    it("the explicit forms still resolve without the catalog", () => {
        expect(resolveModel("default/openrouter/anthropic/claude-sonnet-5", [openRouterAccount]).upstreamId).toBe(
            "anthropic/claude-sonnet-5"
        );
        expect(resolveModel("openrouter/anthropic/claude-sonnet-5", [openRouterAccount]).upstreamId).toBe(
            "anthropic/claude-sonnet-5"
        );
    });
});
