import { describe, expect, test } from "bun:test";
import type { AccountUsage, UsageResponse } from "@app/claude/lib/usage/api";
import type { Cached } from "@app/claude/lib/usage/shared-cache";
import { buildPayload, resolveInfoAccount } from "./info";

const vaultRead = async (): Promise<never> => {
    throw new Error("the vault was opened: the keychain would ask the user for gt-claude");
};

describe("tools claude info: which account", () => {
    test("a named account reads names only and never opens the vault", async () => {
        const account = await resolveInfoAccount({
            name: "work",
            readAccounts: async () => [{ name: "personal" }, { name: "work", label: "max 20x" }],
            loadSecrets: vaultRead,
            readToken: async () => "tok-work",
        });

        expect(account).toEqual({ name: "work", label: "max 20x" });
    });

    test("a token on stdin is matched against the stored tokens", async () => {
        const account = await resolveInfoAccount({
            name: undefined,
            readAccounts: vaultRead,
            loadSecrets: async () => ({
                getAccountsByProvider: () => [
                    { name: "personal", provider: "anthropic-sub", tokens: { longLivedToken: "tok-personal" } },
                    { name: "work", provider: "anthropic-sub", tokens: { longLivedToken: "tok-work" } },
                ],
            }),
            readToken: async () => "tok-work",
        });

        expect(account?.name).toBe("work");
    });

    test("no name and no token reads nothing", async () => {
        const account = await resolveInfoAccount({
            name: undefined,
            readAccounts: vaultRead,
            loadSecrets: vaultRead,
            readToken: async () => null,
        });

        expect(account).toBeNull();
    });
});

describe("tools claude info: the usage payload", () => {
    const WEEKLY = { utilization: 54, resets_at: "2026-11-08T12:00:00.000Z" };
    const peekWith = (usage: UsageResponse) => async (): Promise<Cached<AccountUsage>> => ({
        fetchedAt: 1,
        accounts: [{ accountName: "work", usage }],
    });

    test("an account without a 5-hour limit gets five_hour null and the absence, never 0", async () => {
        const payload = await buildPayload(
            { name: "work" },
            { peek: peekWith({ five_hour: null, seven_day: WEEKLY }) }
        );

        expect(payload.usage).toEqual({ seven_day: 54, five_hour: null });
        expect(payload.absentLimits).toEqual([{ key: "five_hour", kind: "session" }]);
    });

    test("negative control: an account with a 5h window keeps its number and names nothing absent", async () => {
        const payload = await buildPayload(
            { name: "work" },
            { peek: peekWith({ five_hour: { utilization: 7, resets_at: null }, seven_day: WEEKLY }) }
        );

        expect(payload.usage).toEqual({ five_hour: 7, seven_day: 54 });
        expect(payload.absentLimits).toEqual([]);
    });
});
