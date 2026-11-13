import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { lastProviderFailure, providerUnavailableResponse, tryCreateProvider } from "@app/ai-proxy/lib/providers/pool";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";
import { providerClassModulesLoadedByTable } from "../../../../scripts/ci/proxy-provider-ratchet";

const account: AiProxyAccountConfig = {
    name: "work",
    provider: "xai-api-key",
    providerSlug: "xai",
    enabled: true,
    apiKeyEnv: "AI_PROXY_REGISTRY_TEST_KEY",
};

describe("provider construction failures", () => {
    it("remembers why an account could not be built and answers 503 with the reason", async () => {
        env.testing.unset("AI_PROXY_REGISTRY_TEST_KEY");
        env.testing.unset("XAI_API_KEY");
        env.testing.unset("X_AI_API_KEY");

        const provider = await tryCreateProvider(account);
        expect(provider).toBeNull();
        expect(lastProviderFailure("work/xai")).toContain("No xAI API key found");

        const response = providerUnavailableResponse({ accountName: "work", providerSlug: "xai" });
        expect(response.status).toBe(503);

        const body = (await response.json()) as { error: { message: string; code: string } };
        expect(body.error.code).toBe("provider_not_loaded");
        expect(body.error.message).toContain("Provider not loaded: work/xai");
        expect(body.error.message).toContain("No xAI API key found");
    });

    it("reports the opt-in refusal as the reason when the key only exists in the environment", async () => {
        env.testing.set("AI_PROXY_REGISTRY_TEST_KEY", "billed-key");

        try {
            expect(await tryCreateProvider(account)).toBeNull();
            expect(lastProviderFailure("work/xai")).toContain("Refusing to spend the ambient");
        } finally {
            env.testing.unset("AI_PROXY_REGISTRY_TEST_KEY");
        }
    });
});

describe("the provider definition table", () => {
    // A fresh process, because the tests above build providers in this one, which loads their classes.
    it("loads no provider class when the table and the config are imported", () => {
        expect(providerClassModulesLoadedByTable(resolve(import.meta.dir, "../../../.."))).toEqual([]);
    });
});
