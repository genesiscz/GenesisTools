import { describe, expect, it } from "bun:test";
import { assertApiKeySourceAllowed, resolveAccountApiKey } from "@app/ai-proxy/lib/providers/api-key-guard";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";

const account: AiProxyAccountConfig = {
    name: "work",
    provider: "xai-api-key",
    providerSlug: "xai",
    enabled: true,
};

const KNOWN_ENV_NAMES = ["XAI_API_KEY", "X_AI_API_KEY"];

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

    it("still allows a stored key when the account ALSO opted in to the environment", () => {
        // Both fields set is a config the CLI never writes, but a hand-edited
        // file can carry it. The stored key wins, so the guard sees "config".
        const both: AiProxyAccountConfig = { ...account, apiKey: "config-key", allowEnvApiKey: true };
        const resolved = resolveAccountApiKey({
            account: both,
            defaultEnvKey: () => "env-key",
            knownEnvNames: KNOWN_ENV_NAMES,
        });

        expect(resolved).toEqual({ key: "config-key", source: "config" });
        expect(() =>
            assertApiKeySourceAllowed({ account: both, source: "config", envName: "XAI_API_KEY" })
        ).not.toThrow();
    });
});

describe("resolveAccountApiKey", () => {
    it("labels the provider default as defaultEnv, not as the account's named var", () => {
        // The mislabel this replaces mattered: an account with no `apiKeyEnv`
        // reported "configEnv" for a key that came from the provider default.
        expect(
            resolveAccountApiKey({ account, defaultEnvKey: () => "default-key", knownEnvNames: KNOWN_ENV_NAMES })
        ).toEqual({
            key: "default-key",
            source: "defaultEnv",
        });
    });

    it("prefers the env var the account names over the provider default", () => {
        env.testing.set("XAI_API_KEY", "named-key");

        try {
            expect(
                resolveAccountApiKey({
                    account: { ...account, apiKeyEnv: "XAI_API_KEY" },
                    defaultEnvKey: () => "default-key",
                    knownEnvNames: KNOWN_ENV_NAMES,
                })
            ).toEqual({ key: "named-key", source: "configEnv" });
        } finally {
            env.testing.unset("XAI_API_KEY");
        }
    });

    it("falls through to the provider default when the account's named var is a known alias but unset", () => {
        // XAI_API_KEY and X_AI_API_KEY name the SAME credential (a legacy
        // spelling), so this is not a customization — the provider's own
        // alias-aware default still describes this account's intent.
        env.testing.unset("XAI_API_KEY");

        expect(
            resolveAccountApiKey({
                account: { ...account, apiKeyEnv: "XAI_API_KEY" },
                defaultEnvKey: () => "default-key",
                knownEnvNames: KNOWN_ENV_NAMES,
            })
        ).toEqual({ key: "default-key", source: "defaultEnv" });
    });

    it("does NOT fall through to the provider default when the account names a genuinely different var", () => {
        // The account named MY_NAMED_KEY on purpose — usually to run two accounts
        // against two different keys, and it is not an alias of XAI_API_KEY/
        // X_AI_API_KEY. Falling through to the provider default here would
        // silently bill whichever key that other var happens to hold, which is
        // exactly the "rotated/borrowed key spent by surprise" failure this
        // whole guard exists to prevent.
        env.testing.unset("MY_NAMED_KEY");

        expect(
            resolveAccountApiKey({
                account: { ...account, apiKeyEnv: "MY_NAMED_KEY" },
                defaultEnvKey: () => "default-key",
                knownEnvNames: KNOWN_ENV_NAMES,
            })
        ).toBeUndefined();
    });

    it("does NOT fall through when that different var is exported but empty, either", () => {
        // `export MY_NAMED_KEY=` in a shell rc is the realistic footgun here: the
        // variable exists, so a `has()`-style check would accept it and hand the
        // provider an empty bearer token.
        env.testing.set("MY_NAMED_KEY", "   ");

        try {
            expect(
                resolveAccountApiKey({
                    account: { ...account, apiKeyEnv: "MY_NAMED_KEY" },
                    defaultEnvKey: () => "default-key",
                    knownEnvNames: KNOWN_ENV_NAMES,
                })
            ).toBeUndefined();
        } finally {
            env.testing.unset("MY_NAMED_KEY");
        }
    });

    it("ignores a whitespace-only stored key the same way", () => {
        expect(
            resolveAccountApiKey({
                account: { ...account, apiKey: "  " },
                defaultEnvKey: () => "default-key",
                knownEnvNames: KNOWN_ENV_NAMES,
            })
        ).toEqual({ key: "default-key", source: "defaultEnv" });
    });

    it("returns undefined when nothing carries a key", () => {
        expect(
            resolveAccountApiKey({ account, defaultEnvKey: () => undefined, knownEnvNames: KNOWN_ENV_NAMES })
        ).toBeUndefined();
    });
});
