import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { ai } from "@genesiscz/utils/ai/tasks/facade";
import { env } from "@genesiscz/utils/env";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    type MasterKeyProvider,
    secrets,
} from "@genesiscz/utils/security";
import { checkSayCredential } from "./credential";

/**
 * `tools say` spawned by Genesis.app has no shell exports, so the xAI key must
 * come from an AI account. These tests walk the real path the CLI takes
 * (`checkSayCredential`, then `ai.synthesize`, which is what `speakCached` calls)
 * against a scratch home, a fake keyring and a fetch spy that THROWS, so no
 * test can spend a cloud request or touch the real keychain.
 */

const MASTER_KEY = randomBytes(32);
const ENV_KEY = "xai-fixture-from-env";
const VAULT_KEY = "xai-fixture-from-vault";
const OPENAI_VAULT_KEY = "openai-fixture-from-vault";
const KEY_VARIABLES = ["XAI_API_KEY", "X_AI_API_KEY", "OPENAI_API_KEY"] as const;

// The 401 is load-bearing: `shouldRetrySynthesize` treats it as final, so the
// engine does not sleep through three backoff attempts before failing.
const SPY_REFUSAL = "401 fetch spy: a test tried to reach a real provider";

interface SpiedRequest {
    url: string;
    authorization: string | null;
}

let requests: SpiedRequest[] = [];
let keyringReads = 0;
let envSnapshot: ReturnType<typeof env.testing.snapshot>;
const originalFetch = globalThis.fetch;

function fakeKeyring(): MasterKeyProvider[] {
    return [
        {
            id: "keychain",
            available: async () => true,
            get: async () => {
                keyringReads++;
                return MASTER_KEY;
            },
            getSync: () => {
                keyringReads++;
                return MASTER_KEY;
            },
            set: async () => {},
        },
    ];
}

function account(overrides: Partial<AccountEntry> & Pick<AccountEntry, "id" | "name">): AccountEntry {
    return {
        provider: "xai",
        enabled: true,
        billing: { mode: "metered" },
        credentials: {},
        useEnvApiKey: false,
        ...overrides,
    };
}

/** The layout the seeding migration leaves behind: an env-only account with no stored key. */
const ENV_ONLY = account({ id: "acc_env_only", name: "env-only", useEnvApiKey: ["XAI_API_KEY"] });

async function addAccounts(accounts: AccountEntry[]): Promise<void> {
    const store = await AiConfigStore.load();
    await store.mutate((data) => {
        data.accounts.push(...accounts);
    });
}

/**
 * Storing a fixture key reads the master key and caches it. Drop both caches so
 * the code under test starts the way a new `tools say` process does, and a
 * keyring read it makes is counted.
 */
function freshProcess(): void {
    _setMasterKeyProvidersForTest(fakeKeyring());
    _resetSecretsForTest();
    keyringReads = 0;
}

async function vaultAccount(args: { id: string; name: string; provider: string; key: string }): Promise<AccountEntry> {
    const ref = await (await secrets()).set(`ai/${args.id}/apiKey`, args.key);
    return account({ id: args.id, name: args.name, provider: args.provider, credentials: { apiKey: ref } });
}

beforeEach(() => {
    envSnapshot = env.testing.snapshot();

    // The developer's shell may export real keys; every case below decides its own.
    for (const name of KEY_VARIABLES) {
        env.testing.unset(name);
    }

    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "gt-say-cred-")));
    freshProcess();
    AiConfigStore.invalidate();

    requests = [];
    const spy = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        throw new Error(SPY_REFUSAL);
    };
    globalThis.fetch = Object.assign(spy, { preconnect: originalFetch.preconnect });
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    AiConfigStore.invalidate();
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    env.testing.restore(envSnapshot);
});

describe("tools say: the xAI key", () => {
    test("an exported XAI_API_KEY still speaks, exactly as before, with no vault read", async () => {
        env.testing.set("XAI_API_KEY", ENV_KEY);
        await addAccounts([ENV_ONLY]);

        expect(await checkSayCredential({ provider: "xai", fallback: false })).toEqual({ kind: "ok" });
        await expect(ai.synthesize("hello", { provider: "xai" })).rejects.toThrow(SPY_REFUSAL);

        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe("https://api.x.ai/v1/tts");
        expect(requests[0].authorization).toBe(`Bearer ${ENV_KEY}`);
        expect(keyringReads).toBe(0);
    });

    test("with no variable exported, a key stored on an xai account speaks", async () => {
        await addAccounts([
            ENV_ONLY,
            await vaultAccount({ id: "acc_shop", name: "shop", provider: "xai", key: VAULT_KEY }),
        ]);
        freshProcess();

        expect(await checkSayCredential({ provider: "xai", fallback: false })).toEqual({ kind: "ok" });
        await expect(ai.synthesize("hello", { provider: "xai" })).rejects.toThrow(SPY_REFUSAL);

        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe("https://api.x.ai/v1/tts");
        expect(requests[0].authorization).toBe(`Bearer ${VAULT_KEY}`);
        expect(keyringReads).toBeGreaterThan(0);
    });

    test("with neither, it falls back to macos and names the command that fixes it", async () => {
        await addAccounts([ENV_ONLY]);

        const check = await checkSayCredential({ provider: "xai", fallback: true });

        expect(check.kind).toBe("fallback");
        if (check.kind !== "fallback") {
            return;
        }

        expect(check.line).toStartWith("[say] xai has no usable key, falling back to macos.");
        expect(check.line).toContain("no key in account env-only");
        expect(check.line).toContain(
            `printf '%s' "$XAI_API_KEY" | tools ai config account edit env-only --api-key-stdin`
        );
        expect(check.line).not.toContain("secret set");
        expect(check.line).not.toContain("\n");

        // The engine refuses on its own too, before any request leaves the process.
        await expect(ai.synthesize("hello", { provider: "xai" })).rejects.toThrow(/not available/);
        expect(requests).toHaveLength(0);
    });

    test("with neither and --no-fallback, it fails with the same fix command", async () => {
        const check = await checkSayCredential({ provider: "xai", fallback: false });

        expect(check.kind).toBe("fail");
        if (check.kind !== "fail") {
            return;
        }

        expect(check.line).toStartWith("[say] xai has no usable key.");
        expect(check.reason).toContain("no account and none of XAI_API_KEY, X_AI_API_KEY is set");
        expect(check.reason).toContain(
            `printf '%s' "$XAI_API_KEY" | tools ai config account add --provider xai --name xai --api-key-stdin`
        );
        expect(requests).toHaveLength(0);
    });

    test("macos needs no key and never consults the account ladder", async () => {
        expect(await checkSayCredential({ provider: "macos", fallback: false })).toEqual({ kind: "ok" });
        expect(keyringReads).toBe(0);
    });
});

describe("tools say: the OpenAI key", () => {
    test("with OPENAI_API_KEY unset, a key stored on an openai account reaches the engine", async () => {
        await addAccounts([
            await vaultAccount({ id: "acc_side", name: "side", provider: "openai", key: OPENAI_VAULT_KEY }),
        ]);
        freshProcess();

        expect(await checkSayCredential({ provider: "openai", fallback: false })).toEqual({ kind: "ok" });
        await expect(ai.synthesize("hello", { provider: "openai" })).rejects.toThrow(SPY_REFUSAL);

        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe("https://api.openai.com/v1/audio/speech");
        expect(requests[0].authorization).toBe(`Bearer ${OPENAI_VAULT_KEY}`);
    });

    test("an exported OPENAI_API_KEY with no account still reaches the engine", async () => {
        env.testing.set("OPENAI_API_KEY", "openai-fixture-from-env");

        await expect(ai.synthesize("hello", { provider: "openai" })).rejects.toThrow(SPY_REFUSAL);

        expect(requests[0].authorization).toBe("Bearer openai-fixture-from-env");
        expect(keyringReads).toBe(0);
    });
});
