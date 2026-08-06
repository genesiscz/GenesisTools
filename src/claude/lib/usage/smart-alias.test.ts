import { describe, expect, test } from "bun:test";
import { scoreAccounts } from "./account-picker";
import type { AccountUsage } from "./api";
import { pickFable, pickOpus, smartAliasOf } from "./smart-alias";

const NOW = new Date("2026-07-18T12:00:00Z");
const WEEK_LATER = "2026-07-24T12:00:00Z";
const SESSION_RESET = "2026-07-18T16:00:00Z";

/** Percentages are USED (the API's own direction); leftPct = 100 - used. */
function account(
    accountName: string,
    opts: { session?: number; weekly: number; fable?: number; fableResetsAt?: string; weeklyResetsAt?: string }
): AccountUsage {
    return {
        accountName,
        usage: {
            five_hour: { utilization: opts.session ?? 10, resets_at: SESSION_RESET },
            seven_day: { utilization: opts.weekly, resets_at: opts.weeklyResetsAt ?? WEEK_LATER },
            ...(opts.fable === undefined
                ? {}
                : {
                      limits: [
                          {
                              kind: "weekly_scoped",
                              percent: opts.fable,
                              severity: "normal",
                              resets_at: opts.fableResetsAt ?? WEEK_LATER,
                              scope: { model: { id: null, display_name: "Fable" }, surface: null },
                              is_active: true,
                          },
                      ],
                  }),
        },
    };
}

const score = (accounts: AccountUsage[]) => scoreAccounts(accounts, { now: NOW });

describe("pickOpus", () => {
    test("below the 10% floor is skipped, so 9% loses to 14%", () => {
        const scored = score([
            account("nine", { weekly: 91, fable: 100 }),
            account("fourteen", { weekly: 86, fable: 100 }),
        ]);

        expect(pickOpus(scored, NOW)?.accountName).toBe("fourteen");
    });

    test("above the floor the EMPTIEST wins, so 11% beats 14%", () => {
        const scored = score([
            account("eleven", { weekly: 89, fable: 100 }),
            account("fourteen", { weekly: 86, fable: 100 }),
        ]);

        expect(pickOpus(scored, NOW)?.accountName).toBe("eleven");
    });

    test("Fable-capable accounts are reserved — a Fable-spent one wins even with less weekly", () => {
        const scored = score([
            // Fable still available: saved for fable work despite more headroom.
            account("fable-rich", { weekly: 20, fable: 30 }),
            account("fable-spent", { weekly: 70, fable: 100 }),
        ]);

        expect(pickOpus(scored, NOW)?.accountName).toBe("fable-spent");
    });

    test("nothing clears the floor ⇒ fullest account, with a warning (never blocks)", () => {
        const scored = score([
            account("almost-dead", { weekly: 96, fable: 100 }),
            account("thin", { weekly: 94, fable: 100 }),
        ]);

        const pick = pickOpus(scored, NOW);
        expect(pick?.accountName).toBe("thin");
        expect(pick?.warning).toContain("≥10% weekly");
        expect(pick?.line).toContain("wk 6% left");
    });

    test("a spent 5h window sinks below a fuller-but-cooler account", () => {
        const scored = score([
            // 5h at 1% left: cannot start a turn right now.
            account("cooling", { session: 99, weekly: 80, fable: 100 }),
            account("warm", { session: 10, weekly: 60, fable: 100 }),
        ]);

        expect(pickOpus(scored, NOW)?.accountName).toBe("warm");
    });

    test("dead and expired accounts are never auto-picked", () => {
        const scored = score([
            account("dead", { weekly: 100, fable: 100 }),
            { accountName: "expired", error: "invalid_grant" },
            account("alive", { weekly: 50, fable: 100 }),
        ]);

        expect(pickOpus(scored, NOW)?.accountName).toBe("alive");
    });

    test("a subscription-expired account is never auto-picked", () => {
        const scored = score([
            { accountName: "org-dead", orgBlocked: true, usage: account("x", { weekly: 0, fable: 0 }).usage },
            account("alive", { weekly: 50, fable: 100 }),
        ]);

        expect(pickOpus(scored, NOW)?.accountName).toBe("alive");
    });

    test("no usable account at all ⇒ null (caller falls back to the picker)", () => {
        const scored = score([account("dead", { weekly: 100, fable: 100 })]);
        expect(pickOpus(scored, NOW)).toBeNull();
    });
});

describe("pickFable", () => {
    test("most room wins when the gap is wide", () => {
        const scored = score([account("roomy", { weekly: 30, fable: 20 }), account("thin", { weekly: 30, fable: 70 })]);

        const pick = pickFable(scored, NOW);
        expect(pick?.accountName).toBe("roomy");
        expect(pick?.line).toContain("fable 80% left");
    });

    test("inside the band the earliest reset wins — that capacity expires first", () => {
        const scored = score([
            // 75% fable left, resets in 6 days.
            account("later", { weekly: 10, fable: 25 }),
            // 70% fable left (within 10 points), resets in 20h → spend this one.
            account("sooner", { weekly: 10, fable: 30, fableResetsAt: "2026-07-19T08:00:00Z" }),
        ]);

        expect(pickFable(scored, NOW)?.accountName).toBe("sooner");
    });

    test("room is capped by the all-model weekly bucket — Fable burns both", () => {
        const scored = score([
            // 90% fable but only 15% weekly ⇒ 15% of real room.
            account("weekly-bound", { weekly: 85, fable: 10 }),
            account("balanced", { weekly: 50, fable: 55 }),
        ]);

        expect(pickFable(scored, NOW)?.accountName).toBe("balanced");
    });

    test("Fable-exhausted accounts are not offered", () => {
        const scored = score([
            account("spent", { weekly: 20, fable: 100 }),
            account("has-fable", { weekly: 20, fable: 60 }),
        ]);

        expect(pickFable(scored, NOW)?.accountName).toBe("has-fable");
    });

    test("no Fable headroom anywhere ⇒ null", () => {
        const scored = score([account("spent", { weekly: 20, fable: 100 })]);
        expect(pickFable(scored, NOW)).toBeNull();
    });
});

describe("smartAliasOf", () => {
    test("recognizes the aliases, case-insensitively", () => {
        expect(smartAliasOf("opus", ["genesis"])).toBe("opus");
        expect(smartAliasOf("Fable", ["genesis"])).toBe("fable");
    });

    test("a real account of that name always wins", () => {
        expect(smartAliasOf("opus", ["Opus", "genesis"])).toBeNull();
    });

    test("anything else is a plain account name", () => {
        expect(smartAliasOf("genesis", ["genesis"])).toBeNull();
        expect(smartAliasOf(undefined, ["genesis"])).toBeNull();
    });
});
