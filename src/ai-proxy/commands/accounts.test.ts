import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAccountsAllowEnv, runAccountsSetKey } from "@app/ai-proxy/commands/accounts";
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
