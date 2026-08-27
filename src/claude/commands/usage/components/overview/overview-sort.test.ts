import { describe, expect, test } from "bun:test";
import type { AccountUsage, UsageResponse } from "@app/claude/lib/usage/api";
import { applySort } from "./overview-sort";

function usage(): UsageResponse {
    return {
        five_hour: { utilization: 10, resets_at: "2099-01-01T00:00:00Z" },
        seven_day: { utilization: 10, resets_at: "2099-01-08T00:00:00Z" },
    };
}

const live: AccountUsage = { accountName: "personal", usage: usage() };

const staleLogin: AccountUsage = {
    accountName: "side",
    usage: usage(),
    stale: {
        lastSuccessAt: 1,
        reason: "Token expired (invalid_grant). Run: tools claude login side",
    },
};

const deadPlan: AccountUsage = {
    accountName: "expired",
    usage: usage(),
    orgBlocked: true,
    subscriptionPlan: "claude_free",
    subscriptionStatus: "canceled",
    stale: { lastSuccessAt: 1, reason: "OAuth authentication is currently not allowed for this organization." },
};

describe("applySort", () => {
    test("default order matches tools claude run: live, then stale login, then dead plan", () => {
        expect(applySort([staleLogin, deadPlan, live]).map((a) => a.accountName)).toEqual([
            "personal",
            "side",
            "expired",
        ]);
    });

    test("config mode keeps the poller order", () => {
        expect(applySort([staleLogin, deadPlan, live], "config").map((a) => a.accountName)).toEqual([
            "side",
            "expired",
            "personal",
        ]);
    });
});
