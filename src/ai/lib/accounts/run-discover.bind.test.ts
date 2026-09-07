import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type AiConfigData, CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import type { AccountFeatures, DiscoveredHome } from "@genesiscz/utils/ai/providers/account-features";
import type { BindContext, ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { _resetBuiltInPluginsForTest } from "@genesiscz/utils/ai/providers/plugins";
import { _resetPluginsForTest, registerPlugin } from "@genesiscz/utils/ai/providers/registry";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
} from "@genesiscz/utils/security";
import { runDiscover } from "./run-discover";

/**
 * `accounts discover --bind` creates accounts; it never replaces one.
 *
 * `writeLoginOutcome` merges onto an account of the same name, and the reserved
 * name set only knew about homes seen in the SAME run. An unbound codex home
 * whose email decodes to `alice` therefore converted an unrelated `alice`
 * API-key account to openai-sub and deleted its vault secrets (PR #360 review
 * t3). Separately, the bind wrote only the plan LABEL, so a discovered account
 * stored no fingerprint and a later login by a stranger had nothing to
 * contradict (review t4).
 *
 * Both are asserted against the config FILE, so a write by any route shows up.
 * Every handle and email here is invented.
 */

const KEY = Buffer.alloc(32, 23);

let home: string;
let discovered: DiscoveredHome[];

function fakePlugin(id: string, accounts?: AccountFeatures): ProviderPlugin {
    return {
        id,
        kind: accounts ? "subscription" : "api-key",
        capabilities: new Set(["chat"] as const),
        credential: { fields: ["authFile"], envKeys: [] },
        bind: async (ctx: BindContext) => ({
            accountId: ctx.account.id,
            providerId: id,
            billed: false,
            language: () => {
                throw new Error("not used in tests");
            },
        }),
        ...(accounts ? { accounts } : {}),
    };
}

function configPath(): string {
    return join(home, ".genesis-tools", "ai", "config.json");
}

async function seed(data: AiConfigData): Promise<void> {
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(configPath(), SafeJSON.stringify(data, null, 2));
    AiConfigStore.invalidate();
    await AiConfigStore.load();
}

function storedAccounts(): AiConfigData["accounts"] {
    const data: AiConfigData = SafeJSON.parse(readFileSync(configPath(), "utf8"), { strict: true });
    return data.accounts;
}

function storedAccount(name: string): AiConfigData["accounts"][number] | undefined {
    return storedAccounts().find((entry) => entry.name === name);
}

/** An unbound home on disk, the only kind `--bind` acts on. */
function unboundHome(dir: string, email: string, accountUuid: string): DiscoveredHome {
    const authFile = join(home, dir, "auth.json");
    mkdirSync(dirname(authFile), { recursive: true });
    writeFileSync(authFile, SafeJSON.stringify({ tokens: { access_token: "invented" } }));

    return { home: join(home, dir), authFile, identity: { email, accountUuid, plan: "plus" } };
}

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "gt-discover-bind-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => KEY, getSync: () => KEY, set: async () => {} },
    ]);
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest(true);

    discovered = [];

    // The provider whose homes are discovered, plus an api-key one so the account
    // the collision would have converted has a real provider to be converted FROM.
    registerPlugin(
        fakePlugin("openai-sub", {
            presentation: { displayName: "Codex", alias: "codex", limitOrder: [], prominentLimits: [] },
            logoutTargets: ["oauth", "authFile"],
            discoverHomes: async () => discovered,
        })
    );
    registerPlugin(fakePlugin("openai"));

    process.exitCode = 0;
    await seed({ version: CONFIG_VERSION, accounts: [], defaults: {} });
});

afterEach(() => {
    process.exitCode = 0;
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
    AiConfigStore.invalidate();
});

function discover() {
    return runDiscover({
        provider: "codex",
        bind: true,
        json: true,
        tool: "tools ai accounts discover",
        subcommand: ["accounts", "discover"],
    });
}

/** An unrelated account already holding the name the next home would derive. */
async function seedUnrelatedAlice(): Promise<void> {
    await seed({
        version: CONFIG_VERSION,
        accounts: [
            {
                id: "acc_alice",
                name: "alice",
                provider: "openai",
                enabled: true,
                billing: { mode: "metered" },
                credentials: { apiKey: "sk-invented-metered" },
                useEnvApiKey: false,
                label: "pay-as-you-go",
            },
        ],
        defaults: {},
    });
}

describe("an existing account never becomes a discovered home", () => {
    test("the unrelated account keeps its provider, its label and its credential", async () => {
        await seedUnrelatedAlice();
        discovered = [unboundHome(".codex", "alice@example.com", "chatgpt-acct-1")];

        await discover();

        const alice = storedAccount("alice");
        expect(alice?.provider).toBe("openai");
        expect(alice?.label).toBe("pay-as-you-go");
        expect(alice?.credentials.authFile).toBeUndefined();
        expect(alice?.credentials.apiKey).toBeDefined();
    });

    test("the home is bound under a fresh name instead", async () => {
        await seedUnrelatedAlice();
        const row = unboundHome(".codex", "alice@example.com", "chatgpt-acct-1");
        discovered = [row];

        await discover();

        expect(storedAccount("alice-2")?.credentials.authFile).toBe(row.authFile);
        expect(storedAccount("alice-2")?.provider).toBe("openai-sub");
        expect(storedAccounts()).toHaveLength(2);
    });

    test("NEGATIVE CONTROL: with no collision the derived name is used as it is", async () => {
        const row = unboundHome(".codex", "alice@example.com", "chatgpt-acct-1");
        discovered = [row];

        await discover();

        expect(storedAccount("alice")?.credentials.authFile).toBe(row.authFile);
        expect(storedAccount("alice-2")).toBeUndefined();
    });

    test("NEGATIVE CONTROL: two homes in one run still get one account each", async () => {
        discovered = [
            unboundHome(".codex", "alice@example.com", "chatgpt-acct-1"),
            unboundHome(".codex-second", "alice@personal.example", "chatgpt-acct-2"),
        ];

        await discover();

        expect(storedAccount("alice")?.accountUuid).toBe("chatgpt-acct-1");
        expect(storedAccount("alice-2")?.accountUuid).toBe("chatgpt-acct-2");
    });
});

describe("a discovered home stores the fingerprint it decoded", () => {
    test("the uuid reaches the account, not only the plan label", async () => {
        discovered = [unboundHome(".codex", "alice@example.com", "chatgpt-acct-1")];

        await discover();

        // Without the uuid the account has nothing for `identityMismatch` to
        // contradict, so a stranger's later login overwrites it in silence.
        expect(storedAccount("alice")?.accountUuid).toBe("chatgpt-acct-1");
        expect(storedAccount("alice")?.label).toBe("plus");
    });

    test("a home whose claims prove nothing stores no uuid at all", async () => {
        const authFile = join(home, ".codex", "auth.json");
        mkdirSync(dirname(authFile), { recursive: true });
        writeFileSync(authFile, SafeJSON.stringify({ tokens: { access_token: "invented" } }));
        discovered = [{ home: join(home, ".codex"), authFile }];

        await discover();

        // "unprovable" and "contradicted" are different answers to the guard.
        expect(storedAccount("codex-1")).toBeDefined();
        expect(storedAccount("codex-1")).not.toHaveProperty("accountUuid");
    });
});
