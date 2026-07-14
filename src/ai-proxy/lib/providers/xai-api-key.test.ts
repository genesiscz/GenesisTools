import { describe, expect, it } from "bun:test";
import { resolveXaiApiKey } from "@app/ai-proxy/lib/providers/xai-api-key-auth";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { env } from "@app/utils/env";

const account: AiProxyAccountConfig = {
    name: "work",
    provider: "xai-api-key",
    providerSlug: "xai",
    enabled: true,
    apiKeyEnv: "XAI_API_KEY",
};

describe("resolveXaiApiKey", () => {
    it("reads the env var named in account.apiKeyEnv", () => {
        env.testing.set("XAI_API_KEY", "test-key-from-named");
        env.testing.unset("X_AI_API_KEY");

        try {
            expect(resolveXaiApiKey(account)).toBe("test-key-from-named");
        } finally {
            env.testing.unset("XAI_API_KEY");
        }
    });

    it("falls back to standard xAI aliases when named env is empty", () => {
        env.testing.unset("XAI_API_KEY");
        env.testing.set("X_AI_API_KEY", "legacy-alias-key");

        try {
            expect(resolveXaiApiKey({ ...account, apiKeyEnv: "XAI_API_KEY" })).toBe("legacy-alias-key");
        } finally {
            env.testing.unset("X_AI_API_KEY");
        }
    });
});
