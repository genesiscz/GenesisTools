import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type AiConfigData, CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import type { AccountFeatures, LogoutTarget } from "@genesiscz/utils/ai/providers/account-features";
import type { BindContext, ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { _resetBuiltInPluginsForTest } from "@genesiscz/utils/ai/providers/plugins";
import { _resetPluginsForTest, registerPlugin } from "@genesiscz/utils/ai/providers/registry";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
} from "@genesiscz/utils/security";
import { logoutTargetsFromFlags } from "./logout-flags";
import { runLogout } from "./run-logout";

/**
 * `--all` means every credential the ACCOUNT holds, not every kind the provider
 * declares.
 *
 * Codex declares `oauth` and `authFile`, but an account created by the browser
 * login holds only the auth file. Expanding `--all` to the declared four made
 * `logout work --provider codex --all --yes` exit with "no oauth credential" and
 * remove nothing (PR #360 review t5). The same shape hit any Claude account
 * without a long-lived or secondary token.
 *
 * The removals are asserted against the config FILE, and each is paired with a
 * control proving an explicitly NAMED scope the account lacks is still an error.
 * Every handle here is invented.
 */

const KEY = Buffer.alloc(32, 29);

let home: string;
let errorLines: string[];
let realError: typeof out.error;
let realIsTty: boolean | undefined;

function fakePlugin(id: string, logoutTargets: LogoutTarget[]): ProviderPlugin {
    const accounts: AccountFeatures = {
        presentation: { displayName: "Codex", alias: "codex", limitOrder: [], prominentLimits: [] },
        logoutTargets,
    };

    return {
        id,
        kind: "subscription",
        capabilities: new Set(["chat"] as const),
        credential: { fields: ["authFile", "accessToken", "refreshToken"], envKeys: [] },
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

async function seed(credentials: AiConfigData["accounts"][number]["credentials"]): Promise<void> {
    const data: AiConfigData = {
        version: CONFIG_VERSION,
        accounts: [
            {
                id: "acc_work",
                name: "work",
                provider: "openai-sub",
                enabled: true,
                billing: { mode: "subscription" },
                credentials,
                useEnvApiKey: false,
            },
        ],
        defaults: {},
    };

    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(configPath(), SafeJSON.stringify(data, null, 2));
    AiConfigStore.invalidate();
    await AiConfigStore.load();
}

function storedCredentials(): AiConfigData["accounts"][number]["credentials"] {
    const data: AiConfigData = SafeJSON.parse(readFileSync(configPath(), "utf8"), { strict: true });
    return data.accounts[0]?.credentials ?? {};
}

function setTty(value: boolean): void {
    Object.defineProperty(process.stdin, "isTTY", { value, configurable: true, writable: true });
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-runlogout-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => KEY, getSync: () => KEY, set: async () => {} },
    ]);
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest(true);

    // Codex's real declaration: it CAN hold an OAuth pair, and usually does not.
    registerPlugin(fakePlugin("openai-sub", ["oauth", "authFile"]));

    errorLines = [];
    realError = out.error;
    out.error = (msg?: unknown, ...rest: unknown[]) => {
        errorLines.push([msg, ...rest].map(String).join(" "));
    };

    realIsTty = process.stdin.isTTY;
    setTty(false);
    process.exitCode = 0;
});

afterEach(() => {
    out.error = realError;
    setTty(realIsTty ?? false);
    process.exitCode = 0;
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
    AiConfigStore.invalidate();
});

function logout(flags: { all?: boolean; oauth?: boolean; authFile?: boolean }) {
    return runLogout({
        provider: "codex",
        name: "work",
        targets: logoutTargetsFromFlags(flags),
        all: flags.all,
        yes: true,
        tool: "tools ai accounts logout",
        subcommand: ["accounts", "logout"],
    });
}

describe("logoutTargetsFromFlags", () => {
    test("--all names no scope, because only the account knows what it holds", () => {
        expect(logoutTargetsFromFlags({ all: true })).toEqual([]);
    });

    test("NEGATIVE CONTROL: the individual flags still map to their scopes", () => {
        expect(logoutTargetsFromFlags({ oauth: true, authFile: true })).toEqual(["oauth", "authFile"]);
        expect(logoutTargetsFromFlags({ both: true })).toEqual(["oauth", "longLived"]);
        expect(logoutTargetsFromFlags({})).toEqual([]);
    });
});

describe("--all on an account holding only some of the declared kinds", () => {
    test("removes the auth file rather than refusing over an oauth pair it never had", async () => {
        await seed({ authFile: join(home, ".codex", "auth.json") });

        await logout({ all: true });

        expect(errorLines).toEqual([]);
        expect(process.exitCode).toBe(0);
        expect(storedCredentials().authFile).toBeUndefined();
    });

    test("NEGATIVE CONTROL: naming --oauth explicitly is still an error on that account", async () => {
        await seed({ authFile: join(home, ".codex", "auth.json") });

        await logout({ oauth: true });

        expect(errorLines.join("\n")).toContain("no oauth credential");
        expect(process.exitCode).toBe(1);
        // A refused logout removes nothing, so the file reference survives.
        expect(storedCredentials().authFile).toBeDefined();
    });

    test("NEGATIVE CONTROL: an account holding both kinds still loses both", async () => {
        await seed({
            authFile: join(home, ".codex", "auth.json"),
            accessToken: "sk-invented-access",
            refreshToken: "sk-invented-refresh",
        });

        await logout({ all: true });

        expect(process.exitCode).toBe(0);
        expect(storedCredentials().authFile).toBeUndefined();
        expect(storedCredentials().accessToken).toBeUndefined();
        expect(storedCredentials().refreshToken).toBeUndefined();
    });
});

/**
 * PR #359 review t10. `runLogout` hands the resolved account's id straight to
 * `clearCredentials`, which is irreversible, so resolving an ambiguous name to
 * the first match wiped whichever account happened to come first in the config.
 * The assertion is byte equality of the config file, not a spy: it proves no
 * route wrote anything.
 */
describe("an ambiguous account name never reaches clearCredentials", () => {
    async function seedTwoNamesakes(): Promise<void> {
        const data: AiConfigData = {
            version: CONFIG_VERSION,
            accounts: [
                {
                    id: "acc_work_first",
                    name: "work",
                    provider: "openai-sub",
                    enabled: true,
                    billing: { mode: "subscription" },
                    credentials: { authFile: join(home, ".codex-first", "auth.json") },
                    useEnvApiKey: false,
                },
                {
                    id: "acc_work_second",
                    name: "work",
                    provider: "openai-sub",
                    enabled: true,
                    billing: { mode: "subscription" },
                    credentials: { authFile: join(home, ".codex-second", "auth.json") },
                    useEnvApiKey: false,
                },
            ],
            defaults: {},
        };

        mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
        writeFileSync(configPath(), SafeJSON.stringify(data, null, 2));
        AiConfigStore.invalidate();
        await AiConfigStore.load();
    }

    test("--all --yes on a shared name refuses and clears nothing", async () => {
        await seedTwoNamesakes();
        const before = readFileSync(configPath(), "utf8");

        await logout({ all: true });

        expect(errorLines.join("\n")).toContain("ambiguous");
        expect(process.exitCode).toBe(1);
        expect(readFileSync(configPath(), "utf8")).toBe(before);
    });

    test("NEGATIVE CONTROL: naming one by its id does clear that one, and only that one", async () => {
        await seedTwoNamesakes();

        await runLogout({
            provider: "codex",
            name: "acc_work_second",
            targets: [],
            all: true,
            yes: true,
            tool: "tools ai accounts logout",
            subcommand: ["accounts", "logout"],
        });

        const after: AiConfigData = SafeJSON.parse(readFileSync(configPath(), "utf8"), { strict: true });
        expect(after.accounts.find((entry) => entry.id === "acc_work_second")?.credentials.authFile).toBeUndefined();
        expect(after.accounts.find((entry) => entry.id === "acc_work_first")?.credentials.authFile).toBeDefined();
    });
});
