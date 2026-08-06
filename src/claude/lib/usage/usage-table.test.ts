import { describe, expect, test } from "bun:test";
import pc from "picocolors";
import type { ScoredAccount } from "./account-picker";
import { accountCells } from "./usage-table";

const NOW = new Date("2026-07-10T12:00:00Z");

function scored(leftPct: number, resetsInMs: number): ScoredAccount {
    return {
        accountName: "a",
        tier: "ready",
        group: "fable",
        score: 1,
        cooling: false,
        weeklyRatePctPerHour: 1,
        sessionHeadroomPct: leftPct,
        weeklyHeadroomPct: leftPct,
        sessionUsableFraction: 1,
        why: "",
        limits: { session: { leftPct, resetsAt: new Date(NOW.getTime() + resetsInMs).toISOString() } },
    };
}

// Expectations are built with picocolors itself so they hold whether or not
// the test terminal supports color; with color on they pin the exact paint.
describe("percent cells are colored by headroom alone", () => {
    test("a nearly-spent bucket resetting in 10 minutes still reads red", () => {
        // Regression pin: the old colorByHeadroom bent this green because the
        // reset was imminent.
        expect(accountCells(scored(5, 10 * 60_000), NOW)[1]).toBe(pc.red("5%"));
    });

    test("a full bucket reads green whatever the reset distance", () => {
        expect(accountCells(scored(90, 10 * 60_000), NOW)[1]).toBe(pc.green("90%"));
    });
});

describe("expired-row rendering", () => {
    test("a subscription-expired account renders its name struck through", () => {
        const dead = { ...scored(50, 60_000), subscriptionExpired: true };
        expect(accountCells(dead, NOW)[0]).toBe(pc.strikethrough(pc.dim("a")));
    });
});
