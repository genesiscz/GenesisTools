import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    secrets,
} from "@genesiscz/utils/security";
import type { AccountEntry } from "../config/schema";
import { CredentialUnavailableError, describeCredential, resolveCredential } from "./credentials";
import type { CredentialSpec } from "./plugin-types";

const KEY = randomBytes(32);

function fakeKeyring() {
    return [
        {
            id: "keychain" as const,
            available: async () => true,
            get: async () => KEY,
            getSync: () => KEY,
            set: async () => {},
        },
    ];
}

const SPEC: CredentialSpec = {
    fields: ["apiKey"],
    envKeys: ["XAI_API_KEY", "X_AI_API_KEY"],
    required: ["apiKey"],
};

function account(overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id: "acc_xai",
        name: "xai-api",
        provider: "xai",
        enabled: true,
        billing: { mode: "metered" },
        credentials: {},
        useEnvApiKey: false,
        ...overrides,
    };
}

beforeEach(() => {
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "gt-cred-")));
    _setMasterKeyProvidersForTest(fakeKeyring());
    _resetSecretsForTest();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    env.testing.unset("XAI_API_KEY");
    env.testing.unset("X_AI_API_KEY");
    env.testing.unset("MY_CUSTOM_XAI_KEY");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
});

describe("resolveCredential", () => {
    test("reads a vaulted key and reports the vault as its source", async () => {
        const ref = await (await secrets()).set("ai/acc_xai/apiKey", "xai-from-vault");

        const resolved = await resolveCredential(account({ credentials: { apiKey: ref } }), SPEC);

        expect(resolved.apiKey).toBe("xai-from-vault");
        expect(resolved.source).toBe("vault");
    });

    test("a configured account WINS over an ambient environment variable", async () => {
        const ref = await (await secrets()).set("ai/acc_xai/apiKey", "xai-from-vault");
        env.testing.set("XAI_API_KEY", "xai-from-env");

        const resolved = await resolveCredential(
            account({ credentials: { apiKey: ref }, useEnvApiKey: true }),
            SPEC
        );

        // The old ProviderManager did the opposite, so you could not tell which
        // key was being spent when both existed.
        expect(resolved.apiKey).toBe("xai-from-vault");
        expect(resolved.source).toBe("vault");
    });

    test("the environment is ignored entirely when the account has not opted in", async () => {
        env.testing.set("XAI_API_KEY", "xai-from-env");

        expect(resolveCredential(account(), SPEC)).rejects.toThrow(CredentialUnavailableError);
    });

    test("useEnvApiKey true tries the plugin's declared variables in order", async () => {
        env.testing.set("X_AI_API_KEY", "second-choice");

        const resolved = await resolveCredential(account({ useEnvApiKey: true }), SPEC);

        expect(resolved.apiKey).toBe("second-choice");
        expect(resolved.source).toBe("env");
        expect(resolved.envKey).toBe("X_AI_API_KEY");
    });

    test("useEnvApiKey as a string restricts resolution to that one variable", async () => {
        env.testing.set("XAI_API_KEY", "primary");
        env.testing.set("X_AI_API_KEY", "alias");

        const resolved = await resolveCredential(account({ useEnvApiKey: "X_AI_API_KEY" }), SPEC);

        expect(resolved.apiKey).toBe("alias");
        expect(resolved.envKey).toBe("X_AI_API_KEY");
    });

    // Deliberately permissive: v3's `apiKeyEnv` read whatever variable the account
    // named, and the v4 migration copies those names verbatim. Restricting
    // resolution to the plugin's declared list would silently break every account
    // pointing at a custom variable. The plugin list is the DEFAULT for
    // `useEnvApiKey: true`, not a whitelist — and either way the choice is now
    // visible in config instead of happening inside an SDK.
    test("an explicitly named variable is honored even if the plugin does not declare it", async () => {
        env.testing.set("MY_CUSTOM_XAI_KEY", "custom-value");

        const resolved = await resolveCredential(account({ useEnvApiKey: "MY_CUSTOM_XAI_KEY" }), SPEC);

        expect(resolved.apiKey).toBe("custom-value");
        expect(resolved.envKey).toBe("MY_CUSTOM_XAI_KEY");
    });

    test("naming a variable that is not set still fails loudly", async () => {
        expect(resolveCredential(account({ useEnvApiKey: "UNSET_VARIABLE" }), SPEC)).rejects.toThrow(
            CredentialUnavailableError
        );
    });

    test("the error names the exact commands that fix it", async () => {
        try {
            await resolveCredential(account(), SPEC);
            throw new Error("expected a CredentialUnavailableError");
        } catch (err) {
            const message = (err as Error).message;
            expect(message).toContain("tools ai config secret set ai/acc_xai/apiKey");
            expect(message).toContain("--use-env XAI_API_KEY or X_AI_API_KEY");
        }
    });

    test("auth-file providers resolve a path, not a secret", async () => {
        const spec: CredentialSpec = { fields: ["authFile"], envKeys: [], required: ["authFile"] };

        const resolved = await resolveCredential(
            account({ provider: "grok-sub", credentials: { authFile: "~/.grok/auth.json" } }),
            spec
        );

        expect(resolved.authFile).toBe("~/.grok/auth.json");
        expect(resolved.source).toBe("file");
    });
});

describe("describeCredential", () => {
    test("reports the source without revealing the value", async () => {
        env.testing.set("XAI_API_KEY", "secret-value");

        const described = await describeCredential(account({ useEnvApiKey: true }), SPEC);

        expect(described.ok).toBe(true);
        expect(described.detail).toBe("env (XAI_API_KEY)");
        expect(SafeString(described)).not.toContain("secret-value");
    });

    test("reports a failure instead of throwing", async () => {
        const described = await describeCredential(account(), SPEC);

        expect(described.ok).toBe(false);
        expect(described.detail).toContain("missing apiKey");
    });
});

function SafeString(value: unknown): string {
    return Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(" ");
}
