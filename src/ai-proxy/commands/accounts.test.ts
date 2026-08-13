import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAccountsAllowEnv, runAccountsSetKey, runAccountsSetRouting } from "@app/ai-proxy/commands/accounts";
import { loadConfig, saveConfig } from "@app/ai-proxy/lib/config";
import { resetAiProxyConfigStore } from "@app/ai-proxy/lib/config-store";
import { resetAiProxyStorage } from "@app/ai-proxy/lib/storage";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { env } from "@genesiscz/utils/env";

/**
 * These cover the non-interactive halves of `accounts set-key` / `allow-env` —
 * the ones that decide, without a human in the loop, whether an account may
 * spend a billed key. The clack chooser itself is not driven here; every state
 * it can leave behind is reachable through these two entry points.
 *
 * `isInteractive()` is false under the test runner (no TTY), which is exactly
 * the branch a script or a daemon takes.
 */

const originalHome = env.get("GENESIS_TOOLS_HOME");
let tempDir: string;

function account(overrides: Partial<AiProxyAccountConfig> = {}): AiProxyAccountConfig {
    return { name: "work", provider: "xai-api-key", providerSlug: "xai", enabled: true, ...overrides };
}

async function seed(...accounts: AiProxyAccountConfig[]): Promise<void> {
    const config = await loadConfig();
    config.accounts = accounts;
    await saveConfig(config);
}

async function readAccount(name: string): Promise<AiProxyAccountConfig | undefined> {
    return (await loadConfig()).accounts.find((item) => item.name === name);
}

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ai-proxy-accounts-"));
    env.testing.set("GENESIS_TOOLS_HOME", tempDir);
    resetAiProxyConfigStore();
    resetAiProxyStorage();
});

afterEach(() => {
    resetAiProxyConfigStore();
    resetAiProxyStorage();
    rmSync(tempDir, { recursive: true, force: true });

    if (originalHome === undefined) {
        env.testing.unset("GENESIS_TOOLS_HOME");
    } else {
        env.testing.set("GENESIS_TOOLS_HOME", originalHome);
    }
});

describe("runAccountsSetKey", () => {
    it("stores a key given on argv and drops any environment opt-in", async () => {
        await seed(account({ allowEnvApiKey: true }));

        await runAccountsSetKey("work", "xai-secret-value");

        const stored = await readAccount("work");
        expect(stored?.apiKey).toBe("xai-secret-value");
        // Both fields set would claim two different intentions; the stored key
        // wins at resolve time, so the opt-in has to go.
        expect(stored?.allowEnvApiKey).toBeUndefined();
    });

    it("trims the key so a stray space cannot become part of the credential", async () => {
        await seed(account());

        await runAccountsSetKey("work", "  xai-secret-value  ");

        expect((await readAccount("work"))?.apiKey).toBe("xai-secret-value");
    });

    it("changes nothing for an OAuth account, which has no api key to set", async () => {
        await seed(account({ name: "grok", provider: "grok-subscription", providerSlug: "grok" }));

        await runAccountsSetKey("grok", "should-not-land");

        expect((await readAccount("grok"))?.apiKey).toBeUndefined();
    });

    it("changes nothing for an account that does not exist", async () => {
        await seed(account());

        await runAccountsSetKey("missing", "should-not-land");

        expect((await loadConfig()).accounts).toHaveLength(1);
        expect((await readAccount("work"))?.apiKey).toBeUndefined();
    });

    it("leaves the account untouched when no key is given and there is no terminal to ask on", async () => {
        await seed(account({ apiKey: "existing-key" }));

        await runAccountsSetKey("work", undefined);

        expect((await readAccount("work"))?.apiKey).toBe("existing-key");
    });
});

describe("runAccountsAllowEnv", () => {
    it("opts the account in and removes a stored key that would have won anyway", async () => {
        await seed(account({ apiKey: "stored-key" }));

        await runAccountsAllowEnv("work", true);

        const stored = await readAccount("work");
        expect(stored?.allowEnvApiKey).toBe(true);
        expect(stored?.apiKey).toBeUndefined();
    });

    it("revokes the opt-in, leaving the account with no credential at all", async () => {
        await seed(account({ allowEnvApiKey: true }));

        await runAccountsAllowEnv("work", false);

        const stored = await readAccount("work");
        expect(stored?.allowEnvApiKey).toBeUndefined();
        expect(stored?.apiKey).toBeUndefined();
    });

    it("refuses to opt in an OAuth account", async () => {
        await seed(account({ name: "grok", provider: "grok-subscription", providerSlug: "grok" }));

        await runAccountsAllowEnv("grok", true);

        expect((await readAccount("grok"))?.allowEnvApiKey).toBeUndefined();
    });
});

function openrouterAccount(overrides: Partial<AiProxyAccountConfig> = {}): AiProxyAccountConfig {
    return account({ name: "router", provider: "openrouter", providerSlug: "openrouter", ...overrides });
}

describe("runAccountsSetRouting", () => {
    it("writes a provider pin onto an account with no prior routing config", async () => {
        await seed(openrouterAccount());

        await runAccountsSetRouting("router", { order: ["Morph", "DeepInfra"], allowFallbacks: false }, {});

        const stored = await readAccount("router");
        expect(stored?.openrouter?.provider).toEqual({ order: ["Morph", "DeepInfra"], allow_fallbacks: false });
    });

    it("merges into an existing routing config without clobbering the models filter", async () => {
        await seed(
            openrouterAccount({
                openrouter: {
                    models: { include: ["anthropic/*"] },
                    provider: { order: ["Morph"], allow_fallbacks: false },
                },
            })
        );

        await runAccountsSetRouting("router", { ignore: ["Together"] }, {});

        const stored = await readAccount("router");
        expect(stored?.openrouter?.models).toEqual({ include: ["anthropic/*"] });
        // order/allow_fallbacks were not part of this patch and must survive.
        expect(stored?.openrouter?.provider).toEqual({
            order: ["Morph"],
            allow_fallbacks: false,
            ignore: ["Together"],
        });
    });

    it("sets the fallbackModels list independently of the provider block", async () => {
        await seed(openrouterAccount());

        await runAccountsSetRouting("router", { fallbackModels: ["a/b", "c/d"] }, {});

        const stored = await readAccount("router");
        expect(stored?.openrouter?.fallbackModels).toEqual(["a/b", "c/d"]);
        // No provider fields were patched and none pre-existed — no stray `provider: {}`.
        expect(stored?.openrouter?.provider).toBeUndefined();
    });

    it("--clear removes the pin but keeps an unrelated models filter", async () => {
        await seed(
            openrouterAccount({
                openrouter: {
                    models: { include: ["anthropic/*"] },
                    provider: { order: ["Morph"], allow_fallbacks: false },
                    fallbackModels: ["a/b"],
                },
            })
        );

        await runAccountsSetRouting("router", {}, { clear: true });

        const stored = await readAccount("router");
        expect(stored?.openrouter?.provider).toBeUndefined();
        expect(stored?.openrouter?.fallbackModels).toBeUndefined();
        expect(stored?.openrouter?.models).toEqual({ include: ["anthropic/*"] });
    });

    it("--clear drops the whole openrouter block when nothing else is left", async () => {
        await seed(openrouterAccount({ openrouter: { provider: { order: ["Morph"] } } }));

        await runAccountsSetRouting("router", {}, { clear: true });

        expect((await readAccount("router"))?.openrouter).toBeUndefined();
    });

    it("changes nothing when no routing fields and no --clear are given", async () => {
        await seed(openrouterAccount({ openrouter: { provider: { order: ["Morph"] } } }));

        await runAccountsSetRouting("router", {}, {});

        expect((await readAccount("router"))?.openrouter?.provider).toEqual({ order: ["Morph"] });
    });

    it("refuses to pin routing on a non-openrouter account", async () => {
        await seed(account({ provider: "xai-api-key" }));

        await runAccountsSetRouting("work", { order: ["Morph"] }, {});

        expect((await readAccount("work"))?.openrouter).toBeUndefined();
    });

    it("changes nothing for an account that does not exist", async () => {
        await seed(openrouterAccount());

        await runAccountsSetRouting("missing", { order: ["Morph"] }, {});

        expect((await loadConfig()).accounts).toHaveLength(1);
    });
});
