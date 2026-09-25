import { describe, expect, test } from "bun:test";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { formatResetCountdown, windowTail } from "../lib/reset-countdown";
import { accountHeaderParts, planRenewalLine } from "./account-section";

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
describe("planRenewalLine", () => {
    test("warns from the projected charge, not from a signup day that is weeks away", () => {
        const now = new Date(2026, 6, 24, 20, 0, 0).getTime();
        const createdAt = new Date(2024, 8, 24, 20, 25).toISOString();
        const renewsAt = new Date(2026, 6, 28, 12, 0, 0).toISOString();
        expect(planRenewalLine(snapshot({ plan: { status: "active", createdAt, renewsAt } }), now)).toMatch(
            /^⚠ plan ends ~/
        );
        expect(planRenewalLine(snapshot({ plan: { status: "canceled", renewsAt } }), now)).toBeNull();
    });

    test("no projected charge is no warning, even when the signup day falls in the last week", () => {
        const now = new Date(2026, 6, 24, 20, 0, 0).getTime();
        const createdAt = new Date(2024, 8, 27, 12, 0, 0).toISOString();
        expect(planRenewalLine(snapshot({ plan: { status: "active", createdAt } }), now)).toBeNull();
    });
});

describe("windowTail", () => {
    const now = Date.parse("2026-09-10T16:00:00.000Z");

    test("counts down to the reset of a spent window", () => {
        expect(windowTail({ percentUsed: 48, resetsAt: "2026-09-15T01:22:26.000Z" }, now)).toBe("⟳ 4d 9h 22m");
        expect(windowTail({ percentUsed: 3, resetsAt: "2026-09-10T16:40:00.000Z" }, now)).toBe("⟳ 40m");
    });

    test("reads an idle window as not used and a rolled-over one as resetting now", () => {
        expect(windowTail({ percentUsed: 0 }, now)).toBe("not used");
        expect(windowTail({ percentUsed: 12, resetsAt: "2026-09-10T15:00:00.000Z" }, now)).toBe("⟳ resets now");
    });

    test("stays empty for a spent window with no reset time", () => {
        expect(windowTail({ percentUsed: 12 }, now)).toBe("");
        expect(formatResetCountdown("not a date", now)).toBeNull();
    });
});
