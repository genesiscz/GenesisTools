import { describe, expect, it } from "bun:test";
import type { AccountUsageSnapshot, LimitWindow } from "@genesiscz/utils/ai/providers/account-features";
import { pickRanked, rankAccounts } from "@genesiscz/utils/ai/usage/account-rank";

const NOW = new Date("2026-10-25T20:00:00.000Z");
const inHours = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

function codex(name: string, fiveHour: number, weekly: number, weeklyResetHours = 100): AccountUsageSnapshot {
    const limits: LimitWindow[] = [
        { key: "primary", label: "5h", kind: "session", percentUsed: fiveHour, resetsAt: inHours(2) },
        { key: "secondary", label: "Weekly", kind: "weekly", percentUsed: weekly, resetsAt: inHours(weeklyResetHours) },
    ];

    return { provider: "openai-sub", accountId: name, accountName: name, fetchedAt: NOW.toISOString(), limits };
}

function grok(name: string, monthly: number): AccountUsageSnapshot {
    return {
        provider: "grok-sub",
        accountId: name,
        accountName: name,
        fetchedAt: NOW.toISOString(),
        limits: [{ key: "monthly", label: "Monthly", kind: "monthly", percentUsed: monthly, resetsAt: inHours(300) }],
    };
}

describe("rankAccounts (Codex)", () => {
    it("puts ready first by weekly headroom, then session-starved, and never picks blocked or unknown accounts", () => {
        const ranked = rankAccounts(
            [
                codex("work", 20, 70),
                codex("personal", 10, 30),
                codex("side", 100, 10),
                codex("shop", 5, 100),
                { ...codex("spare", 0, 0), limits: [], error: "poll failed" },
            ],
            { now: NOW }
        );

        expect(ranked.map((account) => `${account.accountName}:${account.tier}`)).toEqual([
            "personal:ready",
            "work:ready",
            "side:session-starved",
            "shop:weekly-blocked",
            "spare:no-data",
        ]);
        expect(pickRanked(ranked)).toMatchObject({
            pick: { accountName: "personal" },
            runnerUp: { accountName: "work" },
        });
    });

    it("spreads sessions: headroom is shared by the sessions already on an account", () => {
        const ranked = rankAccounts([codex("work", 0, 20), codex("personal", 0, 40)], {
            now: NOW,
            sessions: { work: 2 },
        });

        // work: 80 / 3 = 26.7, personal: 60 / 1 = 60.
        expect(pickRanked(ranked)?.pick.accountName).toBe("personal");
    });

    it("prefers headroom that resets unused within a day", () => {
        const ranked = rankAccounts([codex("work", 0, 50), codex("personal", 0, 60, 6)], { now: NOW });

        // personal: 40 left, resets in 6 h, bonus 40 * 0.75 = 30, score 70 > work's 50.
        expect(ranked[0]).toMatchObject({ accountName: "personal", resetBonus: 30, score: 70 });
    });

    it("has no pick when every account is blocked or unknown", () => {
        expect(pickRanked(rankAccounts([codex("work", 0, 100)], { now: NOW }))).toBeUndefined();
    });
});

describe("rankAccounts (Grok)", () => {
    it("ranks by the monthly window when there is no short one", () => {
        const ranked = rankAccounts([grok("work", 90), grok("personal", 40)], { now: NOW });

        expect(ranked.map((account) => [account.accountName, account.tier, account.longHeadroomPct])).toEqual([
            ["personal", "ready", 60],
            ["work", "ready", 10],
        ]);
    });
});
