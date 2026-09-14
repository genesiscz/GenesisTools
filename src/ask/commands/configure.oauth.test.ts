import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RunLoginOptions, RunLoginResult } from "@app/ai/lib/accounts/run-login";
import { loadAskConfig, saveAskConfig } from "@ask/config";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { addViaOAuthFlow, linkAskConfigToAccount } from "./configure";

/**
 * PR #368 review t3. The wizard used to run its own authorization round trip and
 * write through the deprecated `AIConfig` facade, so none of the login guards
 * reached it: a name guessed from the token's email could replace another
 * provider's account, and a contradicted identity overwrote the stored one.
 *
 * The login core is injected rather than mocked at the module registry, which is
 * the pattern `runLogin` already uses for its external runner: a registry mock
 * leaks into every other file sharing the worker.
 */

function account(overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id: "acc_alice",
        name: "alice",
        provider: "anthropic-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
        label: "max 5x",
        ...overrides,
    };
}

let seen: RunLoginOptions[];

beforeEach(async () => {
    seen = [];
    await saveAskConfig({});
});

afterEach(async () => {
    await saveAskConfig({});
});

describe("ask's subscription login is the shared accounts core", () => {
    test("it delegates to runLogin as the anthropic subscription provider", async () => {
        await addViaOAuthFlow(async (opts) => {
            seen.push(opts);
            return { ok: true, account: account() };
        });

        expect(seen).toHaveLength(1);
        expect(seen[0]?.provider).toBe("anthropic-sub");
        // The wizard always asked what to call the account; the top-level `login`
        // commands derive it silently, so this flag is the difference.
        expect(seen[0]?.promptName).toBe(true);
    });

    test("the account the core wrote becomes ask's own claude reference", async () => {
        await addViaOAuthFlow(async () => ({ ok: true, account: account() }));

        const config = await loadAskConfig();
        expect(config.claude?.accountRef).toBe("alice");
        expect(config.claude?.accountName).toBe("alice");
        expect(config.claude?.accountLabel).toBe("max 5x");
        expect(config.defaultProvider).toBe("anthropic");
    });

    test("a refused login leaves ask's config untouched", async () => {
        await saveAskConfig({ claude: { accountRef: "work", accountName: "work" } });

        await addViaOAuthFlow(async () => ({ ok: false }));

        const config = await loadAskConfig();
        expect(config.claude?.accountRef).toBe("work");
        expect(config.defaultProvider).toBeUndefined();
    });

    test("a cancelled login leaves ask's config untouched", async () => {
        await addViaOAuthFlow(async () => ({ ok: false, cancelled: true }));

        expect((await loadAskConfig()).claude).toBeUndefined();
    });

    /**
     * The spec claim is that ask became a thin door onto the shared core. A door
     * that still imports the raw OAuth client is not one, and the guards live on
     * the other side of it, so this reads the module's own imports.
     */
    test("the wizard no longer reaches for the raw OAuth client", async () => {
        const source = await Bun.file(new URL("./configure.ts", import.meta.url)).text();

        expect(source).toContain("@app/ai/lib/accounts/run-login");
        expect(source).not.toContain("claudeOAuth");
        expect(source).not.toContain("fetchOAuthProfile");
    });
});

describe("linkAskConfigToAccount", () => {
    test("an account with no label clears the cached one rather than keeping a stale plan", async () => {
        await saveAskConfig({ claude: { accountRef: "work", accountLabel: "pro", accountName: "work" } });

        await linkAskConfigToAccount({ name: "personal" });

        const config = await loadAskConfig();
        expect(config.claude?.accountRef).toBe("personal");
        expect(config.claude?.accountLabel).toBeUndefined();
    });

    test("an existing default provider is left alone", async () => {
        await saveAskConfig({ defaultProvider: "openai" });

        await linkAskConfigToAccount({ name: "alice", label: "pro" });

        expect((await loadAskConfig()).defaultProvider).toBe("openai");
    });
});

/** The injected shape has to stay assignable to the real one, or the seam is a lie. */
const _typeCheck: (opts: RunLoginOptions) => Promise<RunLoginResult> = async () => ({ ok: true });
void _typeCheck;
