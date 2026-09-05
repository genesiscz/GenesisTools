import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type AiConfigData, CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import type { AccountFeatures, LoginOutcome } from "@genesiscz/utils/ai/providers/account-features";
import type { BindContext, ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { restoreCodexAuthFile } from "@genesiscz/utils/ai/providers/plugins/openai-sub/login";
import { _resetPluginsForTest, registerPlugin } from "@genesiscz/utils/ai/providers/registry";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    resolveSecret,
} from "@genesiscz/utils/security";
import { collectAccountRows } from "./run-list";
import { writeLoginOutcome } from "./write-outcome";

/**
 * The login write barrier and the probe purity of the listing path.
 *
 * The refusal assertions are made against the CONFIG FILE ON DISK rather than a
 * call spy: a spy proves one function was not called, while byte equality proves
 * nothing was written by ANY route. Each is paired with a negative control, so a
 * guard that leaked into the normal path fails here instead of silently stopping
 * every legitimate login from saving.
 */

const KEY = Buffer.alloc(32, 11);
let home: string;

/** Records every poll and THROWS, so a diagnostic that reaches it fails loudly. */
let pollCalls: string[];

function fakePlugin(id: string, accounts: AccountFeatures): ProviderPlugin {
    return {
        id,
        kind: "subscription",
        capabilities: new Set(["chat"] as const),
        credential: { fields: ["accessToken"], envKeys: [] },
        bind: async (ctx: BindContext) => ({
            accountId: ctx.account.id,
            providerId: id,
            billed: false,
            language: () => {
                throw new Error("not used in tests");
            },
        }),
        accounts,
    };
}

const presentation = { displayName: "Fake", alias: "fake", limitOrder: [], prominentLimits: [] };

function configPath(): string {
    return join(home, ".genesis-tools", "ai", "config.json");
}

/**
 * Seed the config and let the migration chain settle.
 *
 * The chain moves plaintext credentials into the vault on first load, which
 * legitimately rewrites the file. Settling it here means a later byte comparison
 * measures ONLY what the code under test did.
 */
async function seed(data: AiConfigData): Promise<void> {
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(configPath(), SafeJSON.stringify(data, null, 2));
    AiConfigStore.invalidate();
    await AiConfigStore.load();
}

function outcome(overrides: Partial<LoginOutcome> = {}): LoginOutcome {
    return {
        provider: "fake-sub",
        credentials: { accessToken: "sk-fake-fresh" },
        identity: { accountUuid: "acct-incoming", email: "alice@example.com" },
        ...overrides,
    };
}

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "gt-runlogin-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => KEY, getSync: () => KEY, set: async () => {} },
    ]);
    _resetSecretsForTest();
    _resetPluginsForTest();

    pollCalls = [];
    registerPlugin(
        fakePlugin("fake-sub", {
            presentation,
            logoutTargets: ["oauth"],
            async identityOf(account) {
                return { accountUuid: account.accountUuid, email: account.label };
            },
            usage: {
                poll: async (account) => {
                    pollCalls.push(account.name);
                    throw new Error("a diagnostic must never reach usage.poll");
                },
            },
        })
    );

    await seed({ version: CONFIG_VERSION, accounts: [], defaults: {} });
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    _resetPluginsForTest();
    AiConfigStore.invalidate();
});

function storedAccount(name: string): AiConfigData["accounts"][number] | undefined {
    const data: AiConfigData = SafeJSON.parse(readFileSync(configPath(), "utf8"), { strict: true });
    return data.accounts.find((entry) => entry.name === name);
}

describe("writeLoginOutcome identity barrier", () => {
    test("a contradicted identity in a pipe writes NOTHING and says why", async () => {
        await seed({
            version: CONFIG_VERSION,
            accounts: [
                {
                    id: "acc_work",
                    name: "work",
                    provider: "fake-sub",
                    enabled: true,
                    billing: { mode: "subscription" },
                    credentials: { accessToken: "sk-fake-EXISTING" },
                    useEnvApiKey: false,
                    accountUuid: "acct-stored",
                },
            ],
            defaults: {},
        });

        const account = (await AiConfigStore.load()).account("work");
        const before = readFileSync(configPath(), "utf8");

        const written = await writeLoginOutcome({
            name: "work",
            outcome: outcome(),
            interactive: false,
            account,
        });

        expect(written).toBeNull();
        // Byte equality is the assertion: no write reached the config by any route.
        expect(readFileSync(configPath(), "utf8")).toBe(before);
        expect(await resolveSecret(storedAccount("work")?.credentials.accessToken)).toBe("sk-fake-EXISTING");
    });

    test("NEGATIVE CONTROL: a matching identity does write, and the secret is vaulted", async () => {
        await seed({
            version: CONFIG_VERSION,
            accounts: [
                {
                    id: "acc_work",
                    name: "work",
                    provider: "fake-sub",
                    enabled: true,
                    billing: { mode: "subscription" },
                    credentials: { accessToken: "sk-fake-EXISTING" },
                    useEnvApiKey: false,
                    accountUuid: "acct-incoming",
                },
            ],
            defaults: {},
        });

        const account = (await AiConfigStore.load()).account("work");

        const written = await writeLoginOutcome({
            name: "work",
            outcome: outcome(),
            interactive: false,
            account,
        });

        expect(written).not.toBeNull();
        expect(written?.created).toBe(false);
        expect(await resolveSecret(written?.account.credentials.accessToken)).toBe("sk-fake-fresh");
        expect(readFileSync(configPath(), "utf8")).not.toContain("sk-fake-fresh");
    });

    test("NEGATIVE CONTROL: a first login has nothing to contradict and creates the account", async () => {
        const written = await writeLoginOutcome({
            name: "personal",
            outcome: outcome(),
            interactive: false,
        });

        expect(written?.created).toBe(true);
        expect(storedAccount("personal")).toBeDefined();
    });

    test("an unprovable identity writes, because refusing would block every first login", async () => {
        const written = await writeLoginOutcome({
            name: "shop",
            outcome: outcome({ identity: undefined }),
            interactive: false,
        });

        expect(written?.created).toBe(true);
    });
});

describe("listing is a diagnostic", () => {
    test("collecting the account rows never reaches usage.poll", async () => {
        await seed({
            version: CONFIG_VERSION,
            accounts: [
                {
                    id: "acc_work",
                    name: "work",
                    provider: "fake-sub",
                    enabled: true,
                    billing: { mode: "subscription" },
                    credentials: { accessToken: "sk-fake-EXISTING" },
                    useEnvApiKey: false,
                    accountUuid: "acct-stored",
                    label: "alice@example.com",
                },
            ],
            defaults: {},
        });

        const rows = await collectAccountRows();

        expect(rows).toHaveLength(1);
        expect(rows[0].credentialKinds).toEqual(["accessToken"]);
        expect(rows[0].identity?.accountUuid).toBe("acct-stored");
        // The spy throws as well as records, so any call would have failed above.
        expect(pollCalls).toEqual([]);
    });

    test("the rows never carry a credential VALUE, only which kinds exist", async () => {
        await seed({
            version: CONFIG_VERSION,
            accounts: [
                {
                    id: "acc_work",
                    name: "work",
                    provider: "fake-sub",
                    enabled: true,
                    billing: { mode: "subscription" },
                    credentials: { accessToken: "sk-fake-SECRET", longLivedToken: "sk-fake-LONG" },
                    useEnvApiKey: false,
                },
            ],
            defaults: {},
        });

        const serialised = SafeJSON.stringify(await collectAccountRows());

        expect(serialised).toContain("accessToken");
        expect(serialised).toContain("longLivedToken");
        expect(serialised).not.toContain("sk-fake-SECRET");
        expect(serialised).not.toContain("sk-fake-LONG");
    });
});

/**
 * PR #360 review t17. `codexLogin` writes the vendor's `auth.json` BEFORE the
 * identity guard can compare anything, so a refused re-login left the config
 * bound to the old identity while `OpenAISubResolver` read the new credentials
 * out of that same file. `LoginOutcome.rollback` is what undoes it.
 */
describe("writeLoginOutcome undoes the flow's on-disk write when the identity is refused", () => {
    async function seedContradictedAccount(): Promise<void> {
        await seed({
            version: CONFIG_VERSION,
            accounts: [
                {
                    id: "acc_work",
                    name: "work",
                    provider: "fake-sub",
                    enabled: true,
                    billing: { mode: "subscription" },
                    credentials: { accessToken: "sk-fake-EXISTING" },
                    useEnvApiKey: false,
                    accountUuid: "acct-stored",
                },
            ],
            defaults: {},
        });
    }

    test("a refused identity runs the rollback", async () => {
        await seedContradictedAccount();
        const account = (await AiConfigStore.load()).account("work");
        let rolledBack = 0;

        const written = await writeLoginOutcome({
            name: "work",
            outcome: {
                ...outcome(),
                rollback: async () => {
                    rolledBack += 1;
                },
            },
            interactive: false,
            account,
        });

        expect(written).toBeNull();
        expect(rolledBack).toBe(1);
    });

    test("NEGATIVE CONTROL: an accepted identity never rolls back", async () => {
        await seed({
            version: CONFIG_VERSION,
            accounts: [
                {
                    id: "acc_work",
                    name: "work",
                    provider: "fake-sub",
                    enabled: true,
                    billing: { mode: "subscription" },
                    credentials: { accessToken: "sk-fake-EXISTING" },
                    useEnvApiKey: false,
                    accountUuid: "acct-incoming",
                },
            ],
            defaults: {},
        });

        const account = (await AiConfigStore.load()).account("work");
        let rolledBack = 0;

        const written = await writeLoginOutcome({
            name: "work",
            outcome: {
                ...outcome(),
                rollback: async () => {
                    rolledBack += 1;
                },
            },
            interactive: false,
            account,
        });

        expect(written).not.toBeNull();
        expect(rolledBack).toBe(0);
    });

    test("a rollback that throws still refuses cleanly instead of crashing", async () => {
        await seedContradictedAccount();
        const account = (await AiConfigStore.load()).account("work");

        const written = await writeLoginOutcome({
            name: "work",
            outcome: {
                ...outcome(),
                rollback: async () => {
                    throw new Error("disk full");
                },
            },
            interactive: false,
            account,
        });

        expect(written).toBeNull();
    });
});

describe("restoreCodexAuthFile", () => {
    test("puts the previous auth file back byte for byte", async () => {
        const authFile = join(home, "auth.json");
        const original = SafeJSON.stringify({ tokens: { access_token: "sk-invented-OLD" } });
        writeFileSync(authFile, original);

        writeFileSync(authFile, SafeJSON.stringify({ tokens: { access_token: "sk-invented-NEW" } }));
        await restoreCodexAuthFile(authFile, new TextEncoder().encode(original).buffer as ArrayBuffer);

        expect(readFileSync(authFile, "utf8")).toBe(original);
    });

    test("removes a file the login created where there was none", async () => {
        const authFile = join(home, "fresh-auth.json");
        writeFileSync(authFile, SafeJSON.stringify({ tokens: { access_token: "sk-invented-NEW" } }));

        await restoreCodexAuthFile(authFile, undefined);

        expect(existsSync(authFile)).toBe(false);
    });
});
