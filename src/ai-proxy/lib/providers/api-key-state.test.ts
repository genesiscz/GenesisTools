import { describe, expect, it } from "bun:test";
import {
    apiKeyStatus,
    defaultApiKeyEnvName,
    findEnvSourceFile,
    maskApiKey,
} from "@app/ai-proxy/lib/providers/api-key-state";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";

const account: AiProxyAccountConfig = {
    name: "work",
    provider: "xai-api-key",
    providerSlug: "xai",
    enabled: true,
};

describe("apiKeyStatus", () => {
    it("reports a stored key as an override, masked", () => {
        const status = apiKeyStatus({ ...account, apiKey: "xai-abcdefghijklmnop" });

        expect(status.state).toBe("override");
        expect(status.maskedOverride).toBe("xai-…mnop");
    });

    it("reports the env state once the account opts in", () => {
        env.testing.set("XAI_API_KEY", "from-env");

        try {
            const status = apiKeyStatus({ ...account, allowEnvApiKey: true });

            expect(status.state).toBe("env");
            expect(status.envName).toBe("XAI_API_KEY");
            expect(status.envPresent).toBe(true);
        } finally {
            env.testing.unset("XAI_API_KEY");
        }
    });

    it("reports no credential when neither is configured, and still names the env var", () => {
        // BOTH aliases: the name is now alias-aware, so leaving a stray
        // `X_AI_API_KEY` in the ambient environment would decide this assertion.
        env.testing.unset("XAI_API_KEY");
        env.testing.unset("X_AI_API_KEY");
        const status = apiKeyStatus(account);

        expect(status.state).toBe("none");
        expect(status.envName).toBe("XAI_API_KEY");
        expect(status.envPresent).toBe(false);
        expect(status.maskedOverride).toBeUndefined();
    });

    it("names the provider's default env var, or the configured one", () => {
        env.testing.unset("XAI_API_KEY");
        env.testing.unset("X_AI_API_KEY");

        expect(defaultApiKeyEnvName(account)).toBe("XAI_API_KEY");
        expect(defaultApiKeyEnvName({ ...account, provider: "openai" })).toBe("OPENAI_API_KEY");
        expect(defaultApiKeyEnvName({ ...account, apiKeyEnv: "MY_KEY" })).toBe("MY_KEY");
    });

    it("names the legacy alias when that is the variable actually carrying the key", () => {
        // Reporting "XAI_API_KEY" here would send the user to a variable they
        // never set, while the guard spends the one they did.
        env.testing.unset("XAI_API_KEY");
        env.testing.set("X_AI_API_KEY", "legacy-alias-key");

        try {
            expect(defaultApiKeyEnvName(account)).toBe("X_AI_API_KEY");
        } finally {
            env.testing.unset("X_AI_API_KEY");
        }
    });

    it("never reveals a short key", () => {
        expect(maskApiKey("short")).toBe("****");
    });
});

describe("findEnvSourceFile", () => {
    it("treats a regex-shaped env name as literal instead of throwing", async () => {
        // `apiKeyEnv` is an unvalidated config value, and this runs inside the
        // interactive `accounts set-key` prompt where a throw is user-visible.
        expect(await findEnvSourceFile("KEY(")).toBeUndefined();
    });
});
