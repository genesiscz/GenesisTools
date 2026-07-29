import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { AiConfigStore } from "../config/AiConfigStore";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "../config/schema";
import { ModelResolutionError, resolveModelTarget } from "./resolve";
import { isUnlisted } from "./types";

let home: string;

function account(id: string, name: string, overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id,
        name,
        provider: "anthropic-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
        ...overrides,
    };
}

const ACCOUNTS: AccountEntry[] = [
    account("acc_max", "martin-max"),
    account("acc_max2", "martin-max-second"),
    account("acc_xai", "xai-api", { provider: "xai", billing: { mode: "metered" } }),
    account("acc_proxy", "local-proxy", { provider: "ai-proxy", billing: { mode: "free" } }),
    account("acc_ollama", "ollama-local", { provider: "ollama", billing: { mode: "free" } }),
    account("acc_off", "disabled-one", { enabled: false, provider: "groq" }),
];

function writeConfig(config: Partial<AiConfigData>): void {
    const full: AiConfigData = {
        version: CONFIG_VERSION,
        accounts: ACCOUNTS,
        defaults: {},
        ...config,
    };

    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(join(home, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(full, null, 2));
    AiConfigStore.invalidate();
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-core-resolve-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    AiConfigStore.invalidate();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    AiConfigStore.invalidate();
});

describe("resolveModel — explicit refs", () => {
    test("@account/<id>:<model> takes both halves from the ref", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_max2" } } });

        const target = await resolveModelTarget("@account/acc_max:claude-opus-5");

        expect(target.account.id).toBe("acc_max");
        expect(target.model.id).toBe("claude-opus-5");
        expect(target.via).toContain("@account/acc_max:claude-opus-5");
    });

    test("@account/<id> with no model falls to the provider's catalog default", async () => {
        writeConfig({});

        const target = await resolveModelTarget("@account/acc_max");

        expect(target.account.id).toBe("acc_max");
        // anthropic-sub has no catalog rows of its own; the `-sub`-stripped key does.
        expect(target.model.provider).toBe("anthropic");
        expect(target.via).toContain("catalog default");
    });

    test("<provider>/<model> uses the task default account when it matches that provider", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_max2" } } });

        const target = await resolveModelTarget("anthropic-sub/claude-sonnet-5");

        expect(target.account.id).toBe("acc_max2");
        expect(target.model.id).toBe("claude-sonnet-5");
    });

    test("<provider>/<model> falls to the first enabled account of that provider otherwise", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_max" } } });

        const target = await resolveModelTarget("xai/grok-4.5");

        expect(target.account.id).toBe("acc_xai");
    });

    test("a bare model id uses the default account", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_max2" } } });

        const target = await resolveModelTarget("claude-opus-5");

        expect(target.account.id).toBe("acc_max2");
        expect(target.model.id).toBe("claude-opus-5");
    });

    test("@proxy/<slug>/<model> binds the ai-proxy account and keeps the gateway's own id shape", async () => {
        writeConfig({});

        const target = await resolveModelTarget("@proxy/grok/grok-4.5");

        expect(target.account.id).toBe("acc_proxy");
        expect(target.plugin.id).toBe("ai-proxy");
        expect(target.model.id).toBe("grok/grok-4.5");
    });

    test("an alias resolves and is named in `via`", async () => {
        writeConfig({
            defaults: { account: { chat: "@account/acc_max" } },
            models: { aliases: { fast: "claude-haiku-4-5-20251001" } },
        });

        const target = await resolveModelTarget("fast");

        expect(target.model.id).toBe("claude-haiku-4-5-20251001");
        expect(target.via).toContain('alias "fast"');
    });
});

describe("resolveModel — defaults ladder", () => {
    test("defaults.app beats defaults.task", async () => {
        writeConfig({
            defaults: {
                account: { chat: "@account/acc_max" },
                task: { summarize: { model: "claude-sonnet-5" } },
                app: { youtube: { summarize: { model: "claude-opus-5" } } },
            },
        });

        const target = await resolveModelTarget(undefined, { task: "summarize", app: "youtube" });

        expect(target.model.id).toBe("claude-opus-5");
        expect(target.via).toBe("defaults.app.youtube.summarize");
    });

    test("defaults.app for a DIFFERENT app does not apply", async () => {
        writeConfig({
            defaults: {
                account: { chat: "@account/acc_max" },
                task: { summarize: { model: "claude-sonnet-5" } },
                app: { youtube: { summarize: { model: "claude-opus-5" } } },
            },
        });

        const target = await resolveModelTarget(undefined, { task: "summarize", app: "claude" });

        expect(target.model.id).toBe("claude-sonnet-5");
        expect(target.via).toBe("defaults.task.summarize");
    });

    test("defaults.task beats the account default's catalog model", async () => {
        writeConfig({
            defaults: {
                account: { chat: "@account/acc_max" },
                task: { chat: { model: "claude-sonnet-4-5-20250929" } },
            },
        });

        const target = await resolveModelTarget(undefined);

        expect(target.model.id).toBe("claude-sonnet-4-5-20250929");
    });

    test("defaults.account[task] beats defaults.account.chat", async () => {
        writeConfig({
            defaults: { account: { chat: "@account/acc_max", summarize: "@account/acc_max2" } },
        });

        const target = await resolveModelTarget(undefined, { task: "summarize" });

        expect(target.account.id).toBe("acc_max2");
    });

    test("defaults.account.chat is the global fallback for any task", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_max" } } });

        const target = await resolveModelTarget(undefined, { task: "translate" });

        expect(target.account.id).toBe("acc_max");
    });

    test("a task default may itself be a full account ref", async () => {
        writeConfig({
            defaults: {
                account: { chat: "@account/acc_max" },
                task: { chat: { model: "@account/acc_max2:claude-sonnet-5" } },
            },
        });

        const target = await resolveModelTarget(undefined);

        expect(target.account.id).toBe("acc_max2");
        expect(target.model.id).toBe("claude-sonnet-5");
    });

    test("a rung's `provider` fills only the half the model ref left open", async () => {
        writeConfig({
            defaults: {
                account: { chat: "@account/acc_max" },
                task: { chat: { provider: "xai", model: "@account/acc_max2:claude-sonnet-5" } },
            },
        });

        const target = await resolveModelTarget(undefined);

        expect(target.account.id).toBe("acc_max2");
    });
});

describe("resolveModel — an explicit ref never mixes with a configured spec", () => {
    test("defaults.task is skipped entirely when a ref names only the account", async () => {
        writeConfig({
            defaults: {
                account: { chat: "@account/acc_max" },
                task: { chat: { model: "claude-sonnet-5" } },
            },
        });

        const target = await resolveModelTarget("@account/acc_max2");

        // Not claude-sonnet-5: blending the configured spec into an explicit ref
        // is what `fallbackSpec` forbids.
        expect(target.model.id).not.toBe("claude-sonnet-5");
        expect(target.via).toContain("catalog default");
    });

    test("defaults.app is skipped entirely when a ref names only the model", async () => {
        writeConfig({
            defaults: {
                account: { chat: "@account/acc_max" },
                app: { youtube: { chat: { model: "@account/acc_xai:grok-4.5" } } },
            },
        });

        const target = await resolveModelTarget("claude-opus-5", { app: "youtube" });

        expect(target.account.id).toBe("acc_max");
        expect(target.model.id).toBe("claude-opus-5");
    });
});

describe("resolveModel — unlisted models", () => {
    test("a model the catalog does not know still resolves, flagged unlisted", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_max" } } });

        const target = await resolveModelTarget("claude-opus-9-unreleased");

        expect(isUnlisted(target.model)).toBe(true);
        expect(target.model.id).toBe("claude-opus-9-unreleased");
        expect(target.model.provider).toBe("anthropic-sub");
    });
});

describe("resolveModel — errors", () => {
    test("no defaults at all names `tools ai config default set`", async () => {
        writeConfig({});

        expect(resolveModelTarget(undefined)).rejects.toThrow(ModelResolutionError);
        expect(resolveModelTarget(undefined)).rejects.toThrow("tools ai config default set");
    });

    test("a missing account is reported with the rung that pointed at it", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_ghost" } } });

        expect(resolveModelTarget(undefined)).rejects.toThrow("defaults.account.chat");
    });

    test("a disabled account is refused rather than silently skipped", async () => {
        writeConfig({});

        expect(resolveModelTarget("@account/acc_off:llama")).rejects.toThrow("disabled");
    });

    test("a provider with no enabled account names `account add`", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_max" } } });

        expect(resolveModelTarget("groq/llama-3.3-70b")).rejects.toThrow("tools ai config account add --provider groq");
    });

    test("a provider that cannot chat fails resolution instead of throwing from language()", async () => {
        writeConfig({});

        // `ollama` declares embed/summarize/translate; its binding's language()
        // throws by design (local/adapters (language() throws by design)).
        expect(resolveModelTarget("@account/acc_ollama:nomic-embed")).rejects.toThrow("cannot chat");
    });

    test("a provider switched off in disabledProviders is refused", async () => {
        writeConfig({ disabledProviders: ["xai"], defaults: { account: { chat: "@account/acc_max" } } });

        expect(resolveModelTarget("@account/acc_xai:grok-4.5")).rejects.toThrow("switched off");
    });

    test("a malformed ref surfaces the grammar", async () => {
        writeConfig({ defaults: { account: { chat: "@account/acc_max" } } });

        expect(resolveModelTarget("@proxy/onlyslug")).rejects.toThrow("@proxy/<slug>/<modelId>");
    });
});
