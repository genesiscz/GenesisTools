import { describe, expect, test } from "bun:test";
import type { AccountUsage } from "@app/claude/lib/usage/api";
import { grantWarningText, headerExtras } from "./account-section";

const NOW = new Date("2026-07-24T20:00:00.000Z").getTime();
const WIDE = 200;

function account(overrides: Partial<AccountUsage> = {}): AccountUsage {
    return { accountName: "foltyn", ...overrides };
}

function daysFromNow(days: number): number {
    return NOW + days * 86_400_000;
}

describe("grantWarningText", () => {
    test("silent without a known grant expiry", () => {
        expect(grantWarningText(account(), NOW)).toBeNull();
    });

    test("silent while the grant is comfortably alive", () => {
        expect(grantWarningText(account({ refreshExpiresAt: daysFromNow(30) }), NOW)).toBeNull();
    });

    test("warns inside the 14-day window", () => {
        expect(grantWarningText(account({ refreshExpiresAt: daysFromNow(3) }), NOW)).toBe("⚠ login ends in 3d");
    });

    test("an already-passed expiry reads as expired", () => {
        expect(grantWarningText(account({ refreshExpiresAt: daysFromNow(-1) }), NOW)).toBe("⚠ login expired");
    });
});

describe("headerExtras", () => {
    test("plan label and renewal render as one fact", () => {
        const extras = headerExtras({
            account: account({ label: "max 20x", subscriptionCreatedAt: "2026-01-28T09:44:00.000Z" }),
            staleText: null,
            width: WIDE,
            now: NOW,
        });

        expect(extras.renewsText).toContain("max 20x");
        expect(extras.renewsText).toContain("renews in");
    });

    test("the label alone survives when the line cannot fit both", () => {
        const extras = headerExtras({
            account: account({ label: "max 20x", subscriptionCreatedAt: "2026-01-28T09:44:00.000Z" }),
            staleText: null,
            width: 22,
            now: NOW,
        });

        expect(extras.renewsText).toBe("max 20x");
    });

    test("both extras drop on a very narrow column", () => {
        const extras = headerExtras({
            account: account({ label: "max 20x", subscriptionCreatedAt: "2026-01-28T09:44:00.000Z" }),
            staleText: null,
            width: 10,
            now: NOW,
        });

        expect(extras.renewsText).toBeNull();
        expect(extras.grantText).toBeNull();
    });

    test("the grant warning outranks the renewal date when space is tight", () => {
        const extras = headerExtras({
            account: account({
                label: "max 20x",
                subscriptionCreatedAt: "2026-01-28T09:44:00.000Z",
                refreshExpiresAt: daysFromNow(2),
            }),
            staleText: null,
            width: 34,
            now: NOW,
        });

        expect(extras.grantText).toBe("⚠ login ends in 2d");
        expect(extras.renewsText).toBeNull();
    });

    test("no renewal anchor and no label yields nothing", () => {
        expect(headerExtras({ account: account(), staleText: null, width: WIDE, now: NOW }).renewsText).toBeNull();
    });
});
