import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { env } from "@genesiscz/utils/env";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    type MasterKeyProvider,
    secrets,
} from "@genesiscz/utils/security";
import { AiConfigStore } from "../config/AiConfigStore";
import { emptyConfig } from "../config/schema";
import { CredentialUnavailableError } from "./credentials";
import { providerApiKey, resolveProviderApiKey } from "./resolve";

/**
 * The ladder these tests pin is the whole point of the phase: a key must come
 * from a place a user can see. Before it, `createOpenAI()` with no arguments
 * read OPENAI_API_KEY inside the SDK, so "where did this key come from" had no
 * answer at all — and for openai-compatible providers it was the WRONG key,
 * shipped to openrouter.ai / api.x.ai.
 *
 * The tests run against a sandboxed GENESIS_TOOLS_HOME (the preload sets it), so
 * writing accounts here never touches the real config.
 */

async function withAccount(fn: () => Promise<void>): Promise<void> {
    const store = await AiConfigStore.load();

    await store.mutate((data) => {
        data.accounts.push({
            id: "acc_openai_test",
            name: "openai-test",
            provider: "openai",
            enabled: true,
            billing: { mode: "metered" },
            credentials: { apiKey: "sk-from-the-account" },
            useEnvApiKey: false,
        });
    });

    try {
        await fn();
    } finally {
        await store.mutate((data) => {
            data.accounts = emptyConfig().accounts;
        });
    }
}

beforeEach(() => {
    AiConfigStore.invalidate();
});

afterEach(() => {
    AiConfigStore.invalidate();
    env.testing.unset("OPENAI_API_KEY");
    env.testing.unset("OPENROUTER_API_KEY");
});

describe("resolveProviderApiKey", () => {
    test("a configured account outranks an ambient variable", async () => {
        env.testing.set("OPENAI_API_KEY", "sk-from-the-environment");

        await withAccount(async () => {
            const resolved = await resolveProviderApiKey("openai");

            expect(resolved.apiKey).toBe("sk-from-the-account");
            expect(resolved.source).not.toBe("env");
        });
    });

    test("an account that opts in reads the variable it names", async () => {
        env.testing.set("OPENAI_API_KEY", "sk-from-the-environment");

        const store = await AiConfigStore.load();
        await store.mutate((data) => {
            data.accounts.push({
                id: "acc_openai_env",
                name: "openai-env",
                provider: "openai",
                enabled: true,
                billing: { mode: "metered" },
                credentials: {},
                useEnvApiKey: ["OPENAI_API_KEY"],
            });
        });

        try {
            const resolved = await resolveProviderApiKey("openai");

            expect(resolved.apiKey).toBe("sk-from-the-environment");
            expect(resolved.source).toBe("env");
            expect(resolved.envKey).toBe("OPENAI_API_KEY");
        } finally {
            await store.mutate((data) => {
                data.accounts = emptyConfig().accounts;
            });
        }
    });

    /**
     * The grandfather clause. Every setup that worked off a bare exported
     * variable keeps working — it is now merely logged rather than invisible.
     */
    test("a declared variable still resolves when no account exists at all", async () => {
        env.testing.set("OPENAI_API_KEY", "sk-grandfathered");

        const resolved = await resolveProviderApiKey("openai");

        expect(resolved.apiKey).toBe("sk-grandfathered");
        expect(resolved.source).toBe("env");
    });

    test("no account and no variable names the command that fixes it", async () => {
        const promise = resolveProviderApiKey("openai");

        await expect(promise).rejects.toThrow(CredentialUnavailableError);
        await expect(promise).rejects.toThrow(
            `printf '%s' "$OPENAI_API_KEY" | tools ai config account add --provider openai --name openai --api-key-stdin`
        );
    });

    /**
     * A keyless account needs a key of its own. A second account would not fix
     * it: the model ladder binds the first account for a provider. And `secret
     * set` writes the vault entry without linking it, so it must not be offered.
     */
    test("a keyless account is told to take a key with account edit, never secret set", async () => {
        const store = await AiConfigStore.load();
        await store.mutate((data) => {
            data.accounts.push({
                id: "acc_openai_env",
                name: "openai-env",
                provider: "openai",
                enabled: true,
                billing: { mode: "metered" },
                credentials: {},
                useEnvApiKey: ["OPENAI_API_KEY"],
            });
        });

        try {
            const message = await resolveProviderApiKey("openai").then(
                () => "resolved unexpectedly",
                (err: unknown) => (err instanceof Error ? err.message : String(err))
            );

            expect(message).toContain("no key in account openai-env");
            expect(message).toContain(
                `printf '%s' "$OPENAI_API_KEY" | tools ai config account edit openai-env --api-key-stdin`
            );
            expect(message).not.toContain("secret set");
            expect(message).not.toContain("account add");
        } finally {
            await store.mutate((data) => {
                data.accounts = emptyConfig().accounts;
            });
        }
    });

    /**
     * The misrouting bug: openrouter has no key, but OPENAI_API_KEY is exported.
     * The old openai-compatible branch passed `apiKey: undefined`, the SDK filled
     * in OPENAI_API_KEY, and the user's OpenAI key went to openrouter.ai.
     */
    test("one provider's variable never satisfies another provider", async () => {
        env.testing.set("OPENAI_API_KEY", "sk-openai-only");

        await expect(resolveProviderApiKey("openrouter")).rejects.toThrow(CredentialUnavailableError);
    });

    test("providerApiKey returns the key itself", async () => {
        env.testing.set("OPENROUTER_API_KEY", "or-key");

        expect(await providerApiKey("openrouter")).toBe("or-key");
    });
});

/**
 * The gate-only account (`tools ai gate` hands its key to Genesis after Touch ID) must be invisible
 * to this ladder. A terminal with XAI_API_KEY must keep stopping at the env account, and a process
 * WITHOUT the variable (an app, a launchd job) must not fall through to the gate-only account: that
 * would open the vault under a new `gt-<tool>` name and raise a keychain prompt at a random moment.
 */
describe("resolveProviderApiKey and gate-only accounts", () => {
    const MASTER = randomBytes(32);
    let vaultOpens = 0;

    /** Counts every master-key read. It must not throw: the ladder swallows a failing account. */
    const keyring: MasterKeyProvider = {
        id: "keychain",
        available: async () => true,
        get: async () => {
            vaultOpens++;
            return MASTER;
        },
        getSync: () => {
            vaultOpens++;
            return MASTER;
        },
        set: async () => {},
    };

    async function withXaiAccounts(tags: string[] | undefined, fn: () => Promise<void>): Promise<void> {
        _setMasterKeyProvidersForTest([keyring]);
        _resetSecretsForTest();
        const ref = await (await secrets()).set("ai/acc_xai_gate/apiKey", "xai-stored-for-the-gate");
        _resetSecretsForTest();
        _setMasterKeyProvidersForTest([keyring]);
        vaultOpens = 0;

        const store = await AiConfigStore.load();
        await store.mutate((data) => {
            data.accounts.push(
                {
                    id: "acc_xai_env",
                    name: "xai-env",
                    provider: "xai",
                    enabled: true,
                    billing: { mode: "metered" },
                    credentials: {},
                    useEnvApiKey: ["XAI_API_KEY"],
                },
                {
                    id: "acc_xai_gate",
                    name: "xai-gate",
                    provider: "xai",
                    enabled: true,
                    ...(tags ? { tags } : {}),
                    billing: { mode: "metered" },
                    credentials: { apiKey: ref },
                    useEnvApiKey: false,
                }
            );
        });

        try {
            // The runner inherits the shell's exports; each test sets the variable it means to have.
            await env.testing.withOverrides({ XAI_API_KEY: undefined, X_AI_API_KEY: undefined }, fn);
        } finally {
            await store.mutate((data) => {
                data.accounts = emptyConfig().accounts;
            });
            _resetMasterKeyProviders();
            _resetSecretsForTest();
        }
    }

    test("a terminal with XAI_API_KEY stops at the env account and never opens the vault", async () => {
        await withXaiAccounts(["gate-only"], async () => {
            env.testing.set("XAI_API_KEY", "xai-from-the-terminal");

            const resolved = await resolveProviderApiKey("xai");

            expect(resolved).toMatchObject({ apiKey: "xai-from-the-terminal", source: "env", envKey: "XAI_API_KEY" });
            expect(vaultOpens).toBe(0);
        });
    });

    test("without the variable the gate-only account is skipped: no vault read, and the error names the env account", async () => {
        await withXaiAccounts(["gate-only"], async () => {
            const message = await resolveProviderApiKey("xai").then(
                () => "resolved unexpectedly",
                (err: unknown) => (err instanceof Error ? err.message : String(err))
            );

            expect(message).toContain("no key in account xai-env");
            expect(message).not.toContain("xai-gate");
            expect(vaultOpens).toBe(0);
        });
    });

    test("the same account WITHOUT the tag still serves its stored key (negative control)", async () => {
        await withXaiAccounts(undefined, async () => {
            const resolved = await resolveProviderApiKey("xai");

            expect(resolved).toMatchObject({ apiKey: "xai-stored-for-the-gate", source: "vault" });
            expect(vaultOpens).toBeGreaterThan(0);
        });
    });
});
