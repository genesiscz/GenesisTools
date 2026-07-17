import { describe, expect, it } from "bun:test";
import { computeAllowanceReset, computePeriodState, monthKeyUtc } from "@app/youtube/lib/billing-cycle";

const base = { periodStartBalance: 3200, allowanceGranted: 3000, newAllowance: 3000 };

describe("computeAllowanceReset", () => {
    it("A: no-spend renewal is NOT additive (delta 0)", () => {
        expect(computeAllowanceReset({ ...base, balance: 3200, grantsSince: 0 })).toEqual({
            spentSince: 0,
            allowanceRemaining: 3000,
            topupRemainder: 200,
            newBalance: 3200,
            delta: 0,
        });
    });

    it("B: partial spend refills exactly what was used", () => {
        expect(computeAllowanceReset({ ...base, balance: 2000, grantsSince: 0 })).toEqual({
            spentSince: 1200,
            allowanceRemaining: 1800,
            topupRemainder: 200,
            newBalance: 3200,
            delta: 1200,
        });
    });

    it("C: overspend into topup — full allowance refill, topup remainder kept", () => {
        expect(computeAllowanceReset({ ...base, balance: 100, grantsSince: 0 })).toEqual({
            spentSince: 3100,
            allowanceRemaining: 0,
            topupRemainder: 100,
            newBalance: 3100,
            delta: 3000,
        });
    });

    it("D: mid-period pack purchase survives the reset", () => {
        expect(computeAllowanceReset({ ...base, balance: 2500, grantsSince: 500 })).toEqual({
            spentSince: 1200,
            allowanceRemaining: 1800,
            topupRemainder: 700,
            newBalance: 3700,
            delta: 1200,
        });
    });

    it("E: downgrade produces a negative delta but never touches topup", () => {
        expect(computeAllowanceReset({ ...base, balance: 2500, grantsSince: 500, newAllowance: 1000 })).toEqual({
            spentSince: 1200,
            allowanceRemaining: 1800,
            topupRemainder: 700,
            newBalance: 1700,
            delta: -800,
        });
    });
});

describe("computePeriodState / monthKeyUtc", () => {
    it("clamps allowanceRemaining by current balance", () => {
        const state = computePeriodState({
            balance: 50,
            periodStartBalance: 3000,
            grantsSince: 0,
            allowanceGranted: 3000,
        });

        expect(state.allowanceRemaining).toBe(50);
        expect(state.topupRemainder).toBe(0);
    });

    it("formats UTC month keys", () => {
        expect(monthKeyUtc(new Date("2026-07-17T23:59:59Z"))).toBe("2026-07");
        expect(monthKeyUtc(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
    });
});
