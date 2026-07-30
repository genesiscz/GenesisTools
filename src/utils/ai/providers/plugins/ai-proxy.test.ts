import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import type { AccountEntry } from "../../config/schema";
import { CredentialUnavailableError } from "../credentials";
import { aiProxyPlugin } from "./ai-proxy";

/** ai's LanguageModel is `string | LanguageModelV3`; only the object form has ids. */
function modelIdOf(model: LanguageModel): string {
    return typeof model === "string" ? model : model.modelId;
}

function account(overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id: "acc_proxy",
        name: "local-proxy",
        provider: "ai-proxy",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: { apiKey: "proxy-key" },
        useEnvApiKey: false,
        ...overrides,
    };
}

describe("ai-proxy gateway plugin", () => {
    test("is a gateway that bills nothing of its own", async () => {
        const binding = await aiProxyPlugin.bind({ account: account() });

        expect(aiProxyPlugin.kind).toBe("gateway");
        // Cost is booked against whichever account backs the model id upstream;
        // counting it here as well would double-charge the usage view.
        expect(binding.billed).toBe(false);
        expect(binding.providerId).toBe("ai-proxy");
    });

    test("builds a language model for a proxy model id", async () => {
        const binding = await aiProxyPlugin.bind({ account: account() });
        const model = binding.language("martin/grok/grok-4-fast");

        expect(modelIdOf(model)).toBe("martin/grok/grok-4-fast");
    });

    test("honours a per-account endpoint", async () => {
        const binding = await aiProxyPlugin.bind({
            account: account({ endpoint: "http://10.0.0.2:9000/v1" }),
        });

        expect(modelIdOf(binding.language("x"))).toBe("x");
    });

    /**
     * The proxy key is not conventional enough to have an env variable, so an
     * account without one must say so rather than fall back to something ambient.
     */
    test("refuses to bind without a client key", async () => {
        const promise = aiProxyPlugin.bind({ account: account({ credentials: {} }) });

        await expect(promise).rejects.toThrow(CredentialUnavailableError);
        await expect(promise).rejects.toThrow(/tools ai config secret set/);
    });

    test("declares no env variables at all", () => {
        expect(aiProxyPlugin.credential.envKeys).toEqual([]);
        expect(aiProxyPlugin.credential.required).toEqual(["apiKey"]);
    });
});
