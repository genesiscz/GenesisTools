import { describe, expect, test } from "bun:test";
import { formatWarmupViaHint, shouldWarmSession } from "./service";

describe("formatWarmupViaHint", () => {
    test("oauth and missing via print nothing", () => {
        expect(formatWarmupViaHint()).toBe("");
        expect(formatWarmupViaHint("oauth")).toBe("");
    });

    test("login-long is named in the user-facing suffix", () => {
        expect(formatWarmupViaHint("login-long")).toBe(" used login-long token");
    });
});

describe("shouldWarmSession", () => {
    const SCHEDULE = { startHour: 8, endHour: 20, hour: 10 };
    const WEEKLY = { utilization: 20, resets_at: "2099-01-08T00:00:00.000Z" };

    test("an account without a 5-hour limit has no session to start, so it is never warmed", () => {
        // Its reset never appears: without the check every daemon tick in the schedule sent a turn.
        expect(shouldWarmSession({ five_hour: null, seven_day: WEEKLY }, SCHEDULE)).toBe(false);
    });

    test("negative control: an idle 5h window inside the schedule is warmed, outside it is not", () => {
        const idle = { five_hour: { utilization: 0, resets_at: null }, seven_day: WEEKLY };

        expect(shouldWarmSession(idle, SCHEDULE)).toBe(true);
        expect(shouldWarmSession(idle, { ...SCHEDULE, hour: 22 })).toBe(false);
    });
});
