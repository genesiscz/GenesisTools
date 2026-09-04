import { describe, expect, test } from "bun:test";
import type { AccountUsageSnapshot, UsagePresenters } from "@genesiscz/utils/ai/providers/account-features";
import type { SeriesEntry } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { cycleProvider, toggleAccount } from "./filters";
import { nextPollState, notifiableWindows } from "./hooks/use-poller";
import { formatTimeRange } from "./types";
import { formatMoney, orderWindows } from "./views/account-section";
import { seriesToRows } from "./views/history-view";
import { sortSnapshots, urgencyOf } from "./views/overview-view";

/**
 * The dashboard shell has no render harness (`ink-testing-library` is not a dependency,
 * spec 7.6), so every rule that decides what the user sees lives in a pure function and
 * is tested here: the poll reducer, the sort, the window ordering and the filters.
 */

function codex(name: string, primary: number, secondary = 5): AccountUsageSnapshot {
    return {
        provider: "openai-sub",
        accountId: `acc_${name}`,
        accountName: name,
        fetchedAt: "2026-09-04T18:00:00.000Z",
        limits: [
            {
                key: "primary",
                label: "5h",
                kind: "session",
                percentUsed: primary,
                resetsAt: "2026-09-04T20:00:00.000Z",
            },
            { key: "secondary", label: "Weekly", kind: "weekly", percentUsed: secondary },
        ],
        plan: { name: "plus" },
    };
}

function grok(name: string, percent: number): AccountUsageSnapshot {
    return {
        provider: "grok-sub",
        accountId: `acc_${name}`,
        accountName: name,
        fetchedAt: "2026-09-04T18:00:00.000Z",
        limits: [
            {
                key: "monthly",
                label: "Monthly",
                kind: "credit",
                percentUsed: percent,
                money: { usedMinor: 900, limitMinor: 3000, currency: "USD", exponent: 2 },
            },
        ],
    };
}

describe("poll reducer", () => {
    test("a successful round replaces the accounts and clears the error", () => {
        const at = new Date("2026-09-04T18:01:00.000Z");
        const previous = { accounts: [codex("work", 1)], timestamp: new Date(0), error: "boom" };

        const next = nextPollState(previous, { ok: true, accounts: [codex("work", 42)], at });

        expect(next.error).toBeUndefined();
        expect(next.accounts[0].limits[0].percentUsed).toBe(42);
        expect(next.timestamp).toBe(at);
    });

    // The rule the shell exists to keep: a failed round must not blank the screen.
    test("a failed round keeps the last accounts and records the error", () => {
        const previous = { accounts: [codex("work", 42)], timestamp: new Date(0) };

        const next = nextPollState(previous, { ok: false, error: "app-server timed out", at: new Date() });

        expect(next.accounts[0].limits[0].percentUsed).toBe(42);
        expect(next.error).toBe("app-server timed out");
    });

    test("a first-round failure renders an empty list rather than throwing", () => {
        expect(nextPollState(null, { ok: false, error: "no accounts", at: new Date() }).accounts).toEqual([]);
    });
});

describe("notifiableWindows", () => {
    test("flattens every window of every healthy account", () => {
        const windows = notifiableWindows([codex("work", 90), grok("personal", 30)]);

        expect(windows.map((w) => `${w.accountName}:${w.key}`)).toEqual([
            "work:primary",
            "work:secondary",
            "personal:monthly",
        ]);
        expect(windows[0]).toMatchObject({ kind: "session", label: "5h", utilization: 90 });
    });

    // Negative control: stale and errored rows replay old numbers and must not re-fire.
    test("skips stale and errored snapshots", () => {
        const stale = { ...codex("work", 90), stale: { lastSuccessAt: "2026-09-04T17:00:00.000Z", reason: "429" } };
        const failed = { ...codex("personal", 90), error: "not logged in" };

        expect(notifiableWindows([stale, failed])).toEqual([]);
    });
});

describe("overview sorting", () => {
    test("urgency puts the most spent account first, per provider", () => {
        const sorted = sortSnapshots([codex("work", 10), codex("personal", 90)], {}, "urgency");

        expect(sorted.map((s) => s.accountName)).toEqual(["personal", "work"]);
    });

    test("config order is left untouched", () => {
        const sorted = sortSnapshots([codex("work", 10), codex("personal", 90)], {}, "config");

        expect(sorted.map((s) => s.accountName)).toEqual(["work", "personal"]);
    });

    test("a provider presenter's own score wins for that provider only", () => {
        const presenters: Record<string, UsagePresenters | undefined> = {
            "openai-sub": {
                score: (snapshots) => [...snapshots].sort((a, b) => a.accountName.localeCompare(b.accountName)),
            },
        };

        const sorted = sortSnapshots(
            [codex("work", 90), codex("personal", 10), grok("shop", 50)],
            presenters,
            "urgency"
        );

        expect(sorted.map((s) => s.accountName)).toEqual(["personal", "work", "shop"]);
    });

    test("urgency reads the highest window, not the first", () => {
        expect(urgencyOf(codex("work", 10, 88))).toBe(88);
    });
});

describe("generic account section", () => {
    test("prominent keys decide the order and drop the rest", () => {
        const windows = orderWindows(codex("work", 40).limits, ["secondary"]);

        expect(windows.map((w) => w.key)).toEqual(["secondary"]);
    });

    test("no prominent list shows every window the provider returned", () => {
        expect(orderWindows(codex("work", 40).limits).map((w) => w.key)).toEqual(["primary", "secondary"]);
    });

    test("a credit window renders money in major units", () => {
        expect(formatMoney(grok("work", 30).limits[0])).toBe("9.00 / 30.00 USD");
    });

    test("a percent window has no money line", () => {
        expect(formatMoney(codex("work", 30).limits[0])).toBeNull();
    });

    // Three-decimal currencies exist (KWD, BHD, JOD). Formatting them at two digits
    // silently drops a minor unit.
    test("a three-decimal currency keeps all three digits", () => {
        const window = {
            key: "credit",
            label: "Credit",
            kind: "credit" as const,
            percentUsed: 12,
            money: { usedMinor: 1234, limitMinor: 10_000, currency: "KWD", exponent: 3 },
        };

        expect(formatMoney(window)).toBe("1.234 / 10.000 KWD");
    });

    // Negative control: a zero-exponent currency still shows no decimals.
    test("a zero-decimal currency shows no decimals", () => {
        const window = {
            key: "credit",
            label: "Credit",
            kind: "credit" as const,
            percentUsed: 12,
            money: { usedMinor: 1234, currency: "JPY", exponent: 0 },
        };

        expect(formatMoney(window)).toBe("1234 JPY");
    });
});

describe("history rows", () => {
    const series: SeriesEntry[] = [
        {
            provider: "openai-sub",
            account: "work",
            key: "primary",
            points: [
                { t: "2026-09-04T17:00:00.000Z", percent: 10 },
                { t: "2026-09-04T17:30:00.000Z", percent: 25 },
            ],
        },
        {
            provider: "grok-sub",
            account: "personal",
            key: "monthly",
            points: [{ t: "2026-09-04T17:10:00.000Z", percent: 5 }],
        },
    ];

    test("computes a per-series delta and sorts newest first inside an account", () => {
        const rows = seriesToRows(series);

        expect(rows.map((r) => r.account)).toEqual(["personal", "work", "work"]);
        const work = rows.filter((r) => r.account === "work");
        expect(work[0].percent).toBe(25);
        expect(work[0].delta).toBe(15);
        expect(work[1].delta).toBeNull();
    });
});

describe("filters", () => {
    test("P cycles all → each provider → all", () => {
        const providers = ["anthropic-sub", "openai-sub"];

        expect(cycleProvider(null, providers)).toBe("anthropic-sub");
        expect(cycleProvider("anthropic-sub", providers)).toBe("openai-sub");
        expect(cycleProvider("openai-sub", providers)).toBeNull();
    });

    test("cycling with no providers stays on all", () => {
        expect(cycleProvider(null, [])).toBeNull();
    });

    test("deselecting one account narrows the filter, reselecting it clears the filter", () => {
        const all = ["work", "personal", "shop"];

        const narrowed = toggleAccount(null, "shop", all);
        expect(narrowed).toEqual(["work", "personal"]);

        expect(toggleAccount(narrowed, "shop", all)).toBeNull();
    });

    test("time ranges render the way the filter bar prints them", () => {
        expect(formatTimeRange(60)).toBe("60m");
        expect(formatTimeRange(360)).toBe("6h");
        expect(formatTimeRange(10_080)).toBe("7d");
    });
});
