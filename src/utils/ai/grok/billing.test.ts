import { describe, expect, it } from "bun:test";
import { billingPeriodRemaining, formatBillingSummary } from "./billing";

describe("grok billing", () => {
    it("formats subscription usage summary", () => {
        const summary = formatBillingSummary({
            monthlyLimit: { val: 150_000 },
            used: { val: 8_478 },
            onDemandCap: { val: 0 },
            billingPeriodStart: "2026-06-01",
            billingPeriodEnd: "2026-07-01",
        });

        expect(summary).toBe("$84.78 / $1500.00 (5.7%)");
    });

    it("computes days remaining in billing period", () => {
        const days = billingPeriodRemaining("2099-01-10T00:00:00.000Z", new Date("2099-01-01T00:00:00.000Z"));
        expect(days).toBe(9);
    });

    it("returns zero for invalid billing period timestamps", () => {
        expect(billingPeriodRemaining("not-a-date")).toBe(0);
    });
});
