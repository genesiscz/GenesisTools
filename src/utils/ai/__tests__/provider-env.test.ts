import { describe, expect, it } from "bun:test";
import { collectConfiguredProviderEnv, PROVIDER_API_KEY_ENV_KEYS } from "@genesiscz/utils/ai/provider-env";
import { env } from "@genesiscz/utils/env";

const ALL_UNSET = Object.fromEntries(PROVIDER_API_KEY_ENV_KEYS.map((key) => [key, undefined]));

describe("collectConfiguredProviderEnv", () => {
    it("returns only the provider keys that are set", async () => {
        await env.testing.withOverrides({ ...ALL_UNSET, X_AI_API_KEY: "xai-test", OPENAI_API_KEY: "oai-test" }, () => {
            expect(collectConfiguredProviderEnv()).toEqual({ X_AI_API_KEY: "xai-test", OPENAI_API_KEY: "oai-test" });
        });
    });

    it("omits blank values instead of forwarding an empty key", async () => {
        await env.testing.withOverrides({ ...ALL_UNSET, XAI_API_KEY: "   ", ANTHROPIC_API_KEY: "ant-test" }, () => {
            expect(collectConfiguredProviderEnv()).toEqual({ ANTHROPIC_API_KEY: "ant-test" });
        });
    });

    it("ignores env vars outside the provider list", async () => {
        await env.testing.withOverrides({ ...ALL_UNSET, SOME_OTHER_SECRET: "nope" }, () => {
            expect(collectConfiguredProviderEnv()).toEqual({});
        });
    });
});
