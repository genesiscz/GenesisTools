import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    isSecureRef,
    resolveSecret,
    secrets,
} from "@genesiscz/utils/security";
import type { LoginOutcome } from "../providers/account-features";
import type { BindContext, ProviderPlugin } from "../providers/plugin-types";
import { _resetPluginsForTest, registerPlugin } from "../providers/registry";
import { AiConfigStore } from "./AiConfigStore";
import {
    AccountChangedError,
    AccountInUseError,
    addAccount,
    applyLoginOutcome,
    clearCredentials,
    editAccount,
    removeAccount,
    testAccount,
} from "./account-ops";
import { _clearExternalRefScanners, registerExternalRefScanner } from "./refs";
import { type AiConfigData, CONFIG_VERSION } from "./schema";

const KEY = Buffer.alloc(32, 3);

let home: string;

function configPath(): string {
    return join(home, ".genesis-tools", "ai", "config.json");
}

function writeConfig(data: AiConfigData): void {
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(configPath(), SafeJSON.stringify(data, null, 2));
    AiConfigStore.invalidate();
}

function readRawConfig(): AiConfigData {
    return SafeJSON.parse(readFileSync(configPath(), "utf8"), { strict: true });
}

/**
 * The entry a caller's guards would have been decided against. `applyLoginOutcome`
 * re-checks it inside the config lock, so every call has to state which account it
 * believed it was writing — `null` for "there is none yet".
 */
function guarded(idOrName: string): AiConfigData["accounts"][number] {
    const found = readRawConfig().accounts.find((entry) => entry.id === idOrName || entry.name === idOrName);

    if (!found) {
        throw new Error(`test setup: no account "${idOrName}" to guard against`);
    }

    return found;
}

function fakePlugin(overrides: Partial<ProviderPlugin> = {}): ProviderPlugin {
    return {
        id: "fake",
        kind: "api-key",
        capabilities: new Set(["chat"] as const),
        credential: { fields: ["apiKey"], envKeys: ["FAKE_API_KEY"], required: ["apiKey"] },
        bind: async (ctx: BindContext) => ({
            accountId: ctx.account.id,
            providerId: "fake",
            billed: true,
            language: () => {
                throw new Error("not used in tests");
            },
        }),
        ...overrides,
    };
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-acctops-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => KEY, getSync: () => KEY, set: async () => {} },
    ]);
    _resetSecretsForTest();
    _resetPluginsForTest();
    registerPlugin(fakePlugin());
    writeConfig({ version: CONFIG_VERSION, accounts: [], defaults: {} });
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    _resetPluginsForTest();
    _clearExternalRefScanners();
    AiConfigStore.invalidate();
});

describe("addAccount", () => {
    test("mints an id, vaults the secret and never writes it to the config file", async () => {
        const account = await addAccount({ provider: "fake", name: "my key", secrets: { apiKey: "sk-plaintext" } });

        expect(account.id).toBe("acc_my_key");
        expect(isSecureRef(account.credentials.apiKey)).toBe(true);

        const onDisk = readFileSync(configPath(), "utf8");
        expect(onDisk).not.toContain("sk-plaintext");
        expect(onDisk).toContain("ai/acc_my_key/apiKey");

        const vault = await secrets();
        expect(await vault.get("ai/acc_my_key/apiKey")).toBe("sk-plaintext");
    });

    test("carries the endpoint that credential.fields cannot express", async () => {
        const account = await addAccount({ provider: "fake", name: "local", endpoint: "http://127.0.0.1:11434" });

        expect(account.endpoint).toBe("http://127.0.0.1:11434");
        expect(readRawConfig().accounts[0].endpoint).toBe("http://127.0.0.1:11434");
    });

    test("refuses an unknown provider before writing anything", async () => {
        await expect(addAccount({ provider: "nope", name: "x" })).rejects.toThrow('Unknown AI provider "nope"');
        expect(readRawConfig().accounts).toHaveLength(0);
    });

    test("refuses a duplicate name", async () => {
        await addAccount({ provider: "fake", name: "dup" });

        await expect(addAccount({ provider: "fake", name: "dup" })).rejects.toThrow("already exists");
    });

    test("defaults billing from the plugin kind", async () => {
        _resetPluginsForTest();
        registerPlugin(fakePlugin({ id: "sub", kind: "subscription", credential: { fields: [], envKeys: [] } }));
        registerPlugin(fakePlugin({ id: "runtime", kind: "local", credential: { fields: [], envKeys: [] } }));

        expect((await addAccount({ provider: "sub", name: "s" })).billing.mode).toBe("subscription");
        expect((await addAccount({ provider: "runtime", name: "r" })).billing.mode).toBe("free");
    });
});

describe("editAccount", () => {
    test("renaming keeps the id, so existing refs still resolve", async () => {
        const created = await addAccount({ provider: "fake", name: "before" });
        await editAccount("before", { rename: "after", label: "Work", tags: ["a"], useEnvApiKey: ["FAKE_API_KEY"] });

        const store = await AiConfigStore.load();
        const account = store.account("after");

        expect(account?.id).toBe(created.id);
        expect(account?.label).toBe("Work");
        expect(account?.tags).toEqual(["a"]);
        expect(account?.useEnvApiKey).toEqual(["FAKE_API_KEY"]);
    });

    test("disable and re-enable round-trip", async () => {
        await addAccount({ provider: "fake", name: "toggle" });

        expect((await editAccount("toggle", { enabled: false })).enabled).toBe(false);
        expect((await editAccount("toggle", { enabled: true })).enabled).toBe(true);
    });

    test("an unknown account names the listing command", async () => {
        await expect(editAccount("ghost", { enabled: false })).rejects.toThrow("tools ai config account list");
    });
});

describe("removeAccount", () => {
    test("refuses while an in-config default points at it, and names the referrer", async () => {
        const created = await addAccount({ provider: "fake", name: "used" });
        const store = await AiConfigStore.load();
        await store.mutate((data) => {
            data.defaults.account = { chat: `@account/${created.id}` };
        });

        const failure = await removeAccount("used").catch((err: unknown) => err);

        expect(failure).toBeInstanceOf(AccountInUseError);
        expect((failure as AccountInUseError).referrers[0].path).toBe("defaults.account.chat");
        expect((await AiConfigStore.load()).account("used")).toBeDefined();
    });

    test("an external scanner's reference counts too", async () => {
        const created = await addAccount({ provider: "fake", name: "proxied" });
        registerExternalRefScanner("ai-proxy", async () => [
            { path: "clients[0].account", ref: `@account/${created.id}` },
        ]);

        await expect(removeAccount("proxied")).rejects.toThrow("ai-proxy:clients[0].account");
    });

    test("--force removes a referenced account and takes its vault entries with it", async () => {
        const created = await addAccount({ provider: "fake", name: "used", secrets: { apiKey: "sk-doomed" } });
        const store = await AiConfigStore.load();
        await store.mutate((data) => {
            data.defaults.account = { chat: `@account/${created.id}` };
        });

        const result = await removeAccount("used", { force: true });

        expect(result.referrers).toHaveLength(1);
        expect(result.secretsDeleted).toEqual(["ai/acc_used/apiKey"]);
        expect(readRawConfig().accounts).toHaveLength(0);
        expect(await (await secrets()).get("ai/acc_used/apiKey")).toBeUndefined();
    });

    test("an unreferenced account needs no force", async () => {
        await addAccount({ provider: "fake", name: "lonely" });

        const result = await removeAccount("lonely");

        expect(result.referrers).toHaveLength(0);
        expect(readRawConfig().accounts).toHaveLength(0);
    });
});

describe("applyLoginOutcome", () => {
    function outcome(overrides: Partial<LoginOutcome> = {}): LoginOutcome {
        return {
            provider: "fake",
            credentials: { accessToken: "sk-access", refreshToken: "sk-refresh", expiresAt: 1234 },
            ...overrides,
        };
    }

    test("a first login mints the account, vaults the secrets and writes no plaintext", async () => {
        const result = await applyLoginOutcome({ name: "work", guardedAgainst: null, outcome: outcome() });

        expect(result.created).toBe(true);
        expect(result.account.id).toBe("acc_work");
        expect(isSecureRef(result.account.credentials.accessToken)).toBe(true);

        const onDisk = readFileSync(configPath(), "utf8");
        expect(onDisk).not.toContain("sk-access");
        expect(onDisk).not.toContain("sk-refresh");
        expect(await (await secrets()).get("ai/acc_work/accessToken")).toBe("sk-access");
        expect(result.account.credentials.expiresAt).toBe(1234);
    });

    // A flow returns only what it obtained, so a plain overwrite dropped every
    // other credential the account carried. That is the bug `mergeAccountEntry`
    // exists to prevent, restated on the v4 store.
    test("a re-login preserves the long-lived token, the secondary grant, the label and the apps", async () => {
        await applyLoginOutcome({
            name: "work",
            guardedAgainst: null,
            apps: ["claude", "ask"],
            outcome: outcome({
                credentials: {
                    accessToken: "sk-old-access",
                    longLivedToken: "sk-ant-oat01-keepme",
                    secondary: { accessToken: "sk-secondary", accountUuid: "acct-1" },
                },
                accountFields: { label: "max 5x" },
            }),
        });

        const result = await applyLoginOutcome({ name: "work", guardedAgainst: guarded("work"), outcome: outcome() });

        expect(result.created).toBe(false);
        expect(await resolveSecret(result.account.credentials.longLivedToken)).toBe("sk-ant-oat01-keepme");
        expect(await resolveSecret(result.account.credentials.secondary?.accessToken)).toBe("sk-secondary");
        expect(result.account.credentials.secondary?.accountUuid).toBe("acct-1");
        expect(result.account.label).toBe("max 5x");
        expect(result.account.apps).toEqual(["claude", "ask"]);
        // The new pair still landed.
        expect(await resolveSecret(result.account.credentials.accessToken)).toBe("sk-access");
    });

    test("a provider switch replaces the credentials wholesale", async () => {
        registerPlugin(fakePlugin({ id: "other", kind: "subscription", credential: { fields: [], envKeys: [] } }));

        await applyLoginOutcome({
            name: "work",
            guardedAgainst: null,
            outcome: outcome({ credentials: { accessToken: "sk-old", longLivedToken: "sk-ant-oat01-stale" } }),
        });

        const result = await applyLoginOutcome({
            name: "work",
            guardedAgainst: guarded("work"),
            outcome: { provider: "other", credentials: { authFile: "/tmp/other/auth.json" } },
        });

        expect(result.account.provider).toBe("other");
        expect(result.account.credentials.longLivedToken).toBeUndefined();
        expect(result.account.credentials.accessToken).toBeUndefined();
        expect(result.account.credentials.authFile).toBe("/tmp/other/auth.json");
        expect(result.account.billing.mode).toBe("subscription");

        // PR #360 review t11: asserting only the config fields passed while the
        // old vendor's tokens stayed in the vault forever, unreachable because
        // `clearCredentials` works off the config that no longer names them.
        const vault = await secrets();
        expect(await vault.list(`ai/${result.account.id}/`)).toEqual([]);
    });

    // `login-secondary` resolves an account by id and then wrote it back by
    // name, which picks the first namesake across every provider (PR #360
    // review t4). The namesake here is an API-key account whose vault entry a
    // provider switch would have deleted.
    test("an id targets THAT account when two share a name, and the namesake keeps its secrets", async () => {
        registerPlugin(fakePlugin({ id: "other", kind: "subscription", credential: { fields: [], envKeys: [] } }));
        await applyLoginOutcome({ name: "work", guardedAgainst: null, outcome: outcome() });

        const raw = readRawConfig();
        raw.accounts.push({
            id: "acc_work_other",
            name: "work",
            provider: "other",
            enabled: true,
            billing: { mode: "subscription" },
            credentials: { authFile: "/tmp/other/auth.json" },
            useEnvApiKey: false,
        });
        writeConfig(raw);

        const result = await applyLoginOutcome({
            id: "acc_work_other",
            name: "work",
            guardedAgainst: guarded("acc_work_other"),
            outcome: {
                provider: "other",
                credentials: { secondary: { accessToken: "sk-secondary", accountUuid: "acct-2" } },
            },
        });

        expect(result.created).toBe(false);
        expect(result.account.id).toBe("acc_work_other");
        expect(result.account.credentials.authFile).toBe("/tmp/other/auth.json");
        expect(await resolveSecret(result.account.credentials.secondary?.accessToken)).toBe("sk-secondary");

        const namesake = readRawConfig().accounts.find((entry) => entry.id === "acc_work");
        expect(namesake?.provider).toBe("fake");
        expect(await (await secrets()).get("ai/acc_work/accessToken")).toBe("sk-access");
    });

    test("an id that no longer exists writes nothing rather than minting a namesake", async () => {
        // The caller resolved an entry that is gone by the time the lock is taken,
        // which is the shape `guardedAgainst` describes; the id check answers first.
        await expect(
            applyLoginOutcome({
                id: "acc_gone",
                name: "work",
                guardedAgainst: {
                    id: "acc_gone",
                    name: "work",
                    provider: "fake",
                    enabled: true,
                    billing: { mode: "subscription" },
                    credentials: {},
                    useEnvApiKey: false,
                },
                outcome: outcome(),
            })
        ).rejects.toThrow(/no longer exists/);
        expect(readRawConfig().accounts).toEqual([]);
    });

    test("an empty app default is filled once and never overwritten", async () => {
        const first = await applyLoginOutcome({
            name: "work",
            guardedAgainst: null,
            outcome: outcome(),
            defaultForApps: ["claude", "ask"],
        });

        expect(first.defaultsSet).toEqual(["claude", "ask"]);

        const config = (await AiConfigStore.load()).data();
        expect(config.defaults.app?.claude?.chat?.model).toBe(`@account/${first.account.id}`);
        expect(config.defaults.app?.ask?.chat?.model).toBe(`@account/${first.account.id}`);

        const second = await applyLoginOutcome({
            name: "personal",
            guardedAgainst: null,
            outcome: outcome(),
            defaultForApps: ["claude", "ask"],
        });

        expect(second.defaultsSet).toEqual([]);
        expect((await AiConfigStore.load()).data().defaults.app?.claude?.chat?.model).toBe(
            `@account/${first.account.id}`
        );
    });

    /**
     * PR #368 review t2. Every guard in `write-outcome.ts` runs before this lock is
     * taken, because a guard may prompt. A first login therefore decides "no such
     * account" minutes before the write, and the merge below switches providers and
     * DELETES the vault entries of whatever it lands on — so an entry created in
     * that window must never reach it.
     */
    test("a name another login claimed while the guards ran is refused, secrets intact", async () => {
        registerPlugin(fakePlugin({ id: "other", kind: "subscription", credential: { fields: [], envKeys: [] } }));
        // The stranger: created after the caller below concluded there was none.
        await applyLoginOutcome({ name: "work", guardedAgainst: null, outcome: outcome() });
        const before = readFileSync(configPath(), "utf8");

        await expect(
            applyLoginOutcome({
                name: "work",
                guardedAgainst: null,
                outcome: { provider: "other", credentials: { authFile: "/tmp/other/auth.json" } },
            })
        ).rejects.toThrow(AccountChangedError);

        expect(readFileSync(configPath(), "utf8")).toBe(before);
        expect(readRawConfig().accounts[0]?.provider).toBe("fake");
        expect(await (await secrets()).get("ai/acc_work/accessToken")).toBe("sk-access");
    });

    test("an entry rewritten under a caller that DID inspect it is refused", async () => {
        await applyLoginOutcome({ name: "work", guardedAgainst: null, outcome: outcome() });
        const inspected = guarded("work");

        // Another login lands in between and rewrites the identity this caller read.
        const raw = readRawConfig();
        const live = raw.accounts.find((entry) => entry.id === "acc_work");

        if (live) {
            live.accountUuid = "acct-someone-else";
        }

        writeConfig(raw);

        await expect(
            applyLoginOutcome({ id: "acc_work", name: "work", guardedAgainst: inspected, outcome: outcome() })
        ).rejects.toThrow(AccountChangedError);

        expect(readRawConfig().accounts[0]?.accountUuid).toBe("acct-someone-else");
    });

    test("a rewritten SECONDARY identity is refused even when the primary one is unchanged", async () => {
        await applyLoginOutcome({ name: "work", guardedAgainst: null, outcome: outcome() });
        const seeded = readRawConfig();
        const entry = seeded.accounts.find((candidate) => candidate.id === "acc_work");

        if (entry) {
            entry.accountUuid = "acct-primary";
            entry.organizationUuid = "org-primary";
            entry.credentials.secondary = { accountUuid: "acct-secondary", organizationUuid: "org-secondary" };
        }

        writeConfig(seeded);
        const inspected = guarded("work");

        // The primary identity stays; only the secondary grant is re-identified in between.
        const raw = readRawConfig();
        const live = raw.accounts.find((candidate) => candidate.id === "acc_work");

        if (live?.credentials.secondary) {
            live.credentials.secondary.accountUuid = "acct-someone-else";
        }

        writeConfig(raw);

        await expect(
            applyLoginOutcome({ id: "acc_work", name: "work", guardedAgainst: inspected, outcome: outcome() })
        ).rejects.toThrow(AccountChangedError);
    });

    test("NEGATIVE CONTROL: an entry nobody touched still merges", async () => {
        await applyLoginOutcome({ name: "work", guardedAgainst: null, outcome: outcome() });
        const inspected = guarded("work");

        const result = await applyLoginOutcome({
            id: "acc_work",
            name: "work",
            guardedAgainst: inspected,
            outcome: outcome({ credentials: { accessToken: "sk-second" } }),
        });

        expect(result.created).toBe(false);
        expect(await resolveSecret(result.account.credentials.accessToken)).toBe("sk-second");
    });

    test("refuses an unknown provider before writing anything", async () => {
        await expect(
            applyLoginOutcome({ name: "work", guardedAgainst: null, outcome: outcome({ provider: "nope" }) })
        ).rejects.toThrow('Unknown AI provider "nope"');
        expect(readRawConfig().accounts).toHaveLength(0);
    });
});

describe("clearCredentials", () => {
    // The bug this pins: `tools claude logout` used to delete fields off a v3
    // token projection and write it back, but `applyV3Tokens` skips absent
    // fields (it cannot distinguish a deliberate deletion from a failed vault
    // read), so the credentials survived while the command printed success.
    test("revokes the named credentials from both the config and the vault", async () => {
        await addAccount({
            provider: "fake",
            name: "sub",
            secrets: { accessToken: "sk-access", refreshToken: "sk-refresh", apiKey: "sk-untouched" },
        });

        const result = await clearCredentials("sub", ["accessToken", "refreshToken"]);
        const vault = await secrets();

        expect(result.secretsDeleted.sort()).toEqual(["ai/acc_sub/accessToken", "ai/acc_sub/refreshToken"]);
        expect(await vault.get("ai/acc_sub/accessToken")).toBeUndefined();
        expect(await vault.get("ai/acc_sub/refreshToken")).toBeUndefined();

        const account = (await AiConfigStore.load()).account("sub");
        expect(account?.credentials.accessToken).toBeUndefined();
        expect(account?.credentials.refreshToken).toBeUndefined();

        // Untouched fields stay, so a partial logout is genuinely partial.
        expect(await vault.get("ai/acc_sub/apiKey")).toBe("sk-untouched");
        expect(account?.credentials.apiKey).toBeDefined();
    });

    test("the account itself survives a credential clear", async () => {
        await addAccount({ provider: "fake", name: "kept", secrets: { accessToken: "sk-a" } });

        await clearCredentials("kept", ["accessToken"]);

        expect((await AiConfigStore.load()).account("kept")).toBeDefined();
    });
});

describe("testAccount", () => {
    test("reports credential source and a successful bind", async () => {
        await addAccount({ provider: "fake", name: "good", secrets: { apiKey: "sk-live" } });

        const result = await testAccount("good");

        expect(result.credential).toEqual({ ok: true, detail: "vault" });
        expect(result.binding.ok).toBe(true);
        expect(result.health).toBeUndefined();
        expect(result.ok).toBe(true);
    });

    test("a missing credential fails without throwing", async () => {
        await addAccount({ provider: "fake", name: "empty" });

        const result = await testAccount("empty");

        expect(result.credential.ok).toBe(false);
        expect(result.credential.detail).toContain("missing apiKey");
        expect(result.ok).toBe(false);
    });

    test("live runs the health probe and folds it into the verdict", async () => {
        _resetPluginsForTest();
        registerPlugin(
            fakePlugin({
                credential: { fields: [], envKeys: [] },
                health: async () => ({ ok: false, detail: "endpoint unreachable" }),
            })
        );
        await addAccount({ provider: "fake", name: "probe" });

        expect((await testAccount("probe")).ok).toBe(true);
        expect((await testAccount("probe", { live: true })).ok).toBe(false);
        expect((await testAccount("probe", { live: true })).health?.detail).toBe("endpoint unreachable");
    });
});
