import { describe, expect, test } from "bun:test";
import { stripAnsi } from "@genesiscz/utils/string";
import pc from "picocolors";
import type { ScoredAccount } from "./account-picker";
import { renderAccountUsage } from "./display";
import { accountCells } from "./usage-table";

const NOW = new Date("2026-07-10T12:00:00Z");

function scored(leftPct: number, resetsInMs: number): ScoredAccount {
    return {
        accountName: "a",
        tier: "ready",
        group: "fable",
        score: 1,
        cooling: false,
        surplus: true,
        bindingResetHours: 100,
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

describe("renderAccountUsage (tools claude usage --no-tui)", () => {
    const strip = stripAnsi;

    test("an account without a 5-hour limit prints no 5h bar, says so, and names only the windows the headers had", () => {
        const text = strip(
            renderAccountUsage({
                accountName: "work",
                usage: {
                    five_hour: null,
                    seven_day: { utilization: 30, resets_at: null },
                    quota: { source: "headers", fiveHourStatus: null, sevenDayStatus: "allowed" },
                },
            })
        );

        expect(text).toContain("Current session\n  — no 5h limit on this account");
        expect(text).toContain("Weekly and Fable from the rate-limit headers");
        expect(text).not.toMatch(/Current session\n\s+0% used/);
    });

    test("negative control: an idle 5h window keeps its 0% bar", () => {
        const text = strip(
            renderAccountUsage({
                accountName: "work",
                usage: {
                    five_hour: { utilization: 0, resets_at: null },
                    seven_day: { utilization: 30, resets_at: null },
                },
            })
        );

        expect(text).toMatch(/Current session\n\s+0% used/);
        expect(text).not.toContain("no 5h limit");
    });
});
