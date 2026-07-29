import { describe, expect, it } from "bun:test";
import { assertApiKeySourceAllowed } from "@app/ai-proxy/lib/providers/api-key-guard";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";

const account: AiProxyAccountConfig = {
    name: "work",
    provider: "xai-api-key",
    providerSlug: "xai",
    enabled: true,
};

describe("assertApiKeySourceAllowed", () => {
    it("allows a key stored on the account", () => {
        expect(() => assertApiKeySourceAllowed({ account, source: "config", envName: "XAI_API_KEY" })).not.toThrow();
    });

    it("refuses an environment key that was never opted in to", () => {
        expect(() => assertApiKeySourceAllowed({ account, source: "defaultEnv", envName: "XAI_API_KEY" })).toThrow(
            /Refusing to spend the ambient XAI_API_KEY/
        );
    });

    it("refuses the config-named env var too", () => {
        expect(() => assertApiKeySourceAllowed({ account, source: "configEnv", envName: "MY_XAI_KEY" })).toThrow(
            /MY_XAI_KEY/
        );
    });

    it("allows an environment key once the account opts in", () => {
        expect(() =>
            assertApiKeySourceAllowed({
                account: { ...account, allowEnvApiKey: true },
                source: "defaultEnv",
                envName: "XAI_API_KEY",
            })
        ).not.toThrow();
    });
});
