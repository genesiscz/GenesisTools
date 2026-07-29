import { describe, expect, it, mock } from "bun:test";

// Every collaborator of `detectProviders` is a dynamic import or a network probe,
// so this replaces them with the smallest fixture that exercises the cache
// semantics: no env-key providers at all, one grok-sub and one openai-sub account.

const ACCOUNTS_BY_PROVIDER: Record<string, { name: string }[]> = {
    "grok-sub": [{ name: "grok-cli" }],
    "openai-sub": [{ name: "codex" }],
};

function stubProvider(name: string) {
    return {
        name,
        type: name,
        key: "stub",
        provider: {},
        models: [],
        config: { name, type: name, envKey: "STUB", priority: 1 },
        subscription: true,
    };
}

mock.module("@genesiscz/utils/ask/providers/providers", () => ({
    getProviderConfigs: () => [],
    KNOWN_MODELS: {},
}));

mock.module("@ask/config", () => ({
    loadAskConfig: async () => ({}),
}));

mock.module("@genesiscz/utils/ai/AIConfig", () => ({
    AIConfig: {
        load: async () => ({
            isProviderEnabled: () => true,
            getProviderApiKey: () => undefined,
            getAccountsByProvider: (provider: string) => ACCOUNTS_BY_PROVIDER[provider] ?? [],
            getDefaultAccount: () => undefined,
        }),
    },
}));

mock.module("@genesiscz/utils/ai/resolvers", () => ({
    ensureResolversInitialized: async () => {},
    getResolver: (kind: string) => ({
        resolve: async () => stubProvider(kind === "grok-sub" ? "grok" : "openai"),
    }),
}));

import { ProviderManager } from "@ask/providers/ProviderManager";

describe("ProviderManager.detectProviders", () => {
    it("includes an earlier targeted scan's provider in the first full-catalog result", async () => {
        const manager = new ProviderManager();

        expect((await manager.detectProviders("grok")).map((provider) => provider.name)).toEqual(["grok"]);

        // The full scan skips the grok probe because it is already cached, so
        // returning only what THIS call discovered would serve an openai-only
        // catalog to the first caller that asked for everything.
        const full = await manager.detectProviders();
        expect(full.map((provider) => provider.name).sort()).toEqual(["grok", "openai"]);
    });

    it("serves the same complete catalog from the cache on later calls", async () => {
        const manager = new ProviderManager();
        await manager.detectProviders();

        expect((await manager.detectProviders()).map((provider) => provider.name).sort()).toEqual(["grok", "openai"]);
    });
});
