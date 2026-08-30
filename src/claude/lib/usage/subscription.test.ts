import { describe, expect, test } from "bun:test";
import {
    formatCoarseSpan,
    formatCzechDateTime,
    formatRelativeSpan,
    formatRenewsAt,
    formatRenewsAtFull,
    nextRenewalDate,
    planAllowsClaudeCode,
} from "./subscription";

// Local time on purpose: nextRenewalDate builds candidates with the local-time
// Date constructor, so the anchors and expectations must share that frame.
const NOW = new Date(2026, 6, 24, 20, 0, 0);

describe("nextRenewalDate", () => {
    test("rolls forward to this month when the anchor day is still ahead", () => {
        const next = nextRenewalDate(new Date(2026, 0, 28, 9, 44).toISOString(), NOW);
        expect(next?.getMonth()).toBe(6);
        expect(next?.getDate()).toBe(28);
    });

    test("rolls to next month once the anchor day has passed", () => {
        const next = nextRenewalDate(new Date(2026, 0, 6, 9, 44).toISOString(), NOW);
        expect(next?.getMonth()).toBe(7);
        expect(next?.getDate()).toBe(6);
    });

    test("clamps a 31st anchor into a short month", () => {
        // From 2026-09-15, the next occurrence of a 31st anchor is September 30.
        const from = new Date(2026, 8, 15, 12, 0);
        const next = nextRenewalDate(new Date(2026, 0, 31, 9, 44).toISOString(), from);
        expect(next?.getMonth()).toBe(8);
        expect(next?.getDate()).toBe(30);
    });

    test("preserves seconds so a renewal seconds away does not skip a month", () => {
        const anchor = new Date(2026, 0, 24, 20, 0, 30);
        const next = nextRenewalDate(anchor.toISOString(), NOW);
        expect(next?.getMonth()).toBe(6);
        expect(next?.getSeconds()).toBe(30);
    });

    test("an anchor exactly at now rolls to next month (strictly future)", () => {
        const next = nextRenewalDate(new Date(2026, 0, 24, 20, 0, 0).toISOString(), NOW);
        expect(next?.getMonth()).toBe(7);
    });

    test("a malformed anchor yields null", () => {
        expect(nextRenewalDate("not-a-date", NOW)).toBeNull();
    });
});

describe("formatCoarseSpan", () => {
    test("days above 24h", () => {
        expect(formatCoarseSpan(NOW, new Date(NOW.getTime() + 28 * 86_400_000))).toBe("28d");
    });

    test("hours below a day", () => {
        expect(formatCoarseSpan(NOW, new Date(NOW.getTime() + 7 * 3_600_000))).toBe("7h");
    });

    test("minutes in the last hour", () => {
        expect(formatCoarseSpan(NOW, new Date(NOW.getTime() + 12 * 60_000))).toBe("12m");
    });

    test("a past target floors at one minute rather than going negative", () => {
        expect(formatCoarseSpan(NOW, new Date(NOW.getTime() - 5_000))).toBe("1m");
    });
});

describe("formatRelativeSpan", () => {
    test("days and hours", () => {
        expect(formatRelativeSpan(NOW, new Date(NOW.getTime() + 28 * 86_400_000 + 21 * 3_600_000))).toBe("28d 21h");
    });

    test("hours and minutes", () => {
        expect(formatRelativeSpan(NOW, new Date(NOW.getTime() + 5 * 3_600_000 + 20 * 60_000))).toBe("5h 20m");
    });
});

describe("formatCzechDateTime", () => {
    test("pads day, month, hour and minute", () => {
        expect(formatCzechDateTime(new Date(2026, 7, 6, 9, 4))).toBe("06.08.2026 09:04");
    });
});

describe("formatRenewsAt / formatRenewsAtFull", () => {
    test("null without an anchor", () => {
        expect(formatRenewsAt(undefined, NOW)).toBeNull();
        expect(formatRenewsAtFull(undefined, NOW)).toBeNull();
    });

    test("compact form is a single-unit countdown", () => {
        expect(formatRenewsAt(new Date(2026, 0, 28, 9, 44).toISOString(), NOW)).toBe("renews in 3d");
    });

    test("full form carries the absolute date and the distance", () => {
        const full = formatRenewsAtFull(new Date(2026, 0, 28, 9, 44).toISOString(), NOW);
        expect(full).toContain("renews 28.07.2026 09:44");
        expect(full).toContain("(in 3d");
    });
});

describe("planAllowsClaudeCode: a contradicted reading", () => {
    // pribik.turena, 2026-08-29. Its refresh grant was dead, so the profile
    // re-read that would have noticed the renewal could never run and the stale
    // "claude_free (canceled)" sustained itself indefinitely.
    test("a live probe overrides a stored dead plan", () => {
        expect(
            planAllowsClaudeCode({
                subscriptionPlan: "claude_free",
                subscriptionStatus: "canceled",
                planContradictedAt: 2000,
            })
        ).toBe(true);
    });

    test("a profile read NEWER than the contradiction wins again", () => {
        // The account really did lapse after the probe saw it alive. The fresh
        // reading is authoritative; a stale contradiction must not outrank it.
        expect(
            planAllowsClaudeCode({
                subscriptionPlan: "claude_free",
                subscriptionStatus: "canceled",
                planContradictedAt: 2000,
                subscriptionCheckedAt: 3000,
            })
        ).toBe(false);
    });

    test("no contradiction leaves a dead plan dead", () => {
        expect(planAllowsClaudeCode({ subscriptionPlan: "claude_free", subscriptionStatus: "canceled" })).toBe(false);
    });

    test("a contradiction does not disturb a healthy account", () => {
        expect(planAllowsClaudeCode({ subscriptionPlan: "claude_max", subscriptionStatus: "active" })).toBe(true);
    });
});
