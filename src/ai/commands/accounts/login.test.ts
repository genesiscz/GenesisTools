import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCodexLoginCommand } from "@app/codex/commands/login";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import { _resetBuiltInPluginsForTest } from "@genesiscz/utils/ai/providers/plugins";
import { _resetPluginsForTest } from "@genesiscz/utils/ai/providers/registry";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
} from "@genesiscz/utils/security";
import { Command } from "commander";
import { registerAccountsCommands } from "./index";
import { registerAiProviderLoginCommands } from "./login";

let home: string;
let nativeHome: string;
let authFile: string;
let configFile: string;
let wasTty: boolean | undefined;

beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "gt-login-doors-")));
    nativeHome = join(home, "native");
    authFile = join(nativeHome, "auth.json");
    configFile = join(home, ".genesis-tools", "ai", "config.json");
    mkdirSync(nativeHome, { recursive: true });
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    const claims = Buffer.from(
        SafeJSON.stringify({ email: "alice@example.com", chatgpt_account_id: "workspace-invented" })
    ).toString("base64url");
    writeFileSync(
        authFile,
        SafeJSON.stringify({
            tokens: {
                access_token: "access-invented",
                refresh_token: "refresh-invented",
                id_token: `header.${claims}.signature`,
            },
        })
    );
    writeFileSync(configFile, SafeJSON.stringify({ version: CONFIG_VERSION, accounts: [], defaults: {} }));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    env.testing.set("CODEX_HOME", nativeHome);
    _setMasterKeyProvidersForTest([
        {
            id: "env",
            available: async () => true,
            get: async () => Buffer.alloc(32, 21),
            getSync: () => Buffer.alloc(32, 21),
            set: async () => {},
        },
    ]);
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
    AiConfigStore.invalidate();
    wasTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    process.exitCode = 0;
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    env.testing.unset("CODEX_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
    AiConfigStore.invalidate();
    Object.defineProperty(process.stdin, "isTTY", { value: wasTty, configurable: true });
    process.exitCode = 0;
});

function command(door: "codex" | "ai-codex" | "ai-accounts") {
    const program = new Command().exitOverride();
    if (door === "codex") {
        registerCodexLoginCommand(program);
        return { program, args: ["login", "work"] };
    }
    if (door === "ai-codex") {
        registerAiProviderLoginCommands(program);
        return { program, args: ["codex", "login", "work"] };
    }
    registerAccountsCommands(program);
    return { program, args: ["accounts", "login", "work", "--provider", "codex"] };
}

describe.each(["codex", "ai-codex", "ai-accounts"] as const)("%s login", (door) => {
    test.each([
        ["--broker", "--auth-file"],
        ["--broker", "--home"],
        ["--import-native", "--auth-file"],
        ["--import-native", "--home"],
        ["--broker", "--import-native"],
    ])("refuses conflicting %s %s before changing accounts", async (first, second) => {
        const { program, args } = command(door);
        const configBefore = readFileSync(configFile, "utf8");
        const authBefore = readFileSync(authFile, "utf8");
        const value = second === "--auth-file" ? [authFile] : second === "--home" ? [nativeHome] : [];
        await program.parseAsync([...args, first, second, ...value], { from: "user" });
        expect(process.exitCode).toBe(1);
        expect(readFileSync(configFile, "utf8")).toBe(configBefore);
        expect(readFileSync(authFile, "utf8")).toBe(authBefore);
    });

    test.each(["auth-file", "import-native"])("binds --%s through the shared account writer", async (flag) => {
        const { program, args } = command(door);
        const original = readFileSync(authFile, "utf8");
        await program.parseAsync([...args, `--${flag}`, ...(flag === "auth-file" ? [authFile] : [])], { from: "user" });
        const account = (await AiConfigStore.load()).account("work");
        expect(account?.provider).toBe("openai-sub");
        expect(account?.accountUuid).toBe("workspace-invented");
        expect(account?.credentials.authFile).toBe(authFile);
        expect(account?.credentials.accessToken).toBeUndefined();
        expect(readFileSync(authFile, "utf8")).toBe(original);
        expect(process.exitCode).toBe(0);
    });
});
