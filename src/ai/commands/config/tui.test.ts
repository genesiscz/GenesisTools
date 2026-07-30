import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { _resetBuiltInPluginsForTest, registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { _resetPluginsForTest } from "@genesiscz/utils/ai/providers/registry";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import type { PromptBackend } from "@genesiscz/utils/prompts/p";
import * as p from "@genesiscz/utils/prompts/p";
import {
    _resetMasterKeyProviders,
    _resetSecretsForTest,
    _setMasterKeyProvidersForTest,
    secrets,
} from "@genesiscz/utils/security";
import { runConfigTui } from "./tui";

/**
 * The TUI is navigation over the same controllers the subcommands call, so it is
 * driven here through a scripted prompt backend rather than a pty: the walk is
 * deterministic, and what it asserts is that each menu path reaches the real
 * write, not that clack renders.
 */

const KEY = Buffer.alloc(32, 9);

let home: string;
let answers: unknown[];
let asked: string[];

function scriptedBackend(): PromptBackend {
    const next = <T>(message: string): T => {
        asked.push(message);
        if (answers.length === 0) {
            throw new Error(`The TUI asked "${message}" but the script ran out of answers.`);
        }

        return answers.shift() as T;
    };

    const noop = () => {};

    return {
        intro: noop,
        outro: noop,
        cancel: noop,
        note: noop,
        text: async (opts) => next(opts.message),
        confirm: async (opts) => next(opts.message),
        typedConfirm: async (opts) => next(opts.message),
        select: async (opts) => next(opts.message),
        multiselect: async (opts) => next(opts.message),
        password: async (opts) => next(opts.message),
        search: async (opts) => next(opts.message),
        editor: async (opts) => next(opts.message),
        number: async (opts) => next(opts.message),
        spinner: () => ({ start: noop, stop: noop, message: noop }),
        log: {
            info: noop,
            success: noop,
            warn: noop,
            warning: noop,
            error: noop,
            step: noop,
            message: noop,
        },
    };
}

function configPath(): string {
    return join(home, ".genesis-tools", "ai", "config.json");
}

function readConfig(): { accounts: Array<Record<string, unknown>>; defaults: Record<string, unknown> } {
    return SafeJSON.parse(readFileSync(configPath(), "utf8"), { strict: true });
}

function seedEmptyConfig(): void {
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(configPath(), SafeJSON.stringify({ version: 4, accounts: [], defaults: {} }, null, 2));
}

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "gt-tui-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    seedEmptyConfig();
    _setMasterKeyProvidersForTest([
        { id: "env", available: async () => true, get: async () => KEY, getSync: () => KEY, set: async () => {} },
    ]);
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
    registerBuiltInPlugins();
    AiConfigStore.invalidate();

    answers = [];
    asked = [];
    p.setBackend(scriptedBackend());
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    _resetMasterKeyProviders();
    _resetSecretsForTest();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
    AiConfigStore.invalidate();
});

describe("runConfigTui", () => {
    test("the main menu offers the frozen entries, including the Hugging Face path", async () => {
        let mainMenu: string[] = [];
        p.setBackend({
            ...scriptedBackend(),
            select: async (opts) => {
                mainMenu = opts.options.map((option) => String(option.value));
                return "quit";
            },
        });

        await runConfigTui();

        // The HF entry is not decoration: AILocalProvider tells users to run
        // "tools ai config -> Hugging Face token" when a gated model 401s.
        expect(mainMenu).toEqual(["accounts", "defaults", "secrets", "doctor", "hf-token", "quit"]);
    });

    test("adding an account through the menu writes it and vaults the secret", async () => {
        answers = [
            "accounts", // main menu
            "__add", // account picker
            "groq", // provider
            "groq-main", // name
            "sk-tui-secret", // apiKey (hidden)
            "__back", // account picker
            "quit", // main menu
        ];

        await runConfigTui();

        const config = readConfig();
        expect(config.accounts).toHaveLength(1);
        expect(config.accounts[0].name).toBe("groq-main");
        expect(readFileSync(configPath(), "utf8")).not.toContain("sk-tui-secret");
        expect(await (await secrets()).get("ai/acc_groq_main/apiKey")).toBe("sk-tui-secret");
    });

    test("removing an account re-confirms and honours a refusal", async () => {
        answers = ["accounts", "__add", "groq", "doomed", "sk-x", "__back", "quit"];
        await runConfigTui();

        const id = readConfig().accounts[0].id as string;
        answers = ["accounts", id, "rm", false, "__back", "__back", "quit"];
        await runConfigTui();

        expect(readConfig().accounts).toHaveLength(1);

        answers = ["accounts", id, "rm", true, "__back", "quit"];
        await runConfigTui();

        expect(readConfig().accounts).toHaveLength(0);
        expect(await (await secrets()).get(`ai/${id}/apiKey`)).toBeUndefined();
    });

    test("the doctor entry runs a report without asking for anything else", async () => {
        answers = ["doctor", false, "quit"];

        await runConfigTui();

        expect(asked).toContain("Include live provider health probes?");
    });

    test("the defaults entry writes through the same controller the subcommand uses", async () => {
        answers = ["accounts", "__add", "groq", "groq-main", "sk-x", "__back", "quit"];
        await runConfigTui();

        const id = readConfig().accounts[0].id as string;
        answers = ["defaults", "set", "chat", `@account/${id}`, "", "quit"];
        await runConfigTui();

        expect(readConfig().defaults).toEqual({ account: { chat: `@account/${id}` } });
    });
});
