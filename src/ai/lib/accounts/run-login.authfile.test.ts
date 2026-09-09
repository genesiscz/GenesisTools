import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type AiConfigData, CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import type { AccountFeatures, AccountIdentity } from "@genesiscz/utils/ai/providers/account-features";
import type { BindContext, ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { _resetBuiltInPluginsForTest, registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
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
/** What the flow was handed, so the path normalization is observable. */
let loginCtx: { home?: string; authFile?: string } | undefined;
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
    // Realpath: on macOS `/var` is a symlink to `/private/var`, and `process.cwd()`
    // reports the physical path, so an un-resolved temp dir makes every
    // absolute-path expectation below differ from the value the code produces.
    home = realpathSync(mkdtempSync(join(tmpdir(), "gt-runlogin-authfile-")));
    authFile = join(home, "imported", "auth.json");
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => KEY, getSync: () => KEY, set: async () => {} },
    ]);
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest(true);

    loginCalls = [];
    loginCtx = undefined;
    identityCalls = [];
    identityResult = { accountUuid: "chatgpt-acct-1", email: "alice@example.com", plan: "plus" };

    registerPlugin(
        inProcessPlugin("openai-sub", {
            presentation: { displayName: "Codex", alias: "codex", limitOrder: [], prominentLimits: [] },
            logoutTargets: ["oauth", "authFile"],
            async login(ctx) {
                loginCalls.push(ctx.authFile ?? "no-auth-file");
                loginCtx = { home: ctx.home, authFile: ctx.authFile };

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

function login(overrides: { name?: string; authFile?: string; home?: string } = {}) {
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

describe("paths are absolute before anything stores or reads them", () => {
    /** `process.chdir` is process-wide, so every case restores it. */
    async function fromDirectory<T>(dir: string, body: () => Promise<T>): Promise<T> {
        const before = process.cwd();
        process.chdir(dir);

        try {
            return await body();
        } finally {
            process.chdir(before);
        }
    }

    test("a relative --auth-file is persisted absolute, not relative to the shell that typed it", async () => {
        writeImportedFile();

        await fromDirectory(join(home, "imported"), () => login({ name: "work", authFile: "./auth.json" }));

        expect(storedAccount("work")?.credentials.authFile).toBe(authFile);
        expect(isAbsolute(storedAccount("work")?.credentials.authFile ?? "")).toBe(true);
    });

    test("the identity probe reads the resolved path too, so binding works from any directory", async () => {
        writeImportedFile();

        await fromDirectory(home, () => login({ name: "work", authFile: join("imported", "auth.json") }));

        // A relative reference would have made the probe miss the file entirely,
        // so the fingerprint landing is what proves the path was resolved first.
        expect(storedAccount("work")?.accountUuid).toBe("chatgpt-acct-1");
        expect(storedAccount("work")?.credentials.authFile).toBe(authFile);
    });

    test("a relative --home reaches the provider flow already resolved", async () => {
        throwOnLogin = false;

        await fromDirectory(home, () => login({ name: "work", home: "./profile" }));

        expect(loginCtx?.home).toBe(join(home, "profile"));
        expect(isAbsolute(loginCtx?.home ?? "")).toBe(true);
    });

    test("NEGATIVE CONTROL: an absolute path is handed through unchanged", async () => {
        throwOnLogin = false;
        const explicit = join(home, "already-absolute");

        await login({ name: "work", home: explicit });

        expect(loginCtx?.home).toBe(explicit);
    });
});

/**
 * PR #359 review t6 asked for the bind to be proven against the BUILT-IN Codex
 * provider, not a stand-in. The real `openai-sub` plugin points `login` at
 * `codexLogin`, whose first statement throws "Codex login needs a TTY", so a
 * dispatch that reached the flow fails loudly here — the built-in is its own
 * tripwire, and no browser or token exchange can occur.
 */
describe("the built-in Codex provider", () => {
    /** An `auth.json` in the shape the official CLI writes, with invented claims. */
    function writeCodexAuthFile(path: string, email: string, accountUuid: string): string {
        const claims = Buffer.from(
            SafeJSON.stringify({ email, chatgpt_account_id: accountUuid, "https://api.openai.com/auth": {} })
        ).toString("base64url");
        const contents = SafeJSON.stringify(
            {
                auth_mode: "chatgpt",
                tokens: {
                    id_token: `eyJhbGciOiJIUzI1NiJ9.${claims}.not-a-signature`,
                    access_token: "codex-access-invented",
                    refresh_token: "codex-refresh-invented",
                },
                last_refresh: new Date(0).toISOString(),
            },
            null,
            2
        );

        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents);
        return contents;
    }

    beforeEach(() => {
        // Replace the fake registered above with the genuine plugin table.
        _resetPluginsForTest();
        _resetBuiltInPluginsForTest();
        registerBuiltInPlugins();
    });

    test("--auth-file binds in a pipe, where the real flow would have demanded a TTY", async () => {
        const codexFile = join(home, ".codex-imported", "auth.json");
        const contents = writeCodexAuthFile(codexFile, "alice@example.com", "chatgpt-acct-real");

        const result = await login({ name: "work", authFile: codexFile });

        expect(result.ok).toBe(true);
        expect(storedAccount("work")?.provider).toBe("openai-sub");
        expect(storedAccount("work")?.credentials.authFile).toBe(codexFile);
        // Decoded by the real `identityOf`, from the file and nothing else.
        expect(storedAccount("work")?.accountUuid).toBe("chatgpt-acct-real");
        // No OAuth: the vendor file is exactly as it was found.
        expect(readFileSync(codexFile, "utf8")).toBe(contents);
    });

    test("a cancelled Codex login exits cleanly without changing accounts", async () => {
        setTty(true);
        const before = readFileSync(configPath(), "utf8");
        const result = await runLogin({
            provider: "codex",
            name: "work",
            tool: "tools codex login",
            authorizationInteraction: {
                chooseUrlAction: async () => null,
                readCode: async () => {
                    throw new Error("code input must not follow cancellation");
                },
            },
        });
        expect(result).toEqual({ ok: false, cancelled: true });
        expect(process.exitCode).toBe(0);
        expect(readFileSync(configPath(), "utf8")).toBe(before);
    });

    test("--import-native binds the current CLI home as a reference", async () => {
        const nativeHome = join(home, "native");
        const nativeFile = join(nativeHome, "auth.json");
        const contents = writeCodexAuthFile(nativeFile, "alice@example.com", "account-native-invented");
        env.testing.set("CODEX_HOME", nativeHome);
        try {
            const result = await runLogin({
                provider: "codex",
                name: "work",
                importNative: true,
                tool: "tools codex login",
            });
            expect(result.ok).toBe(true);
            expect(result.account?.credentials.authFile).toBe(nativeFile);
            expect(result.account?.credentials.accessToken).toBeUndefined();
            expect(result.account?.accountUuid).toBe("account-native-invented");
            expect(readFileSync(nativeFile, "utf8")).toBe(contents);
        } finally {
            env.testing.unset("CODEX_HOME");
        }
    });

    test("missing --import-native fails without starting OAuth or creating a home", async () => {
        const nativeHome = join(home, "absent-native");
        env.testing.set("CODEX_HOME", nativeHome);
        const before = readFileSync(configPath(), "utf8");
        try {
            const result = await runLogin({
                provider: "codex",
                name: "work",
                importNative: true,
                tool: "tools codex login",
            });
            expect(result.ok).toBe(false);
            expect(process.exitCode).toBe(1);
            expect(existsSync(nativeHome)).toBe(false);
            expect(readFileSync(configPath(), "utf8")).toBe(before);
        } finally {
            env.testing.unset("CODEX_HOME");
        }
    });

    test("NEGATIVE CONTROL: without --auth-file the real flow does refuse a pipe", async () => {
        // Proves the tripwire above is armed — the built-in flow is reachable and
        // rejects non-TTY, so the passing test above cannot be a false green.
        await expect(login({ name: "work" })).rejects.toThrow(/needs a TTY/);
    });
});

describe("built-in provider credential contracts", () => {
    beforeEach(() => {
        _resetPluginsForTest();
        _resetBuiltInPluginsForTest();
        registerBuiltInPlugins();
    });

    function writeGrokAuthFile(): string {
        const claims = Buffer.from(SafeJSON.stringify({ sub: "grok-user-invented", tier: 1 })).toString("base64url");
        const contents = SafeJSON.stringify({ default: { key: `eyJhbGciOiJIUzI1NiJ9.${claims}.not-a-signature` } });
        mkdirSync(dirname(authFile), { recursive: true });
        writeFileSync(authFile, contents);

        return contents;
    }

    test("allows built-in Grok authFile binding", async () => {
        const contents = writeGrokAuthFile();

        const result = await runLogin({ provider: "grok", name: "work", tool: "tools grok login", authFile });

        expect(result.ok).toBe(true);
        expect(result.account?.credentials.authFile).toBe(authFile);
        expect(result.account?.accountUuid).toBe("grok-user-invented");
        expect(readFileSync(authFile, "utf8")).toBe(contents);
    });

    /**
     * `--home` changed meaning when grok grew its own OIDC flow (issue #377): it used to
     * bind the file `grok login` had written, and now it WRITES the login it performs into
     * that home. So it needs a browser, and a pipe gets a refusal instead of a silent
     * re-login. `--auth-file` above is the binding door and still works headless.
     *
     * The byte comparison is the point: a refusal that had already replaced the file would
     * be worse than the old behaviour, not better.
     */
    test("built-in Grok --home performs a login, so a pipe is refused with the file untouched", async () => {
        const contents = writeGrokAuthFile();

        await expect(
            runLogin({ provider: "grok", name: "work", tool: "tools grok login", home: dirname(authFile) })
        ).rejects.toThrow(/needs a TTY/);

        expect(readFileSync(authFile, "utf8")).toBe(contents);
    });

    // Regression test: h_dly4ln58 — reject unsupported options even before loading or migrating the account store.
    test.each(["authFile", "home"] as const)("rejects Claude %s before accessing config", async (option) => {
        const invalidConfig = "not valid config";
        writeFileSync(configPath(), invalidConfig);
        AiConfigStore.invalidate();
        const missing = join(home, "not-created-yet");

        const result = await runLogin({
            provider: "claude",
            name: "work",
            tool: "tools ai accounts",
            ...(option === "authFile" ? { authFile: join(missing, "auth.json") } : { home: missing }),
        });

        expect(result.ok).toBe(false);
        expect(process.exitCode).toBe(1);
        expect(readFileSync(configPath(), "utf8")).toBe(invalidConfig);
        expect(existsSync(missing)).toBe(false);
    });

    // Regression test: h_dly4ln58 — unsupported file options must not create or falsely refresh Claude accounts.
    test.each([
        ["new", "authFile"],
        ["existing", "authFile"],
        ["new", "home"],
        ["existing", "home"],
    ] as const)("refuses Claude %s account %s binding without writes", async (state, option) => {
        if (state === "existing") {
            await seed({
                version: CONFIG_VERSION,
                accounts: [
                    {
                        id: "acc_work",
                        name: "work",
                        provider: "anthropic-sub",
                        enabled: true,
                        billing: { mode: "subscription" },
                        useEnvApiKey: false,
                        credentials: { accessToken: "access-invented", refreshToken: "refresh-invented" },
                    },
                ],
                defaults: {},
            });
        }

        writeImportedFile();
        const vaultFile = join(home, ".genesis-tools", "security", "vault.json");
        const configBefore = readFileSync(configPath(), "utf8");
        const vaultBefore = existsSync(vaultFile) ? readFileSync(vaultFile, "utf8") : undefined;

        const result = await runLogin({
            provider: "claude",
            name: "work",
            tool: "tools ai accounts",
            ...(option === "authFile" ? { authFile } : { home: dirname(authFile) }),
        });

        expect(result.ok).toBe(false);
        expect(process.exitCode).toBe(1);
        expect(readFileSync(configPath(), "utf8")).toBe(configBefore);
        expect(existsSync(vaultFile) ? readFileSync(vaultFile, "utf8") : undefined).toBe(vaultBefore);
        expect(readFileSync(authFile, "utf8")).toBe(IMPORTED);
    });
});
