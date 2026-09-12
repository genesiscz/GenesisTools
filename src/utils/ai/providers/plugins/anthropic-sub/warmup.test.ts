import { describe, expect, test } from "bun:test";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { LONG_TOKEN_MIN_LENGTH } from "@genesiscz/utils/claude/token-verify";
import { anthropicWarmup, type LongLivedTokens } from "./warmup";

const LONG = "x".repeat(LONG_TOKEN_MIN_LENGTH);
const INVALID_GRANT = "Token expired (invalid_grant). Run: tools claude login side";

function account(credentials: AccountEntry["credentials"]): AccountEntry {
    return {
        id: "acc_side",
        name: "side",
        provider: "anthropic-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials,
        useEnvApiKey: false,
    };
}

const PAIR: AccountEntry["credentials"] = {
    accessToken: { type: "secure", path: "ai/acc_side/accessToken" },
    refreshToken: { type: "secure", path: "ai/acc_side/refreshToken" },
};

function run(input: {
    credentials?: AccountEntry["credentials"];
    tokens?: LongLivedTokens;
    generic?: () => Promise<void>;
    verdict?: "ok" | "limited" | "invalid";
}) {
    const calls = { generic: 0, longLived: [] as string[] };
    const outcome = anthropicWarmup(
        account(input.credentials ?? PAIR),
        {
            generic: async () => {
                calls.generic += 1;
                await (input.generic ?? (async () => {}))();
            },
        },
        {
            loadLongLived: async () => input.tokens,
            sendLongLived: async (token) => {
                calls.longLived.push(token);
                return input.verdict ?? "ok";
            },
        }
    );
    return { outcome, calls };
}

describe("anthropicWarmup", () => {
    test("OAuth success does not touch the login-long token", async () => {
        const { outcome, calls } = run({ tokens: { longLivedToken: LONG } });
        expect(await outcome).toEqual({ via: "oauth" });
        expect(calls).toEqual({ generic: 1, longLived: [] });
    });

    test("invalid_grant falls back to login-long and reports it", async () => {
        const { outcome, calls } = run({
            tokens: { longLivedToken: LONG },
            generic: async () => {
                throw new Error(INVALID_GRANT);
            },
        });
        expect(await outcome).toEqual({ via: "login-long" });
        expect(calls).toEqual({ generic: 1, longLived: [LONG] });
    });

    test("a 429 on login-long still counts as success", async () => {
        const { outcome } = run({
            tokens: { longLivedToken: LONG },
            generic: async () => {
                throw new Error(INVALID_GRANT);
            },
            verdict: "limited",
        });
        expect(await outcome).toEqual({ via: "login-long" });
    });

    test("invalid_grant with no, a truncated, or an expired login-long token fails without pinging", async () => {
        for (const tokens of [
            undefined,
            { longLivedToken: "sk-ant-oat01-short" },
            { longLivedToken: LONG, longLivedTokenExpiresAt: Date.now() - 1_000 },
        ]) {
            const { outcome, calls } = run({
                tokens,
                generic: async () => {
                    throw new Error(INVALID_GRANT);
                },
            });
            await expect(outcome).rejects.toThrow(/login-long/);
            expect(calls.longLived).toEqual([]);
        }
    });

    test("a non-auth OAuth error surfaces unchanged and never falls back", async () => {
        const { outcome, calls } = run({
            tokens: { longLivedToken: LONG },
            generic: async () => {
                throw new Error("No haiku model available");
            },
        });
        await expect(outcome).rejects.toThrow("No haiku model available");
        expect(calls.longLived).toEqual([]);
    });

    test("login-long invalid after invalid_grant is a failure naming both", async () => {
        const { outcome } = run({
            tokens: { longLivedToken: LONG },
            generic: async () => {
                throw new Error(INVALID_GRANT);
            },
            verdict: "invalid",
        });
        await expect(outcome).rejects.toThrow(/oauth: .*; login-long: invalid/);
    });

    test("no OAuth pair uses login-long directly", async () => {
        const { outcome, calls } = run({ credentials: {}, tokens: { longLivedToken: LONG } });
        expect(await outcome).toEqual({ via: "login-long" });
        expect(calls).toEqual({ generic: 0, longLived: [LONG] });
    });

    test("credential-less accounts fail without sending", async () => {
        const { outcome, calls } = run({ credentials: {}, tokens: {} });
        await expect(outcome).rejects.toThrow("no credentials stored");
        expect(calls).toEqual({ generic: 0, longLived: [] });
    });

    test("a 401 from OAuth also falls back to login-long", async () => {
        const { outcome } = run({
            tokens: { longLivedToken: LONG },
            generic: async () => {
                throw new Error("Unauthorized: 401");
            },
        });
        expect(await outcome).toEqual({ via: "login-long" });
    });
});
