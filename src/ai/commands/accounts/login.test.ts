import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgentTool } from "@app/ai/commands/agent/register";
import { CLAUDE_REGISTRARS } from "@app/claude/registrars";
import { codexSpec } from "@app/codex/lib/spec";
import { grokSpec } from "@app/grok/lib/spec";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import type { AccountFlowContext } from "@genesiscz/utils/ai/providers/account-features";
import type { ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { _resetBuiltInPluginsForTest } from "@genesiscz/utils/ai/providers/plugins";
import { anthropicSubPlugin } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub";
import { grokSubPlugin } from "@genesiscz/utils/ai/providers/plugins/grok-sub";
import { openAiSubPlugin } from "@genesiscz/utils/ai/providers/plugins/openai-sub";
import { _resetPluginsForTest, registerPlugin } from "@genesiscz/utils/ai/providers/registry";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
} from "@genesiscz/utils/security";
import { Command } from "commander";
import { registerAccountsCommands } from "./index";
import { registerAccountLoginCommand, registerAiProviderLoginCommands } from "./login";

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
        // The whole tool, not just its login: `tools codex login` is one verb that
        // `registerAgentTool` produces from the spec, and the point of this door is that it
        // reaches the same `runLogin` as the two below it.
        registerAgentTool(program, codexSpec);
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

/**
 * Every door a person can type a login into, built the way the real tool builds it. The claude door
 * loads only the three `tools claude` registrars it needs, through the same table `tools claude` reads.
 */
type Door = "claude" | "codex" | "grok" | "ai-codex" | "ai-accounts";

/** Where each door mounts its login verbs, below the program root. */
const MOUNT: Record<Door, string[]> = {
    claude: [],
    codex: [],
    grok: [],
    "ai-codex": ["codex"],
    "ai-accounts": ["accounts"],
};

async function doorProgram(door: Door): Promise<Command> {
    const program = new Command().exitOverride();

    if (door === "claude") {
        for (const verb of ["login", "login-long", "login-secondary"]) {
            const entry = CLAUDE_REGISTRARS.find((candidate) => candidate.names.includes(verb));

            if (!entry) {
                throw new Error(`tools claude has no registrar for ${verb}`);
            }

            (await entry.load())(program);
        }
    } else if (door === "codex") {
        registerAgentTool(program, codexSpec);
    } else if (door === "grok") {
        registerAgentTool(program, grokSpec);
    } else if (door === "ai-codex") {
        registerAiProviderLoginCommands(program);
    } else {
        registerAccountsCommands(program);
    }

    return program;
}

function commandAt(program: Command, path: string[]): Command | undefined {
    let current: Command | undefined = program;

    for (const name of path) {
        current = current?.commands.find((candidate) => candidate.name() === name);
    }

    return current;
}

/** Each option a verb declares, as `[long flag, hidden from --help]`, in declaration order. */
async function optionsOf(
    door: Door,
    verb: string
): Promise<ReadonlyArray<readonly [string | undefined, boolean]> | "absent"> {
    const command = commandAt(await doorProgram(door), [...MOUNT[door], verb]);

    if (!command) {
        return "absent";
    }

    return command.options.map((option) => [option.long, option.hidden] as const);
}

const FILE_FLAGS: ReadonlyArray<readonly [string, boolean]> = [
    ["--home", false],
    ["--auth-file", false],
    ["--import-native", false],
];

describe("the flags each login door declares", () => {
    test.each([
        ["claude", [["--broker", true]]],
        ["codex", [...FILE_FLAGS, ["--broker", false]]],
        ["grok", [...FILE_FLAGS, ["--broker", true]]],
        ["ai-codex", [...FILE_FLAGS, ["--broker", false]]],
        ["ai-accounts", [...FILE_FLAGS, ["--broker", false], ["--provider", false]]],
    ] as const)("the %s door's login declares exactly these flags, in this order", async (door, expected) => {
        expect(await optionsOf(door, "login")).toEqual([...expected]);
    });

    test.each([
        ["claude", [["--setup-token", false]]],
        [
            "ai-accounts",
            [
                ["--provider", false],
                ["--setup-token", false],
            ],
        ],
        ["codex", "absent"],
        ["grok", "absent"],
    ] as const)("the %s door's login-long declares these flags, or has no such verb", async (door, expected) => {
        expect(await optionsOf(door, "login-long")).toEqual(expected === "absent" ? expected : [...expected]);
    });

    test.each([
        ["claude", []],
        ["ai-accounts", [["--provider", false]]],
        ["codex", "absent"],
        ["grok", "absent"],
    ] as const)("the %s door's login-secondary declares these flags, or has no such verb", async (door, expected) => {
        expect(await optionsOf(door, "login-secondary")).toEqual(expected === "absent" ? expected : [...expected]);
    });
});

/**
 * The rule for the next provider's own switch: it shows on that provider's door and on the neutral
 * door, and is unknown elsewhere unless it is marked `acceptedOnEveryDoor` (as `--broker` is).
 */
describe("a switch a new provider declares for its own login", () => {
    const deviceCode = { name: "device-code", description: "Log in with a device code instead of a callback" };

    beforeEach(() => {
        _resetPluginsForTest();
        _resetBuiltInPluginsForTest(true);
        registerPlugin(anthropicSubPlugin);
        registerPlugin(openAiSubPlugin);
        registerPlugin(grokSubPlugin);

        const grokAccounts = grokSubPlugin.accounts;

        if (!grokAccounts) {
            throw new Error("grok-sub has no account features");
        }

        registerPlugin({ ...grokSubPlugin, id: "kimi-sub", accounts: { ...grokAccounts, loginFlags: [deviceCode] } });
    });

    function loginOptions(provider: string | undefined): ReadonlyArray<readonly [string | undefined, boolean]> {
        const program = new Command();
        registerAccountLoginCommand(program, { provider, tool: "tools test login", subcommand: ["login"] });

        return commandAt(program, ["login"])?.options.map((option) => [option.long, option.hidden] as const) ?? [];
    }

    test("it shows on its own provider's door", () => {
        expect(loginOptions("kimi-sub")).toContainEqual(["--device-code", false]);
    });

    test("it shows on the provider-neutral door", () => {
        expect(loginOptions(undefined)).toContainEqual(["--device-code", false]);
    });

    test("it is not declared at all on another provider's door", () => {
        expect(loginOptions("openai-sub").map(([flag]) => flag)).not.toContain("--device-code");
    });
});

/**
 * What a provider's flow is told, observed by putting a recorder where its browser flow would run. The
 * recorder throws, so no run ever reaches the account writer and the config never changes.
 */
describe("what the doors hand each provider's flow", () => {
    let reached: Array<{ provider: string; ctx: AccountFlowContext }>;

    /** The one place that knows how a flow learns that its own switch was given. */
    function told(ctx: AccountFlowContext, flag: "broker" | "setup-token"): boolean {
        return ctx.providerFlags?.has(flag) === true;
    }

    /** The real plugin with every login flow replaced by a recorder; its other members stay real. */
    function recording(plugin: ProviderPlugin): ProviderPlugin {
        const accounts = plugin.accounts;

        if (!accounts) {
            throw new Error(`${plugin.id} has no account features`);
        }

        const record = async (ctx: AccountFlowContext): Promise<never> => {
            reached.push({ provider: plugin.id, ctx });
            throw new Error("flow reached");
        };
        const long = accounts.loginVariants.long;

        return {
            ...plugin,
            accounts: {
                ...accounts,
                login: record,
                loginVariants: { ...accounts.loginVariants, ...(long ? { long: { ...long, run: record } } : {}) },
            },
        };
    }

    async function parse(door: Door, args: string[]): Promise<void> {
        const program = await doorProgram(door);
        await program.parseAsync([...MOUNT[door], ...args], { from: "user" });
    }

    beforeEach(() => {
        reached = [];
        _resetPluginsForTest();
        // Claims the built-ins are registered, so every door keeps the recording plugins below.
        _resetBuiltInPluginsForTest(true);
        registerPlugin(recording(anthropicSubPlugin));
        registerPlugin(recording(openAiSubPlugin));
        registerPlugin(recording(grokSubPlugin));
    });

    test.each([
        ["codex", ["login", "work", "--broker"]],
        ["ai-codex", ["login", "work", "--broker"]],
        ["ai-accounts", ["login", "work", "--provider", "codex", "--broker"]],
    ] as const)("the %s door tells the codex flow that --broker was given", async (door, args) => {
        await expect(parse(door, [...args])).rejects.toThrow("flow reached");

        expect(reached.map((entry) => entry.provider)).toEqual(["openai-sub"]);
        expect(told(reached[0].ctx, "broker")).toBe(true);
    });

    test("NEGATIVE CONTROL: without --broker the codex flow is not told it was given", async () => {
        await expect(parse("codex", ["login", "work"])).rejects.toThrow("flow reached");

        expect(told(reached[0].ctx, "broker")).toBe(false);
    });

    test.each([
        ["claude", "anthropic-sub"],
        ["grok", "grok-sub"],
    ] as const)("--broker still parses on the %s door, whose own flow then runs", async (door, provider) => {
        await expect(parse(door, ["login", "work", "--broker"])).rejects.toThrow("flow reached");

        expect(reached.map((entry) => entry.provider)).toEqual([provider]);
    });

    test("--broker beside --auth-file on the grok door is refused before any flow runs or anything is written", async () => {
        const configBefore = readFileSync(configFile, "utf8");

        await parse("grok", ["login", "work", "--broker", "--auth-file", authFile]);

        expect(process.exitCode).toBe(1);
        expect(reached).toEqual([]);
        expect(readFileSync(configFile, "utf8")).toBe(configBefore);
    });

    describe("login-long", () => {
        beforeEach(() => {
            writeFileSync(
                configFile,
                SafeJSON.stringify({
                    version: CONFIG_VERSION,
                    accounts: [
                        {
                            id: "acc_work",
                            name: "work",
                            provider: "anthropic-sub",
                            enabled: true,
                            billing: { mode: "subscription" },
                            credentials: {},
                            useEnvApiKey: false,
                        },
                        {
                            id: "acc_personal",
                            name: "personal",
                            provider: "openai-sub",
                            enabled: true,
                            billing: { mode: "subscription" },
                            credentials: {},
                            useEnvApiKey: false,
                        },
                    ],
                    defaults: {},
                })
            );
            AiConfigStore.invalidate();
            // login-long refuses a pipe before it reaches any flow.
            Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
        });

        test.each([
            ["claude", ["login-long", "work", "--setup-token"]],
            ["ai-accounts", ["login-long", "work", "--provider", "claude", "--setup-token"]],
        ] as const)(
            "the %s door tells the Claude long-lived token flow that --setup-token was given",
            async (door, args) => {
                await expect(parse(door, [...args])).rejects.toThrow("flow reached");

                expect(reached.map((entry) => entry.provider)).toEqual(["anthropic-sub"]);
                expect(told(reached[0].ctx, "setup-token")).toBe(true);
            }
        );

        test("NEGATIVE CONTROL: without --setup-token the flow is not told it was given", async () => {
            await expect(parse("claude", ["login-long", "work"])).rejects.toThrow("flow reached");

            expect(told(reached[0].ctx, "setup-token")).toBe(false);
        });

        test.each(["login-long", "login-secondary"])(
            "%s on the neutral door refuses a provider without that credential, before any flow",
            async (verb) => {
                const configBefore = readFileSync(configFile, "utf8");

                // Resolves: a door that registered the verb for codex would reach a flow codex does not have.
                await parse("ai-accounts", [verb, "personal", "--provider", "codex"]);

                expect(process.exitCode).toBe(1);
                expect(reached).toEqual([]);
                expect(readFileSync(configFile, "utf8")).toBe(configBefore);
            }
        );
    });
});
