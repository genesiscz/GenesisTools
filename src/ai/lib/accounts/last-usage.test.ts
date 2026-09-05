import { describe, expect, test } from "bun:test";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { AccountUsageSnapshot, LimitWindow } from "@genesiscz/utils/ai/providers/account-features";
import type { SnapshotsCache } from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import { formatLimitLine, lastSnapshotFor } from "./last-usage";

/**
 * `tools ai accounts show` reports the last RECORDED snapshot and never polls, so
 * these pin the two rules that decide what it prints: which row belongs to the
 * account, and how one window reads as a line.
 *
 * Fixture account names only (`work`, `personal`, `shop`) — never a live one.
 */

function account(overrides: Partial<AccountEntry> = {}): AccountEntry {
    return {
        id: "acc_work",
        name: "work",
        provider: "anthropic-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
        ...overrides,
    };
}

function snapshot(overrides: Partial<AccountUsageSnapshot> = {}): AccountUsageSnapshot {
    return {
        provider: "anthropic-sub",
        accountId: "acc_work",
        accountName: "work",
        fetchedAt: "2026-09-05T12:00:00.000Z",
        limits: [],
        ...overrides,
    };
}

function cache(rows: AccountUsageSnapshot[], provider = "anthropic-sub"): SnapshotsCache {
    return {
        fetchedAt: "2026-09-05T12:00:00.000Z",
        providers: {
            [provider]: { alias: "claude", displayName: "Claude", prominent: [], accounts: rows },
        },
    };
}

describe("lastSnapshotFor", () => {
    test("no cache file at all is an ordinary outcome, not an error", () => {
        expect(lastSnapshotFor(null, account())).toBeUndefined();
    });

    test("a provider with no slice in the cache yields nothing", () => {
        expect(lastSnapshotFor(cache([snapshot()], "grok-sub"), account())).toBeUndefined();
    });

    test("the row is matched by account id", () => {
        const mine = snapshot({ accountId: "acc_work", accountName: "work" });
        const other = snapshot({ accountId: "acc_shop", accountName: "shop" });

        expect(lastSnapshotFor(cache([other, mine]), account())).toBe(mine);
    });

    test("a rename keeps the id, so the snapshot recorded under the old name still matches", () => {
        // The row was written before the rename; the account is now called `personal`.
        const recorded = snapshot({ accountId: "acc_work", accountName: "work" });

        expect(lastSnapshotFor(cache([recorded]), account({ name: "personal" }))).toBe(recorded);
    });

    test("a row written without an id falls back to the account name", () => {
        const legacy = snapshot({ accountId: "", accountName: "work" });

        expect(lastSnapshotFor(cache([legacy]), account())).toBe(legacy);
    });

    test("an id-less row belonging to a DIFFERENT account is not claimed", () => {
        const other = snapshot({ accountId: "", accountName: "shop" });

        expect(lastSnapshotFor(cache([other]), account())).toBeUndefined();
    });
});

describe("formatLimitLine", () => {
    const now = Date.parse("2026-09-05T12:00:00.000Z");

    function window(overrides: Partial<LimitWindow> = {}): LimitWindow {
        return { key: "five_hour", label: "5h", kind: "session", percentUsed: 42, ...overrides };
    }

    test("a percentage window keeps one decimal", () => {
        expect(formatLimitLine(window({ percentUsed: 42.35 }), now)).toBe("42.4%");
    });

    test("a reset in the future is reported as a gap", () => {
        const line = formatLimitLine(window({ resetsAt: "2026-09-05T14:15:00.000Z" }), now);

        expect(line).toBe("42.0%  ·  resets in 2h 15m");
    });

    test("a reset already past says so rather than printing a negative gap", () => {
        const line = formatLimitLine(window({ resetsAt: "2026-09-05T11:00:00.000Z" }), now);

        expect(line).toBe("42.0%  ·  reset due");
    });

    test("an unparseable reset timestamp is dropped, not printed as NaN", () => {
        expect(formatLimitLine(window({ resetsAt: "not-a-date" }), now)).toBe("42.0%");
    });

    test("a credit window shows the money pair beside the percentage", () => {
        const line = formatLimitLine(
            window({
                key: "monthly",
                label: "Monthly",
                kind: "credit",
                percentUsed: 30,
                money: { usedMinor: 900, limitMinor: 3000, currency: "USD", exponent: 2 },
            }),
            now
        );

        expect(line).toBe("30.0%  ·  9.00 / 30.00 USD");
    });

    test("a three-decimal currency keeps all three digits", () => {
        const line = formatLimitLine(
            window({ kind: "credit", money: { usedMinor: 1234, limitMinor: 10_000, currency: "KWD", exponent: 3 } }),
            now
        );

        expect(line).toContain("1.234 / 10.000 KWD");
    });

    test("a zero-decimal currency shows no decimals, and no limit means no pair", () => {
        const line = formatLimitLine(
            window({ kind: "credit", money: { usedMinor: 1234, currency: "JPY", exponent: 0 } }),
            now
        );

        expect(line).toContain("1234 JPY");
        expect(line).not.toContain("/");
    });
});
