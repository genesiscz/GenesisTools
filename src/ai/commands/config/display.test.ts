import { describe, expect, test } from "bun:test";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { secureRef } from "@genesiscz/utils/security";
import { parseUseEnv } from "./account";
import { credentialSourceOf } from "./display";

function account(overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id: "acc_a",
        name: "one",
        provider: "xai",
        enabled: true,
        billing: { mode: "metered" },
        credentials: {},
        useEnvApiKey: false,
        ...overrides,
    };
}

const plugin = {
    id: "xai",
    kind: "api-key",
    capabilities: new Set(["chat"]),
    credential: { fields: ["apiKey"], envKeys: ["XAI_API_KEY"], required: ["apiKey"] },
    bind: async () => {
        throw new Error("not used");
    },
} as unknown as ProviderPlugin;

describe("credentialSourceOf", () => {
    test("reads the shape without decrypting anything", () => {
        expect(credentialSourceOf(account({ credentials: { apiKey: secureRef("ai/acc_a/apiKey") } }))).toBe("vault");
        expect(credentialSourceOf(account({ credentials: { apiKey: "sk-literal" } }))).toBe("literal");
        expect(credentialSourceOf(account({ credentials: { authFile: "~/.grok/auth.json" } }))).toBe("file");
        expect(credentialSourceOf(account(), plugin)).toBe("none");
        expect(credentialSourceOf(account({ useEnvApiKey: true }), plugin)).toBe("env");
    });

    test("a stored credential outranks the env fallback", () => {
        const entry = account({ useEnvApiKey: true, credentials: { apiKey: secureRef("ai/acc_a/apiKey") } });

        expect(credentialSourceOf(entry, plugin)).toBe("vault");
    });
});

describe("parseUseEnv", () => {
    test("splits the comma form the credential error now suggests", () => {
        expect(parseUseEnv("XAI_API_KEY,X_AI_API_KEY")).toEqual(["XAI_API_KEY", "X_AI_API_KEY"]);
        expect(parseUseEnv(" XAI_API_KEY , X_AI_API_KEY ")).toEqual(["XAI_API_KEY", "X_AI_API_KEY"]);
    });

    test("true and false switch the provider defaults on and off", () => {
        expect(parseUseEnv("true")).toBe(true);
        expect(parseUseEnv("all")).toBe(true);
        expect(parseUseEnv("false")).toBe(false);
        expect(parseUseEnv("off")).toBe(false);
    });

    test("an empty list is an error rather than a silent no-op", () => {
        expect(() => parseUseEnv(" , ")).toThrow("--use-env needs variable names");
    });
});
