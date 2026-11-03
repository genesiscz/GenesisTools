import type { AccountUsage } from "../api";

/** Invented accounts for the scored-accounts golden: a missing 5h window, a stale cooling one, a dead week, a dead login. */
export const GOLDEN_NOW = new Date("2026-11-01T11:30:00.000Z");

export const GOLDEN_FIXTURE: AccountUsage[] = [
    {
        accountName: "work",
        usage: { five_hour: null, seven_day: { utilization: 61, resets_at: "2026-11-03T09:00:00.000Z" } },
    },
    {
        accountName: "shop",
        label: "Pro",
        usage: {
            five_hour: { utilization: 97, resets_at: "2026-11-01T12:10:00.000Z" },
            seven_day: { utilization: 20, resets_at: "2026-11-06T00:00:00.000Z" },
            seven_day_opus: { utilization: 70, resets_at: "2026-11-06T00:00:00.000Z" },
        },
        stale: { lastSuccessAt: Date.parse("2026-11-01T10:00:00.000Z"), reason: "network" },
    },
    {
        accountName: "side",
        usage: {
            five_hour: { utilization: 5, resets_at: "2026-11-01T15:00:00.000Z" },
            seven_day: { utilization: 99.5, resets_at: "2026-11-02T08:00:00.000Z" },
        },
    },
    { accountName: "personal", error: "Usage API 401: invalid_grant" },
];
