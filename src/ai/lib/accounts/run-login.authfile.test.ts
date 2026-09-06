import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/**
 * `--auth-file` binds, it never runs a flow.
 *
 * Every door describes the flag as "bind an existing credential file INSTEAD of
 * running a flow", but a provider that HAS an in-process flow ran it anyway, so
 * `tools codex login --auth-file x` performed OAuth and then overwrote the file
 * it was asked to import (PR #360 review t2).
 *
 * The fake plugin's `login` records AND throws, so a run that reaches it fails
 * loudly instead of passing quietly, and the imported file is compared byte for
 * byte rather than by a spy. Each refusal is paired with a control proving the
 * in-process flow still runs when nobody asked for a file.
 */

const KEY = Buffer.alloc(32, 19);
const IMPORTED = SafeJSON.stringify({ tokens: { access_token: "vendor-token-invented" } });

let home: string;
let authFile: string;
/** One entry per `login` call. The flow also throws where reaching it is the bug. */
let loginCalls: string[];
/** Cleared by the controls, which need the flow's RESULT rather than its refusal. */
let throwOnLogin = true;
let identityCalls: Array<{ name: string; probe?: boolean }>;
let identityResult: AccountIdentity | undefined;
let realIsTty: boolean | undefined;

function inProcessPlugin(id: string, accounts: AccountFeatures): ProviderPlugin {
    return {
        id,
        kind: "subscription",
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

function storedAccount(name: string): AiConfigData["accounts"][number] | undefined {
    const data: AiConfigData = SafeJSON.parse(readFileSync(configPath(), "utf8"), { strict: true });
    return data.accounts.find((entry) => entry.name === name);
}

function writeImportedFile(): void {
    mkdirSync(dirname(authFile), { recursive: true });
    writeFileSync(authFile, IMPORTED);
}

function setTty(value: boolean): void {
    Object.defineProperty(process.stdin, "isTTY", { value, configurable: true, writable: true });
}

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "gt-runlogin-authfile-"));
    authFile = join(home, "imported", "auth.json");
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => KEY, getSync: () => KEY, set: async () => {} },
    ]);
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest(true);

    loginCalls = [];
    identityCalls = [];
    identityResult = { accountUuid: "chatgpt-acct-1", email: "alice@example.com", plan: "plus" };

    registerPlugin(
        inProcessPlugin("openai-sub", {
            presentation: { displayName: "Codex", alias: "codex", limitOrder: [], prominentLimits: [] },
            logoutTargets: ["oauth", "authFile"],
            async login(ctx) {
                loginCalls.push(ctx.authFile ?? "no-auth-file");

                // Where the flag is honoured, reaching this is the bug under test;
                // the control below passes `throwOnLogin: false` to use the result.
                if (throwOnLogin) {
                    throw new Error("--auth-file must never run the in-process flow");
                }

                const written = join(home, "flow-wrote", "auth.json");
                mkdirSync(dirname(written), { recursive: true });
                writeFileSync(written, SafeJSON.stringify({ tokens: { access_token: "flow-token-invented" } }));

                return { provider: "openai-sub", credentials: { authFile: written }, identity: identityResult };
            },
            async identityOf(account, ctx) {
                identityCalls.push({ name: account.name, probe: ctx?.probe });
                return identityResult;
            },
        })
    );

    realIsTty = process.stdin.isTTY;
    setTty(false);
    process.exitCode = 0;

    await seed({ version: CONFIG_VERSION, accounts: [], defaults: {} });
});

afterEach(() => {
    throwOnLogin = true;
    setTty(realIsTty ?? false);
    process.exitCode = 0;
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
    AiConfigStore.invalidate();
});

function login(overrides: { name?: string; authFile?: string } = {}) {
    return runLogin({
        provider: "codex",
        tool: "tools codex login",
        subcommand: ["login"],
        ...overrides,
    });
}

describe("--auth-file on a provider that HAS an in-process flow", () => {
    test("binds the file in a pipe, without OAuth and without a TTY", async () => {
        writeImportedFile();

        const result = await login({ name: "work", authFile });

        expect(result.ok).toBe(true);
        // The flow records as well as throws, so any call would have failed above.
        expect(loginCalls).toEqual([]);
        expect(storedAccount("work")?.credentials.authFile).toBe(authFile);
        expect(storedAccount("work")?.provider).toBe("openai-sub");
        expect(identityCalls).toEqual([{ name: "work", probe: true }]);
    });

    test("leaves the imported file byte for byte as it found it", async () => {
        writeImportedFile();

        await login({ name: "work", authFile });

        expect(readFileSync(authFile, "utf8")).toBe(IMPORTED);
    });

    test("the fingerprint of the imported file lands on the account", async () => {
        writeImportedFile();

        await login({ name: "work", authFile });

        expect(storedAccount("work")?.accountUuid).toBe("chatgpt-acct-1");
        expect(storedAccount("work")?.label).toBe("plus");
    });

    test("with no name it is named after the identity the file proves", async () => {
        writeImportedFile();

        await login({ authFile });

        expect(storedAccount("alice")?.credentials.authFile).toBe(authFile);
    });
});

describe("NEGATIVE CONTROL: the in-process flow still runs", () => {
    test("no --auth-file means the provider's own login decides the destination", async () => {
        throwOnLogin = false;

        const result = await login({ name: "work" });

        expect(result.ok).toBe(true);
        expect(loginCalls).toEqual(["no-auth-file"]);
        expect(storedAccount("work")?.credentials.authFile).toBe(join(home, "flow-wrote", "auth.json"));
    });

    test("--auth-file naming a file that is NOT there still falls through to the flow", async () => {
        throwOnLogin = false;
        const missing = join(home, "not-created-yet", "auth.json");

        const result = await login({ name: "work", authFile: missing });

        // The flag creates as well as binds on providers whose flow can write it;
        // refusing here would break `tools grok login --auth-file <new path>`.
        expect(result.ok).toBe(true);
        expect(loginCalls).toEqual([missing]);
    });
});
