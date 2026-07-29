import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { AiConfigStore } from "../config/AiConfigStore";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "../config/schema";
import { chooseProviderModel, listChoosableTargets, parseProviderSpec } from "./choose";

let home: string;

function account(id: string, name: string, provider: string, overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id,
        name,
        provider,
        enabled: true,
        billing: { mode: "metered" },
        credentials: { apiKey: `key-${id}` },
        useEnvApiKey: false,
        ...overrides,
    };
}

function writeConfig(config: Partial<AiConfigData> = {}): void {
    const full: AiConfigData = {
        version: CONFIG_VERSION,
        accounts: [account("acc_xai", "xai-work", "xai"), account("acc_groq", "groq-work", "groq")],
        defaults: {},
        ...config,
    };

    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(join(home, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(full, null, 2));
    AiConfigStore.invalidate();
}

let envSnapshot: ReturnType<typeof env.testing.snapshot>;

/**
 * The developer running this suite has real keys exported. Grandfathered
 * resolution reads them live and by design, so every one is scrubbed here — a
 * test that passes only on a machine with `OPENROUTER_API_KEY` set is not a test.
 */
const GRANDFATHERED_VARS = [
    "OPENAI_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "XAI_API_KEY",
    "X_AI_API_KEY",
    "JINA_AI_API_KEY",
    "ASSEMBLYAI_API_KEY",
    "DEEPGRAM_API_KEY",
    "GLADIA_API_KEY",
    "HUGGINGFACE_TOKEN",
    "HF_TOKEN",
];

beforeEach(() => {
    envSnapshot = env.testing.snapshot();
    home = mkdtempSync(join(tmpdir(), "gt-choose-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);

    for (const name of GRANDFATHERED_VARS) {
        env.testing.unset(name);
    }

    AiConfigStore.invalidate();
});

afterEach(() => {
    env.testing.restore(envSnapshot);
    AiConfigStore.invalidate();
});

describe("parseProviderSpec", () => {
    test("splits on the FIRST slash so model ids keep theirs", () => {
        expect(parseProviderSpec("openrouter/openai/gpt-4o-mini")).toEqual({
            provider: "openrouter",
            model: "openai/gpt-4o-mini",
        });
    });

    test("a bare word is a provider, not a model", () => {
        expect(parseProviderSpec("xai")).toEqual({ provider: "xai" });
    });

    test("nothing in, nothing out", () => {
        expect(parseProviderSpec(null)).toEqual({});
        expect(parseProviderSpec(undefined)).toEqual({});
    });
});

describe("chooseProviderModel", () => {
    test("an explicit provider+model is never blended with the configured spec", async () => {
        writeConfig();

        const resolved = await chooseProviderModel({
            provider: "xai",
            model: "grok-4.5",
            fallbackSpec: "groq/llama-3.3-70b-versatile",
        });

        expect(resolved.account.id).toBe("acc_xai");
        expect(resolved.model.id).toBe("grok-4.5");
    });

    test("a provider named without a model takes the catalog's first chat model", async () => {
        writeConfig();

        const resolved = await chooseProviderModel({ fallbackSpec: "groq" });

        expect(resolved.plugin.id).toBe("groq");
        expect(resolved.model.id).toBeString();
    });

    test("the configured spec applies only when nothing was named explicitly", async () => {
        writeConfig();

        const resolved = await chooseProviderModel({ fallbackSpec: "xai/grok-4.5" });

        expect(resolved.account.id).toBe("acc_xai");
        expect(resolved.model.id).toBe("grok-4.5");
    });

    /**
     * The grandfather guarantee: a provider whose key has always come from the
     * environment keeps working even though no account row exists for it (the
     * seeding migration is opt-in and may not have run).
     */
    test("a provider with no account still resolves from its environment variable", async () => {
        writeConfig({ accounts: [] });
        env.testing.set("XAI_API_KEY", "xai-key-from-env");

        try {
            const resolved = await chooseProviderModel({ fallbackSpec: "xai/grok-4.5" });

            expect(resolved.account.id).toBe("acc_env_xai");
            expect(resolved.account.useEnvApiKey).toEqual(["XAI_API_KEY", "X_AI_API_KEY"]);
            expect(resolved.model.id).toBe("grok-4.5");
        } finally {
            env.testing.unset("XAI_API_KEY");
        }
    });

    test("no account and no environment variable is an error naming the fix", async () => {
        writeConfig({ accounts: [] });

        await expect(chooseProviderModel({ fallbackSpec: "anthropic/claude-opus-4-5" })).rejects.toThrow(
            /tools ai config account add --provider anthropic/
        );
    });
});

describe("listChoosableTargets", () => {
    test("lists every (account, model) pair whose credential resolves", async () => {
        writeConfig();

        const targets = await listChoosableTargets();
        const accounts = new Set(targets.map((target) => target.accountName));

        expect(accounts).toEqual(new Set(["xai-work", "groq-work"]));
        expect(targets.every((target) => target.subscription === false)).toBe(true);
    });

    test("an account whose credential cannot be resolved is left out", async () => {
        writeConfig({
            accounts: [account("acc_xai", "xai-work", "xai", { credentials: {}, useEnvApiKey: false })],
        });

        expect(await listChoosableTargets()).toEqual([]);
    });
});
