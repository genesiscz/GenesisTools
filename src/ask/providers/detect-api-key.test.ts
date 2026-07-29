import { afterEach, describe, expect, test } from "bun:test";
import { detectApiKeyFor } from "@ask/providers/ProviderManager";
import { env } from "@genesiscz/utils/env";

/**
 * Pins the single behavior-changing line of the Phase 2 priority flip: which
 * key provider detection spends when BOTH a configured account and an ambient
 * environment variable exist. Before the flip the env var won, so configuring
 * an account did not change whose money a call cost.
 */

const CONFIG = { name: "openai", envKey: "OPENAI_API_KEY" };

function aiConfigWith(key: string | undefined) {
    return { getProviderApiKey: (name: string) => (name === "openai" ? key : undefined) };
}

afterEach(() => {
    env.testing.unset("OPENAI_API_KEY");
});

describe("detectApiKeyFor", () => {
    test("the configured account outranks the environment", () => {
        env.testing.set("OPENAI_API_KEY", "sk-env");

        expect(detectApiKeyFor(aiConfigWith("sk-account"), CONFIG)).toBe("sk-account");
    });

    test("the environment still resolves when no account holds a key", () => {
        env.testing.set("OPENAI_API_KEY", "sk-env");

        expect(detectApiKeyFor(aiConfigWith(undefined), CONFIG)).toBe("sk-env");
    });

    test("no account and no variable resolves nothing", () => {
        expect(detectApiKeyFor(aiConfigWith(undefined), CONFIG)).toBeUndefined();
    });
});
