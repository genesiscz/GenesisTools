import { describe, expect, test } from "bun:test";
import type { AccountUsageSnapshot, LimitWindow } from "@app/dev-dashboard/contract/ai-accounts";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AccountCard } from "./AccountCard";
import { absentLimitRowText, formatMoney, limitColor, percentOf } from "./LimitBar";
import { mergeLimitSeries } from "./LimitsChart";

/**
 * `anthropic-sub` forwards the API's own exponent into `LimitMoney`, so a
 * non-2 exponent reaches this formatter. It used to scale by the exponent and
 * then round to two decimals regardless (CodeRabbit review, PR #363).
 */
describe("formatMoney", () => {
    test("two decimals is still two decimals", () => {
        expect(formatMoney({ usedMinor: 900, limitMinor: 3000, currency: "USD", exponent: 2 })).toBe("$9.00 / $30.00");
    });

    test("a three-decimal currency keeps its last minor-unit digit", () => {
        expect(formatMoney({ usedMinor: 9123, limitMinor: 30000, currency: "KWD", exponent: 3 })).toBe(
            "KWD 9.123 / KWD 30.000"
        );
    });

    test("a zero-decimal currency gains no decimals", () => {
        expect(formatMoney({ usedMinor: 900, limitMinor: 3000, currency: "JPY", exponent: 0 })).toBe(
            "JPY 900 / JPY 3000"
        );
    });

    test("a window with no limit prints the used amount alone, at its own precision", () => {
        expect(formatMoney({ usedMinor: 9123, currency: "KWD", exponent: 3 })).toBe("KWD 9.123");
    });
});

describe("percentOf", () => {
    test("a real percentage passes through", () => {
        expect(percentOf({ percentUsed: 42 } as LimitWindow)).toBe(42);
    });

    test("a row off an older snapshot reads as 0 rather than blanking the page", () => {
        const fromDisk = {
            key: "product:grokimagine",
            label: "Grok Imagine",
            kind: "scoped",
        } as unknown as LimitWindow;

        expect(percentOf(fromDisk)).toBe(0);
        expect(() => percentOf(fromDisk).toFixed(0)).not.toThrow();
        expect(limitColor(fromDisk)).toBe("var(--dd-accent-from)");
    });
});

describe("formatMoney honours the limit exponent and the cap", () => {
    test("a limit with its own exponent is not scaled by the spend's", () => {
        expect(formatMoney({ usedMinor: 900, limitMinor: 30, currency: "USD", exponent: 2, limitExponent: 0 })).toBe(
            "$9.00 / $30"
        );
    });

    test("a configured ceiling with no limit is printed", () => {
        expect(formatMoney({ usedMinor: 900, currency: "USD", exponent: 2, capMinor: 3000 })).toBe("$9.00 / $30.00");
    });

    test("the cap keeps its own currency", () => {
        expect(formatMoney({ usedMinor: 900, currency: "USD", exponent: 2, capMinor: 3000, capCurrency: "EUR" })).toBe(
            "$9.00 / EUR 30.00"
        );
    });
});

describe("absentLimitRowText", () => {
    test("an account without a 5-hour limit reads as a dash and no 5h limit, never 0%", () => {
        expect(absentLimitRowText({ key: "five_hour", kind: "session" })).toEqual({
            label: "Session (5h)",
            value: "— no 5h limit",
        });
    });
});

describe("AccountCard with an absent window", () => {
    const snapshot = (overrides: Partial<AccountUsageSnapshot> = {}): AccountUsageSnapshot => ({
        provider: "anthropic-sub",
        accountId: "acc_work",
        accountName: "work",
        fetchedAt: "2026-11-01T10:00:00.000Z",
        limits: [],
        ...overrides,
    });
    const render = (value: AccountUsageSnapshot) =>
        renderToString(
            createElement(AccountCard, {
                snapshot: value,
                color: "#888888",
                nowMs: Date.parse("2026-11-01T10:05:00.000Z"),
                prominentKeys: ["five_hour", "seven_day"],
            })
        );

    test("a poll that reported only 'no 5h limit' shows that row, not the empty state", () => {
        const html = render(snapshot({ absentLimits: [{ key: "five_hour", kind: "session" }] }));

        expect(html).toContain("— no 5h limit");
        expect(html).not.toContain("No usage data.");
    });

    test("negative control: a snapshot with no window at all keeps the empty state", () => {
        const html = render(snapshot());

        expect(html).toContain("No usage data.");
        expect(html).not.toContain("no 5h limit");
    });
});

describe("mergeLimitSeries", () => {
    const series = (key: string, points: Array<[string, number]>, endedAt?: string) => ({
        accountId: "acc_work",
        accountName: "work",
        provider: "anthropic-sub",
        key,
        label: key,
        points: points.map(([t, percent]) => ({ t, percent })),
        ...(endedAt ? { endedAt } : {}),
    });

    test("a window the account no longer has stops at its end; a live one carries its level forward", () => {
        const rows = mergeLimitSeries([
            series("five_hour", [["2026-11-01T10:00:00Z", 40]], "2026-11-01T10:00:00Z"),
            series("seven_day", [
                ["2026-11-01T10:00:00Z", 20],
                ["2026-11-01T12:00:00Z", 25],
            ]),
        ]);

        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ "acc_work:five_hour": 40, "acc_work:seven_day": 20 });
        expect(rows[1]["acc_work:five_hour"]).toBeUndefined();
        expect(rows[1]["acc_work:seven_day"]).toBe(25);
    });
});
