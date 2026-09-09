import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type AiConfigData, CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import type { AccountFeatures, AccountIdentity } from "@genesiscz/utils/ai/providers/account-features";
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
import { runLogin } from "./run-login";
import { writeLoginOutcome } from "./write-outcome";

/**
 * The flow writes the vendor credential BEFORE the CLI layer decides anything.
 *
 * `codexLogin` replaces `auth.json` and only then returns, so every failure after
 * that point owes a rollback. Before PR #368 review t1 the window between the
 * flow and `writeLoginOutcome` had none: an unnamed login whose suggested name
 * matched two configured accounts threw out of `account()` with the new
 * credential left on disk, and the existing account went on reading it.
 *
 * Every refusal below is measured as the ROLLBACK COUNT plus the config file's
 * bytes, so a guard that fires twice fails here as loudly as one that never
 * fires, and each is paired with a control proving a normal login still commits.
 */

const KEY = Buffer.alloc(32, 23);

let home: string;
/** One entry per rollback, so a double rollback is visible as a count of 2. */
let rollbacks: number;
let identityResult: AccountIdentity | undefined;
let suggestedName: string | undefined;
let realIsTty: boolean | undefined;

function flowPlugin(id: string, accounts: AccountFeatures): ProviderPlugin {
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

function configPath(): string {
    return join(home, ".genesis-tools", "ai", "config.json");
}

async function seed(data: AiConfigData): Promise<void> {
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(configPath(), SafeJSON.stringify(data, null, 2));
    AiConfigStore.invalidate();
    await AiConfigStore.load();
}

function configBytes(): string {
    return readFileSync(configPath(), "utf8");
}

function storedAccounts(name: string): AiConfigData["accounts"] {
    const data: AiConfigData = SafeJSON.parse(configBytes(), { strict: true });
    return data.accounts.filter((entry) => entry.name === name);
}

function account(overrides: Partial<AiConfigData["accounts"][number]>): AiConfigData["accounts"][number] {
    return {
        id: "acc_one",
        name: "alice",
        provider: "openai-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: { accessToken: "sk-fake-EXISTING" },
        useEnvApiKey: false,
        ...overrides,
    };
}

beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "gt-runlogin-rollback-")));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => KEY, getSync: () => KEY, set: async () => {} },
    ]);
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest(true);

    rollbacks = 0;
    identityResult = { accountUuid: "acct-incoming", email: "alice@example.com" };
    suggestedName = "alice";

    registerPlugin(
        flowPlugin("openai-sub", {
            presentation: { displayName: "Codex", alias: "codex", limitOrder: [], prominentLimits: [] },
            logoutTargets: ["oauth"],
            async login() {
                // The shape `codexLogin` returns once it has already replaced the
                // vendor file: credentials, an identity, and the undo for that write.
                return {
                    provider: "openai-sub",
                    credentials: { accessToken: "sk-fake-FRESH" },
                    ...(identityResult ? { identity: identityResult } : {}),
                    ...(suggestedName ? { suggestedName } : {}),
                    rollback: async () => {
                        rollbacks += 1;
                    },
                };
            },
            async identityOf(entry) {
                return { accountUuid: entry.accountUuid };
            },
        })
    );

    realIsTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true, writable: true });
    process.exitCode = 0;

    await seed({ version: CONFIG_VERSION, accounts: [], defaults: {} });
});

afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: realIsTty ?? false, configurable: true, writable: true });
    process.exitCode = 0;
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
    AiConfigStore.invalidate();
});

function login(overrides: { name?: string } = {}) {
    return runLogin({ provider: "codex", tool: "tools codex login", subcommand: ["login"], ...overrides });
}

describe("runLogin rolls the flow back when the post-flow lookup fails", () => {
    test("an ambiguous suggested name rolls back before the error leaves runLogin", async () => {
        await seed({
            version: CONFIG_VERSION,
            accounts: [account({ id: "acc_one" }), account({ id: "acc_two" })],
            defaults: {},
        });
        const before = configBytes();

        await expect(login()).rejects.toThrow(/ambiguous/);

        expect(rollbacks).toBe(1);
        expect(configBytes()).toBe(before);
    });

    test("NEGATIVE CONTROL: an unambiguous name commits and never rolls back", async () => {
        const result = await login();

        expect(result.ok).toBe(true);
        expect(rollbacks).toBe(0);
        expect(storedAccounts("alice")).toHaveLength(1);
    });

    test("a refused identity rolls back exactly once, not once per guard", async () => {
        await seed({
            version: CONFIG_VERSION,
            accounts: [account({ accountUuid: "acct-stored" })],
            defaults: {},
        });
        const before = configBytes();

        const result = await login({ name: "alice" });

        expect(result.ok).toBe(false);
        expect(rollbacks).toBe(1);
        expect(configBytes()).toBe(before);
    });
});

describe("writeLoginOutcome rolls back when the locked write itself refuses", () => {
    test("an account deleted while the flow ran rolls back and rethrows", async () => {
        await seed({ version: CONFIG_VERSION, accounts: [], defaults: {} });

        // The id the caller resolved is gone by the time the lock is taken, which
        // is what `applyLoginOutcome` refuses. Nothing is written either way, so
        // the vendor file this flow replaced has to go back.
        await expect(
            writeLoginOutcome({
                name: "alice",
                outcome: {
                    provider: "openai-sub",
                    credentials: { accessToken: "sk-fake-FRESH" },
                    rollback: async () => {
                        rollbacks += 1;
                    },
                },
                interactive: false,
                account: account({ id: "acc_deleted" }),
            })
        ).rejects.toThrow(/no longer exists/);

        expect(rollbacks).toBe(1);
    });

    test("NEGATIVE CONTROL: a write that lands never rolls back", async () => {
        await seed({ version: CONFIG_VERSION, accounts: [account({ id: "acc_one" })], defaults: {} });

        const written = await writeLoginOutcome({
            name: "alice",
            outcome: {
                provider: "openai-sub",
                credentials: { accessToken: "sk-fake-FRESH" },
                rollback: async () => {
                    rollbacks += 1;
                },
            },
            interactive: false,
            account: account({ id: "acc_one" }),
        });

        expect(written).not.toBeNull();
        expect(rollbacks).toBe(0);
    });
});
