import { describe, expect, it } from "bun:test";
import { activeSessionRetentionMs, DEFAULT_SESSION_POOL_SETTINGS } from "./session-pool-settings";

describe("session-pool-settings", () => {
    it("converts minutes to retention ms", () => {
        expect(activeSessionRetentionMs({ activeSessionLimitMinutes: 60, keepAllAlive: true })).toBe(3_600_000);
    });

    it("defaults to 60 minutes and keep all alive", () => {
        expect(DEFAULT_SESSION_POOL_SETTINGS.activeSessionLimitMinutes).toBe(60);
        expect(DEFAULT_SESSION_POOL_SETTINGS.keepAllAlive).toBe(true);
    });
});
