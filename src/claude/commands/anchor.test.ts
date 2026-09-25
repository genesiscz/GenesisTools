import { describe, expect, test } from "bun:test";
import { nextRenewalDate } from "@app/claude/lib/usage/subscription";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { parseAnchor, planAnchor } from "./anchor";

const NOW = new Date(2026, 8, 24, 10, 0, 0);

function account(extra: Partial<AIAccountEntry> = {}): AIAccountEntry {
    return { name: "work", provider: "anthropic-sub", tokens: {}, ...extra };
}

describe("parseAnchor", () => {
    test("a date-only anchor is stored as the calendar day itself", () => {
        expect(parseAnchor("2026-07-07")).toBe("2026-07-07");
    });

    test("a day that does not exist is refused, never rolled into the next month", () => {
        for (const bad of ["2026-02-30", "2026-13-01", "2026-02-30T10:00:00Z", "July 7", "2026-7-7", ""]) {
            expect(parseAnchor(bad)).toBeNull();
        }
    });

    test("an ISO timestamp with a zone is kept as its instant", () => {
        expect(parseAnchor("2026-07-07T10:00:00+02:00")).toBe("2026-07-07T08:00:00.000Z");
    });

    test("a date-only anchor projects onto the same day of the month wherever it is read", () => {
        const next = nextRenewalDate("2026-07-07", NOW);

        expect(next?.getDate()).toBe(7);
        expect(next?.getMonth()).toBe(9);
    });
});

describe("planAnchor", () => {
    test("a set stores the override and projects from it", () => {
        const plan = planAnchor(account({ subscriptionCreatedAt: "2025-01-24T10:00:00.000Z" }), {
            date: "2026-07-07",
            clear: false,
            now: NOW,
        });

        expect(plan).toMatchObject({ ok: true, override: "2026-07-07", anchor: "2026-07-07" });
        expect(plan.ok && plan.next?.getDate()).toBe(7);
    });

    test("a clear drops the override and falls back to the profile stamp, or to nothing", () => {
        const withProfile = planAnchor(
            account({ subscriptionAnchorOverride: "2026-07-07", subscriptionCreatedAt: "2025-01-24T10:00:00.000Z" }),
            { clear: true, now: NOW }
        );
        const bare = planAnchor(account({ subscriptionAnchorOverride: "2026-07-07" }), { clear: true, now: NOW });

        expect(withProfile).toMatchObject({ ok: true, override: undefined, anchor: "2025-01-24T10:00:00.000Z" });
        expect(bare).toEqual({ ok: true, override: undefined, anchor: undefined, next: null });
    });

    test("no date and no clear, or a bad date, is an error before anything is written", () => {
        expect(planAnchor(account(), { clear: false, now: NOW })).toMatchObject({ ok: false });
        expect(planAnchor(account(), { date: "2026-02-30", clear: false, now: NOW })).toMatchObject({
            ok: false,
            error: expect.stringContaining("not a date"),
        });
    });
});
