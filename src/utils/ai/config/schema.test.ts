import { describe, expect, test } from "bun:test";
import { type AccountEntry, aiConfigSchema, CONFIG_VERSION, emptyConfig, isTaskName, TASK_NAMES } from "./schema";
import { envKeyNames, hasStoredCredential, isBilled, showsInUsageDashboard } from "./selectors";

const validAccount = {
    id: "acc_anthropic_max",
    name: "martin-max",
    provider: "anthropic-sub",
    enabled: true,
    billing: { mode: "subscription", plan: "max20x" },
    credentials: {
        accessToken: { type: "secure", path: "ai/acc_anthropic_max/accessToken" },
        expiresAt: 1785312000000,
    },
    useEnvApiKey: false,
};

describe("aiConfigSchema", () => {
    test("accepts a realistic v4 config", () => {
        const parsed = aiConfigSchema.parse({
            version: CONFIG_VERSION,
            accounts: [validAccount],
            defaults: {
                account: { chat: "@account/acc_anthropic_max" },
                task: { transcribe: { provider: "local-hf", model: "whisper-large-v3-turbo" } },
                app: { youtube: { chat: { model: "@account/acc_anthropic_max:opus" }, temperature: 0.3 } },
            },
            models: { aliases: { fast: "@account/acc_anthropic_max:haiku" } },
            discovery: { ttl: "6 hours", sources: { litellm: true } },
        });

        expect(parsed.accounts[0].id).toBe("acc_anthropic_max");
        expect(parsed.defaults.account?.chat).toBe("@account/acc_anthropic_max");
    });

    test("rejects v3 shape and malformed ids or refs", () => {
        expect(() => aiConfigSchema.parse({ version: 3, accounts: [] })).toThrow();
        expect(() => aiConfigSchema.parse({ version: 4, accounts: [{ ...validAccount, id: "martin-max" }] })).toThrow();
        expect(() =>
            aiConfigSchema.parse({
                version: 4,
                accounts: [validAccount],
                defaults: { account: { chat: "martin-max" } },
            })
        ).toThrow();
    });

    /**
     * A secure path the schema accepts but `resolveSecret` rejects reads at
     * runtime as a MISSING credential, not a malformed one, so the config looks
     * valid and the account silently cannot authenticate. Both sides now test
     * against the same pattern.
     */
    test("a secure ref must satisfy the same path rule resolution enforces", () => {
        const withPath = (path: string) => ({
            version: 4,
            accounts: [{ ...validAccount, credentials: { accessToken: { type: "secure", path } } }],
        });

        expect(() => aiConfigSchema.parse(withPath("ai/acc_anthropic_max/accessToken"))).not.toThrow();
        expect(() => aiConfigSchema.parse(withPath("ai/acc_max/secondary.accessToken"))).not.toThrow();

        for (const bad of ["", "no-domain", "/leading", "ai/", "AI/acc/token", "ai//token", "ai/acc token"]) {
            expect(() => aiConfigSchema.parse(withPath(bad))).toThrow();
        }
    });

    test("useEnvApiKey accepts all three shapes and defaults to false", () => {
        for (const useEnvApiKey of [true, "XAI_API_KEY", ["XAI_API_KEY", "X_AI_API_KEY"]]) {
            expect(() =>
                aiConfigSchema.parse({ version: 4, accounts: [{ ...validAccount, useEnvApiKey }] })
            ).not.toThrow();
        }

        const { useEnvApiKey: _omitted, ...withoutFlag } = validAccount;
        expect(aiConfigSchema.parse({ version: 4, accounts: [withoutFlag] }).accounts[0].useEnvApiKey).toBe(false);
    });

    test("task vocabulary keeps v3's classify and sentiment", () => {
        expect(TASK_NAMES).toContain("classify");
        expect(TASK_NAMES).toContain("sentiment");
        expect(isTaskName("chat")).toBe(true);
        expect(isTaskName("nonsense")).toBe(false);
    });

    test("emptyConfig is valid", () => {
        expect(() => aiConfigSchema.parse(emptyConfig())).not.toThrow();
    });
});

describe("selectors", () => {
    const base = aiConfigSchema.parse({ version: 4, accounts: [validAccount] }).accounts[0];

    test("derive billing and dashboard visibility from shape, not stored flags", () => {
        expect(isBilled(base)).toBe(true);
        expect(showsInUsageDashboard(base)).toBe(true);

        const free: AccountEntry = { ...base, billing: { mode: "free" } };
        expect(isBilled(free)).toBe(false);
        expect(showsInUsageDashboard(free)).toBe(false);

        const disabled: AccountEntry = { ...base, enabled: false };
        expect(showsInUsageDashboard(disabled)).toBe(false);
    });

    test("overrides force an exception", () => {
        const hidden: AccountEntry = { ...base, overrides: { usageDashboard: false } };
        expect(showsInUsageDashboard(hidden)).toBe(false);
    });

    test("envKeyNames expands each useEnvApiKey shape", () => {
        const defaults = ["XAI_API_KEY", "X_AI_API_KEY"];

        expect(envKeyNames(base, defaults)).toEqual([]);
        expect(envKeyNames({ ...base, useEnvApiKey: true }, defaults)).toEqual(defaults);
        expect(envKeyNames({ ...base, useEnvApiKey: "ONLY_THIS" }, defaults)).toEqual(["ONLY_THIS"]);
        expect(envKeyNames({ ...base, useEnvApiKey: ["A", "B"] }, defaults)).toEqual(["A", "B"]);
    });

    test("hasStoredCredential sees vault refs and auth-file references", () => {
        expect(hasStoredCredential(base)).toBe(true);
        expect(hasStoredCredential({ ...base, credentials: {} })).toBe(false);
        expect(hasStoredCredential({ ...base, credentials: { authFile: "~/.grok/auth.json" } })).toBe(true);
    });
});
