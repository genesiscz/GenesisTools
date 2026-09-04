import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetBuiltInPluginsForTest, registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { _resetPluginsForTest } from "@genesiscz/utils/ai/providers/registry";
import { resolveAccountsProvider } from "./select-provider";

/**
 * `--provider` is an enumerated flag, declared `[value]` rather than `<value>`:
 * commander would otherwise exit with a generic "argument missing" that never
 * names `claude`, `codex` or `grok`. In a pipe the possible values are printed
 * and nothing is prompted, because there is nobody to answer.
 */
const INPUT = { interactive: false, tool: "tools ai accounts login", subcommand: ["accounts", "login"] };

beforeEach(() => {
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
    registerBuiltInPlugins();
});

afterEach(() => {
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
});

describe("resolveAccountsProvider without a TTY", () => {
    test("a missing value names the possible ones and never prompts", async () => {
        const resolved = await resolveAccountsProvider(INPUT);

        expect(resolved.status).toBe("help");

        if (resolved.status !== "help") {
            throw new Error("expected the enum help");
        }

        expect(resolved.help).toContain("claude");
        expect(resolved.help).toContain("codex");
        expect(resolved.help).toContain("grok");
        expect(resolved.help).toContain("--provider requires a value");
    });

    test("the flag passed with no value is the same case", async () => {
        const resolved = await resolveAccountsProvider({ ...INPUT, raw: true });

        expect(resolved.status).toBe("help");
    });

    // The same path handles an invalid value, and "requires a value" would
    // contradict the input the user actually typed.
    test("an unknown value is quoted back rather than reported as missing", async () => {
        const resolved = await resolveAccountsProvider({ ...INPUT, raw: "gemini" });

        expect(resolved.status).toBe("help");

        if (resolved.status !== "help") {
            throw new Error("expected the enum help");
        }

        expect(resolved.help).toContain('--provider does not accept "gemini"');
        expect(resolved.help).toContain("claude, codex, grok");
    });

    test("a plugin id that carries no account features is refused too", async () => {
        const resolved = await resolveAccountsProvider({ ...INPUT, raw: "openrouter" });

        expect(resolved.status).toBe("help");
    });
});

describe("resolveAccountsProvider accepts both spellings", () => {
    test("the alias resolves to the plugin", async () => {
        const resolved = await resolveAccountsProvider({ ...INPUT, raw: "claude" });

        expect(resolved.status).toBe("ok");

        if (resolved.status !== "ok") {
            throw new Error("expected a plugin");
        }

        expect(resolved.plugin.id).toBe("anthropic-sub");
        expect(resolved.plugin.accounts?.presentation.alias).toBe("claude");
    });

    test("the plugin id resolves to the same plugin", async () => {
        const byAlias = await resolveAccountsProvider({ ...INPUT, raw: "codex" });
        const byId = await resolveAccountsProvider({ ...INPUT, raw: "openai-sub" });

        expect(byAlias.status).toBe("ok");
        expect(byId.status).toBe("ok");

        if (byAlias.status !== "ok" || byId.status !== "ok") {
            throw new Error("expected a plugin");
        }

        expect(byId.plugin.id).toBe(byAlias.plugin.id);
        expect(byId.plugin.id).toBe("openai-sub");
    });

    test("case and surrounding whitespace do not matter", async () => {
        const resolved = await resolveAccountsProvider({ ...INPUT, raw: "  GROK " });

        expect(resolved.status).toBe("ok");

        if (resolved.status !== "ok") {
            throw new Error("expected a plugin");
        }

        expect(resolved.plugin.id).toBe("grok-sub");
    });
});
