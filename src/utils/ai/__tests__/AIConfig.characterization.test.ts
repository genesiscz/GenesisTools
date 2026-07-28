import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { AIConfig } from "../AIConfig";

/**
 * CHARACTERIZATION TEST — pins the CURRENT behavior of AIConfig before Phase 1
 * replaces its internals with AiConfigStore. Every assertion here was verified
 * green against the pre-rewrite implementation. If one of these fails after the
 * rewrite, the default conclusion is that the rewrite changed behavior, not that
 * the test is wrong. Changing an assertion requires stating which behavior moved
 * and why the new one is correct.
 */

let home: string;

const V3_CONFIG = {
    _schemaVersion: 3,
    accounts: [
        {
            name: "max-primary",
            provider: "anthropic-sub",
            label: "max 20x",
            apps: ["claude", "ask"],
            tokens: {
                accessToken: "sk-ant-oat01-primary",
                refreshToken: "sk-ant-ort01-primary",
                expiresAt: 2000,
            },
        },
        {
            name: "openai-key",
            provider: "openai",
            tokens: { apiKey: "sk-literal-openai" },
        },
        {
            name: "xai-env",
            provider: "xai",
            tokens: { apiKeyEnv: "CHARACTERIZATION_XAI_KEY" },
        },
        {
            name: "hf-account",
            provider: "huggingface",
            tokens: { apiKey: "hf_characterization" },
        },
    ],
    defaultAccounts: { ask: "openai-key" },
    tasks: { transcribe: { provider: "local-hf", model: "whisper-large-v3-turbo" } },
    apps: { youtube: { defaults: { provider: "grok", model: "grok-4.5", temperature: 0.3 } } },
    providers: { groq: { enabled: false, envVariable: "GROQ_API_KEY" } },
};

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-aiconfig-char-"));
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(join(home, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(V3_CONFIG, null, 2));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    AIConfig.invalidate();
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    env.testing.unset("CHARACTERIZATION_XAI_KEY");
    AIConfig.invalidate();
});

describe("AIConfig account lookup (characterization)", () => {
    test("getAccount matches by name and returns undefined otherwise", async () => {
        const config = await AIConfig.load();

        expect(config.getAccount("max-primary")?.provider).toBe("anthropic-sub");
        expect(config.getAccount("does-not-exist")).toBeUndefined();
    });

    test("getAccountsByProvider filters by provider", async () => {
        const config = await AIConfig.load();

        expect(config.getAccountsByProvider("anthropic-sub").map((a) => a.name)).toEqual(["max-primary"]);
        expect(config.getAccountsByProvider("google")).toEqual([]);
    });

    test("getAccountsByApp reads the account's apps list", async () => {
        const config = await AIConfig.load();

        expect(config.getAccountsByApp("claude").map((a) => a.name)).toEqual(["max-primary"]);
        expect(config.getAccountsByApp("nobody")).toEqual([]);
    });

    test("listAccounts preserves file order (the accounts[0] fallback depends on it)", async () => {
        const config = await AIConfig.load();

        expect(config.listAccounts().map((a) => a.name)).toEqual([
            "max-primary",
            "openai-key",
            "xai-env",
            "hf-account",
        ]);
    });
});

describe("AIConfig key resolution (characterization)", () => {
    test("resolveApiKey prefers the stored literal key", async () => {
        const config = await AIConfig.load();
        const account = config.getAccount("openai-key");

        expect(AIConfig.resolveApiKey(account!)).toBe("sk-literal-openai");
    });

    test("resolveApiKey reads apiKeyEnv LIVE from the environment", async () => {
        const config = await AIConfig.load();
        const account = config.getAccount("xai-env");

        expect(AIConfig.resolveApiKey(account!)).toBeUndefined();

        env.testing.set("CHARACTERIZATION_XAI_KEY", "xai-from-env");
        expect(AIConfig.resolveApiKey(account!)).toBe("xai-from-env");
    });

    test("resolveApiKey returns undefined for an account with no key material", async () => {
        const config = await AIConfig.load();

        expect(AIConfig.resolveApiKey(config.getAccount("max-primary")!)).toBeUndefined();
    });

    test("getProviderApiKey resolves through the provider's accounts", async () => {
        const config = await AIConfig.load();

        expect(config.getProviderApiKey("openai")).toBe("sk-literal-openai");
        expect(config.getProviderApiKey("google")).toBeUndefined();
    });

    test("getHfToken finds the huggingface account key", async () => {
        const config = await AIConfig.load();

        expect(config.getHfToken()).toBe("hf_characterization");
    });
});

describe("AIConfig defaults and tasks (characterization)", () => {
    test("getDefaultAccount uses the configured context mapping", async () => {
        const config = await AIConfig.load();

        expect(config.getDefaultAccount("ask")?.name).toBe("openai-key");
    });

    test("getDefaultAccount falls back to the FIRST account for unmapped contexts", async () => {
        const config = await AIConfig.load();

        expect(config.getDefaultAccount("unmapped-context")?.name).toBe("max-primary");
    });

    test("getTask returns the stored task config", async () => {
        const config = await AIConfig.load();
        const task = config.getTask("transcribe");

        expect(task.provider).toBe("local-hf");
        expect(task.model).toBe("whisper-large-v3-turbo");
    });

    test("getTask returns a default for a task absent from the file", async () => {
        const config = await AIConfig.load();

        expect(config.getTask("summarize").provider).toBeTruthy();
    });

    test("getAppDefaults reads the app block", async () => {
        const config = await AIConfig.load();

        expect(config.getAppDefaults("youtube")).toMatchObject({
            provider: "grok",
            model: "grok-4.5",
            temperature: 0.3,
        });
        expect(config.getAppDefaults("absent")).toBeUndefined();
    });

    test("isProviderEnabled honors an explicit disable and defaults to true", async () => {
        const config = await AIConfig.load();

        expect(config.isProviderEnabled("groq")).toBe(false);
        expect(config.isProviderEnabled("openai")).toBe(true);
        expect(config.isProviderEnabled("never-registered")).toBe(true);
    });
});

describe("AIConfig mutations (characterization)", () => {
    test("addAccount, updateAccount and removeAccount round-trip through disk", async () => {
        const config = await AIConfig.load();

        await config.addAccount({ name: "added", provider: "groq", tokens: { apiKey: "gsk_added" } });
        expect(config.getAccount("added")?.tokens.apiKey).toBe("gsk_added");

        await config.updateAccount("added", { label: "labelled" });
        expect(config.getAccount("added")?.label).toBe("labelled");

        await config.removeAccount("added");
        expect(config.getAccount("added")).toBeUndefined();

        AIConfig.invalidate();
        const reloaded = await AIConfig.load();
        expect(reloaded.getAccount("added")).toBeUndefined();
        expect(reloaded.getAccount("max-primary")).toBeDefined();
    });

    test("setDefaultAccount and setAppDefaults persist", async () => {
        const config = await AIConfig.load();

        await config.setDefaultAccount("ask", "max-primary");
        await config.setAppDefaults("youtube", { temperature: 0.9 });

        AIConfig.invalidate();
        const reloaded = await AIConfig.load();
        expect(reloaded.getDefaultAccount("ask")?.name).toBe("max-primary");
        expect(reloaded.getAppDefaults("youtube")?.temperature).toBe(0.9);
    });

    test("load() is a process-lifetime singleton that does NOT see external writes", async () => {
        const config = await AIConfig.load();
        expect(config.getAccount("late-arrival")).toBeUndefined();

        const external = { ...V3_CONFIG, accounts: [...V3_CONFIG.accounts, { name: "late-arrival", provider: "groq", tokens: {} }] };
        writeFileSync(join(home, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(external, null, 2));

        const same = await AIConfig.load();
        expect(same).toBe(config);
        // Pinned as CURRENT behavior, not as desirable behavior: this staleness is
        // why running daemons miss config changes, and Phase 1 adds a freshness check.
        expect(same.getAccount("late-arrival")).toBeUndefined();

        AIConfig.invalidate();
        expect((await AIConfig.load()).getAccount("late-arrival")).toBeDefined();
    });
});
