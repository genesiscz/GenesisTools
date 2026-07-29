import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { env } from "@genesiscz/utils/env";
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
        await expect(promise).rejects.toThrow("tools ai config account add --provider openai");
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
