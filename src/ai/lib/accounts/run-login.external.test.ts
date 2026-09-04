import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { type AiConfigData, CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import type {
    AccountFeatures,
    AccountIdentity,
    ExternalLoginInstruction,
} from "@genesiscz/utils/ai/providers/account-features";
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
import { type ExternalLoginRunner, runLogin } from "./run-login";

/**
 * The error paths of `bindExternalLogin` — the flow grok uses, where the vendor
 * CLI writes the credential and we only bind the file it left behind.
 *
 * Every refusal is asserted against the CONFIG FILE ON DISK as well as the
 * spies: byte equality proves nothing was written by ANY route, while the spies
 * prove the vendor command was never spawned. Both runner spies THROW as well as
 * record where reaching them would be a bug, so a leak fails loudly instead of
 * passing quietly. Each refusal is paired with a negative control proving the
 * normal path still binds.
 *
 * The fakes are registered under the REAL plugin ids, because `--provider` is
 * resolved through the alias map (`grok` -> `grok-sub`) and an invented id never
 * reaches the plugin at all.
 */

const KEY = Buffer.alloc(32, 13);
const VENDOR_COMMAND = ["fake-vendor-cli", "login"];

let home: string;
let authFile: string;

/** Records every runner call. The forbidden runner also throws. */
let confirmCalls: string[];
let runCalls: string[];
/** `{ name, probe }` per `identityOf` call, so probe purity is observable. */
let identityCalls: Array<{ name: string; probe?: boolean }>;
let identityResult: AccountIdentity | undefined;
let errorLines: string[];
let realError: typeof out.error;
let realIsTty: boolean | undefined;

function externalPlugin(id: string, accounts: AccountFeatures): ProviderPlugin {
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

/** Seed the config and let the vault migration settle, so a later byte check measures only the login. */
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

function writeAuthFile(): void {
    mkdirSync(dirname(authFile), { recursive: true });
    writeFileSync(authFile, SafeJSON.stringify({ default: { key: "vendor-token" } }));
}

/** Reaching either half is the bug under test, so both record AND throw. */
const forbiddenRunner: ExternalLoginRunner = {
    async confirm() {
        confirmCalls.push("confirm");
        throw new Error("an existing credential file must never prompt");
    },
    async run() {
        runCalls.push("run");
        throw new Error("an existing credential file must never spawn the vendor CLI");
    },
};

function runner(opts: { confirm: boolean; exitCode?: number; writesFile?: boolean }): ExternalLoginRunner {
    return {
        async confirm(instruction: ExternalLoginInstruction) {
            confirmCalls.push(instruction.authFile);
            return opts.confirm;
        },
        async run(instruction: ExternalLoginInstruction) {
            runCalls.push(instruction.command.join(" "));

            if (opts.writesFile) {
                writeAuthFile();
            }

            return opts.exitCode ?? 0;
        },
    };
}

/** `isInteractive()` reads `process.stdin.isTTY`; the runner seam replaces the prompt itself. */
function setTty(value: boolean): void {
    Object.defineProperty(process.stdin, "isTTY", { value, configurable: true, writable: true });
}

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "gt-runlogin-ext-"));
    authFile = join(home, "vendor-home", "auth.json");
    env.testing.set("GENESIS_TOOLS_HOME", home);
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => KEY, getSync: () => KEY, set: async () => {} },
    ]);
    _resetSecretsForTest();
    _resetPluginsForTest();
    // Claims the built-ins are already registered, so `runLogin` keeps the fakes
    // registered below under the real ids instead of adding the real plugins.
    _resetBuiltInPluginsForTest(true);

    confirmCalls = [];
    runCalls = [];
    identityCalls = [];
    identityResult = { accountUuid: "user-1", email: "alice@example.com" };

    registerPlugin(
        externalPlugin("grok-sub", {
            presentation: { displayName: "Grok", alias: "grok", limitOrder: [], prominentLimits: [] },
            logoutTargets: ["authFile"],
            externalLogin: (ctx) => ({
                command: VENDOR_COMMAND,
                env: { FAKE_VENDOR_HOME: home },
                authFile: ctx.authFile ?? authFile,
            }),
            async identityOf(account, ctx) {
                identityCalls.push({ name: account.name, probe: ctx?.probe });
                return identityResult;
            },
        })
    );

    // A provider with account features but no flow at all, for the "no login flow" refusal.
    registerPlugin(
        externalPlugin("openai-sub", {
            presentation: { displayName: "Codex", alias: "codex", limitOrder: [], prominentLimits: [] },
            logoutTargets: ["authFile"],
        })
    );

    errorLines = [];
    realError = out.error;
    out.error = (msg?: unknown, ...rest: unknown[]) => {
        errorLines.push([msg, ...rest].map(String).join(" "));
    };

    realIsTty = process.stdin.isTTY;
    setTty(false);
    process.exitCode = 0;

    await seed({ version: CONFIG_VERSION, accounts: [], defaults: {} });
});

afterEach(() => {
    out.error = realError;
    setTty(realIsTty ?? false);
    // Every refusal sets it; leaving it set would fail the whole test run.
    process.exitCode = 0;
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
    AiConfigStore.invalidate();
});

function login(overrides: { name?: string; externalRunner?: ExternalLoginRunner } = {}) {
    return runLogin({
        provider: "grok",
        tool: "tools grok login",
        subcommand: ["login"],
        ...overrides,
    });
}

describe("an existing credential file", () => {
    test("binds the file without prompting or spawning the vendor command", async () => {
        writeAuthFile();

        const result = await login({ name: "work", externalRunner: forbiddenRunner });

        expect(result.ok).toBe(true);
        // Both spies throw as well as record, so any call would have failed above.
        expect(confirmCalls).toEqual([]);
        expect(runCalls).toEqual([]);
        expect(storedAccount("work")?.credentials.authFile).toBe(authFile);
        expect(storedAccount("work")?.provider).toBe("grok-sub");
        expect(identityCalls).toEqual([{ name: "work", probe: true }]);
    });
});

describe("nothing to bind", () => {
    test("non-TTY refuses, spawns nothing and writes nothing", async () => {
        const before = readFileSync(configPath(), "utf8");

        const result = await login({ name: "work", externalRunner: forbiddenRunner });

        expect(result.ok).toBe(false);
        expect(process.exitCode).toBe(1);
        expect(confirmCalls).toEqual([]);
        expect(runCalls).toEqual([]);
        expect(errorLines.join("\n")).toContain(authFile);
        // Byte equality is the assertion: no write reached the config by any route.
        expect(readFileSync(configPath(), "utf8")).toBe(before);
        expect(storedAccount("work")).toBeUndefined();
    });

    test("declining the command spawns nothing and writes nothing", async () => {
        setTty(true);
        const before = readFileSync(configPath(), "utf8");

        const result = await login({ name: "work", externalRunner: runner({ confirm: false }) });

        expect(result.ok).toBe(false);
        expect(process.exitCode).toBe(1);
        expect(confirmCalls).toEqual([authFile]);
        expect(runCalls).toEqual([]);
        expect(readFileSync(configPath(), "utf8")).toBe(before);
        expect(storedAccount("work")).toBeUndefined();
    });

    test("a command that writes no file binds nothing and names the path it expected", async () => {
        setTty(true);
        const before = readFileSync(configPath(), "utf8");

        const result = await login({ name: "work", externalRunner: runner({ confirm: true }) });

        expect(result.ok).toBe(false);
        expect(process.exitCode).toBe(1);
        expect(runCalls).toEqual([VENDOR_COMMAND.join(" ")]);
        expect(existsSync(authFile)).toBe(false);
        expect(errorLines.join("\n")).toContain(authFile);
        expect(readFileSync(configPath(), "utf8")).toBe(before);
        expect(storedAccount("work")).toBeUndefined();
    });

    test("a non-zero exit that wrote no file binds nothing, but the code is never surfaced", async () => {
        setTty(true);
        const before = readFileSync(configPath(), "utf8");

        const result = await login({ name: "work", externalRunner: runner({ confirm: true, exitCode: 42 }) });

        expect(result.ok).toBe(false);
        expect(process.exitCode).toBe(1);
        expect(runCalls).toEqual([VENDOR_COMMAND.join(" ")]);
        expect(readFileSync(configPath(), "utf8")).toBe(before);
        // Pinning today's contract, not endorsing it: `await proc.exited` is
        // discarded, so a vendor CLI that failed loudly is reported only as a
        // missing file. Nothing tells the user the command exited 42. The path is
        // masked first, because a random temp dir could carry those characters.
        const message = errorLines.join("\n").replaceAll(authFile, "<authFile>");
        expect(message).toContain("Still no credential at");
        expect(message).not.toContain("42");
        expect(message.toLowerCase()).not.toContain("exit");
    });

    test("a provider with neither an in-process nor an external flow says so and writes nothing", async () => {
        const before = readFileSync(configPath(), "utf8");

        const result = await runLogin({ provider: "codex", name: "side", tool: "tools codex login" });

        expect(result.ok).toBe(false);
        expect(process.exitCode).toBe(1);
        expect(errorLines.join("\n")).toContain("has no login flow");
        expect(readFileSync(configPath(), "utf8")).toBe(before);
    });
});

/**
 * The refusals must be scoped to "the file is not there". If one leaked into the
 * normal path, grok could never log in at all — a worse bug than the one pinned
 * above.
 */
describe("negative control: a command that writes the file still binds", () => {
    test("running the vendor command and binding what it wrote saves the account", async () => {
        setTty(true);

        const result = await login({ name: "work", externalRunner: runner({ confirm: true, writesFile: true }) });

        expect(result.ok).toBe(true);
        expect(process.exitCode).toBe(0);
        expect(confirmCalls).toEqual([authFile]);
        expect(runCalls).toEqual([VENDOR_COMMAND.join(" ")]);
        expect(storedAccount("work")?.credentials.authFile).toBe(authFile);
        expect(identityCalls).toEqual([{ name: "work", probe: true }]);
    });
});

describe("an identity the provider cannot prove", () => {
    test("identityOf returning undefined still binds, under the provider alias", async () => {
        identityResult = undefined;
        writeAuthFile();

        const result = await login();

        // Documented, not accidental: `applyIdentityPolicy` writes an unprovable
        // identity because refusing would block every first login. With no email
        // to derive a name from, the account lands under the provider alias.
        expect(result.ok).toBe(true);
        expect(result.account?.name).toBe("grok");
        expect(storedAccount("grok")?.credentials.authFile).toBe(authFile);
        expect(storedAccount("grok")?.accountUuid).toBeUndefined();
        expect(identityCalls).toEqual([{ name: "grok", probe: true }]);
    });

    test("a proven identity names the account but is still not persisted on it", async () => {
        identityResult = { accountUuid: "user-1", email: "alice@example.com" };
        writeAuthFile();

        const result = await login();

        expect(result.account?.name).toBe("alice");
        // The external flow returns `identity` but no `accountFields`, and only
        // `accountFields` reaches the account. So a re-login of this account has
        // no stored uuid for the identity guard to contradict.
        expect(storedAccount("alice")?.accountUuid).toBeUndefined();
        expect(storedAccount("alice")?.credentials.authFile).toBe(authFile);
    });
});
