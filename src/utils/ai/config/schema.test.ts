import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
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

describe("forward compatibility: an unknown account field must survive", () => {
    /**
     * The regression test for 2026-08-29. A daemon running code from ten days
     * earlier rewrote the config through its own schema and erased
     * `organizationUuid`, `accountUuid` and `planContradictedAt` from 10 of 11
     * accounts, because zod strips unknown keys and `AiConfigStore` parses on the
     * WRITE path as well as the read path. The login fingerprint went silently
     * inert as a result.
     *
     * "A field this binary predates" is simulated with a name no schema will ever
     * define, so the test keeps meaning after every future field is added.
     */
    const FUTURE_FIELD = "fieldFromANewerBinary";

    test("parse preserves a field this schema does not define", () => {
        const parsed = aiConfigSchema.parse({
            version: CONFIG_VERSION,
            accounts: [{ ...validAccount, [FUTURE_FIELD]: "keep-me" }],
        });

        expect((parsed.accounts[0] as Record<string, unknown>)[FUTURE_FIELD]).toBe("keep-me");
    });

    test("a full read-parse -> write-parse round trip does not drop it", () => {
        // Mirrors AiConfigStore: parse on load, parse again before serialising.
        const onDisk = {
            version: CONFIG_VERSION,
            accounts: [{ ...validAccount, [FUTURE_FIELD]: "keep-me", organizationUuid: "org-uuid" }],
        };
        const serialised = SafeJSON.stringify(aiConfigSchema.parse(onDisk));
        const roundTripped = aiConfigSchema.parse(SafeJSON.parse(serialised));
        const account = roundTripped.accounts[0] as Record<string, unknown>;

        expect(account[FUTURE_FIELD]).toBe("keep-me");
        expect(account.organizationUuid).toBe("org-uuid");
    });

    test("the fields the incident destroyed round-trip explicitly", () => {
        const parsed = aiConfigSchema.parse({
            version: CONFIG_VERSION,
            accounts: [
                {
                    ...validAccount,
                    organizationUuid: "a874534e-57b4-46ae-8806-d0f0abc392d0",
                    accountUuid: "71367a38-f74c-42b7-a26e-57f21dc180d6",
                    planContradictedAt: 1788019653144,
                },
            ],
        });

        expect(parsed.accounts[0].organizationUuid).toBe("a874534e-57b4-46ae-8806-d0f0abc392d0");
        expect(parsed.accounts[0].accountUuid).toBe("71367a38-f74c-42b7-a26e-57f21dc180d6");
        expect(parsed.accounts[0].planContradictedAt).toBe(1788019653144);
    });

    test("being loose does not weaken validation of the fields it DOES define", () => {
        // A bad id must still be rejected: passthrough is about unknown keys only.
        expect(() =>
            aiConfigSchema.parse({
                version: CONFIG_VERSION,
                accounts: [{ ...validAccount, id: "not-an-acc-id", [FUTURE_FIELD]: "x" }],
            })
        ).toThrow();
    });

    test("nested account objects preserve unknown fields too", () => {
        // PR #343 review t19: only the account ENTRY was loose, so `credentials`,
        // `credentials.secondary` and `billing` still stripped. That is where the
        // 2026-08-29 incident actually happened — organizationUuid and
        // accountUuid are `secondary` fields — so the nested schemas need the
        // same protection.
        const onDisk = {
            version: CONFIG_VERSION,
            accounts: [
                {
                    ...validAccount,
                    billing: { ...validAccount.billing, [FUTURE_FIELD]: "billing-keep" },
                    credentials: {
                        ...validAccount.credentials,
                        [FUTURE_FIELD]: "creds-keep",
                        secondary: { accountUuid: "acc-uuid", [FUTURE_FIELD]: "secondary-keep" },
                    },
                },
            ],
        };

        // Round-tripped, because the write path parses too — that is what erased data.
        const serialised = SafeJSON.stringify(aiConfigSchema.parse(onDisk));
        const account = aiConfigSchema.parse(SafeJSON.parse(serialised)).accounts[0];
        const billing = account.billing as Record<string, unknown>;
        const credentials = account.credentials as Record<string, unknown>;
        const secondary = credentials.secondary as Record<string, unknown>;

        expect(billing[FUTURE_FIELD]).toBe("billing-keep");
        expect(credentials[FUTURE_FIELD]).toBe("creds-keep");
        expect(secondary[FUTURE_FIELD]).toBe("secondary-keep");
        expect(secondary.accountUuid).toBe("acc-uuid");
    });

    test("loose nested objects still reject a defined field of the wrong type", () => {
        // The negative control: passthrough must not turn into "anything goes".
        expect(() =>
            aiConfigSchema.parse({
                version: CONFIG_VERSION,
                accounts: [{ ...validAccount, billing: { mode: "not-a-billing-mode" } }],
            })
        ).toThrow();
    });
});
