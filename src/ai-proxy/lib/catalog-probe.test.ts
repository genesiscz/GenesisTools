import { afterEach, describe, expect, it, mock } from "bun:test";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import * as anthropicModels from "@genesiscz/utils/ai/anthropic/models";
import * as subModels from "@genesiscz/utils/ai/openai/sub-models";

/**
 * `tools ai-proxy models` and `accounts list` only print a table, but the two
 * subscription catalogs live-read a token to ask the vendor for its model list.
 * Resolving an EXPIRED one spends a single-use grant and rewrites the config,
 * which CLAUDE.md forbids a listing from doing. These spies sit ON the call that
 * spends the grant, and throw as well as record, so a path that reaches it fails
 * loudly rather than passing quietly.
 */

/** Every refresh a catalog build set off. Must stay empty under `probe`. */
const spent: string[] = [];

function resolveOrRefuse(name: string, options?: { noRefresh?: boolean }): { token: string; accountId?: string } {
    if (options?.noRefresh) {
        // What the real resolvers throw when the stored token is expired.
        throw new Error(`Access token for "${name}" expired and refresh is disabled for diagnosis`);
    }

    spent.push(name);

    return { token: "fresh-after-refresh", accountId: "acct-1" };
}

mock.module("@genesiscz/utils/claude/subscription-auth", () => ({
    resolveAccountToken: async (name: string, options?: { noRefresh?: boolean }) => ({
        ...resolveOrRefuse(name, options),
        account: { name, accessToken: "fresh-after-refresh" },
        refreshed: true,
    }),
}));

mock.module("@app/ai-proxy/lib/providers/openai-sub-token", () => ({
    resolveOpenAiSubToken: async (account: AiProxyAccountConfig, options?: { noRefresh?: boolean }) =>
        resolveOrRefuse(account.name, options),
    resolveOpenAiSubFailoverToken: async (name: string, options?: { noRefresh?: boolean }) =>
        resolveOrRefuse(name, options),
}));

let anthropicLiveCalls = 0;
let whamLiveCalls = 0;

// Spread the real namespaces: these modules export more than this file needs,
// and a hand-listed mock silently breaks whatever imports the rest.
mock.module("@genesiscz/utils/ai/anthropic/models", () => ({
    ...anthropicModels,
    tryFetchAnthropicSubModels: async () => {
        anthropicLiveCalls += 1;

        return [{ id: "claude-live", displayName: "Live", thinking: "reasoning", contextWindow: 200_000 }];
    },
}));

mock.module("@genesiscz/utils/ai/openai/sub-models", () => ({
    ...subModels,
    tryFetchWhamModels: async () => {
        whamLiveCalls += 1;

        return [{ slug: "codex-live", displayName: "Live", contextWindow: 400_000, visibility: "list" }];
    },
}));

const anthropic: AiProxyAccountConfig = {
    name: "work",
    provider: "anthropic-subscription",
    providerSlug: "claude",
    enabled: true,
};

const codex: AiProxyAccountConfig = {
    name: "personal",
    provider: "openai-subscription",
    providerSlug: "codex",
    enabled: true,
    openaiSub: { accountName: "personal" },
};

afterEach(() => {
    spent.length = 0;
    anthropicLiveCalls = 0;
    whamLiveCalls = 0;
});

describe("buildProxyModelCatalog under probe", () => {
    it("never refreshes a token to decorate a listing, for either subscription provider", async () => {
        const { buildProxyModelCatalog } = await import("./catalog");

        const models = await buildProxyModelCatalog([anthropic, codex], { probe: true });

        expect(spent).toEqual([]);
        expect(anthropicLiveCalls).toBe(0);
        expect(whamLiveCalls).toBe(0);
        // The listing still works: it degrades to the static catalog.
        expect(models.length).toBeGreaterThan(0);
        expect(models.every((model) => model.source !== "api-catalog")).toBe(true);
    });

    it("still refreshes on the serving path, where a live catalog is the point", async () => {
        // Negative control. A guard that leaked into the normal path would strand
        // every proxy client on the static list at token expiry.
        const { buildProxyModelCatalog } = await import("./catalog");

        const models = await buildProxyModelCatalog([anthropic, codex]);

        expect(spent).toEqual(["work", "personal"]);
        expect(anthropicLiveCalls).toBe(1);
        expect(whamLiveCalls).toBe(1);
        expect(models.some((model) => model.source === "api-catalog")).toBe(true);
    });
});
