import { describe, expect, test } from "bun:test";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { accountHeaderParts } from "./account-section";

function snapshot(overrides: Partial<AccountUsageSnapshot>): AccountUsageSnapshot {
    return {
        provider: "openai-sub",
        accountId: "acc_work",
        accountName: "work",
        fetchedAt: "2026-09-10T15:00:00.000Z",
        limits: [],
        ...overrides,
    };
}

describe("accountHeaderParts", () => {
    test("leads with the account name and names the plan once, even when the label repeats it", () => {
        expect(accountHeaderParts(snapshot({ label: "pro", plan: { name: "pro" } }))).toEqual([
            "work",
            "openai-sub",
            "pro",
        ]);
        expect(
            accountHeaderParts(snapshot({ provider: "grok-sub", label: "tier 5", plan: { name: "SuperGrok Heavy" } }))
        ).toEqual(["work", "grok-sub", "SuperGrok Heavy"]);
    });

    test("falls back to the label when there is no plan, and to nothing when there is neither", () => {
        expect(accountHeaderParts(snapshot({ label: "side" }))).toEqual(["work", "openai-sub", "side"]);
        expect(accountHeaderParts(snapshot({}))).toEqual(["work", "openai-sub"]);
    });
});
