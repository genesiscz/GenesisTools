import { describe, expect, it } from "bun:test";
import {
    activeSessionRetentionMs,
    DEFAULT_SESSION_POOL_SETTINGS,
    formatActiveSessionLimit,
    parseSessionPoolSettings,
} from "./session-pool-settings";

describe("session-pool-settings", () => {
    it("converts seconds to retention ms", () => {
        expect(activeSessionRetentionMs({ activeSessionLimitSeconds: 3600, keepAllAlive: true })).toBe(3_600_000);
    });

    it("defaults to 1 hour and keep all alive", () => {
        expect(DEFAULT_SESSION_POOL_SETTINGS.activeSessionLimitSeconds).toBe(3600);
        expect(DEFAULT_SESSION_POOL_SETTINGS.keepAllAlive).toBe(true);
    });

    it("migrates legacy minute-based settings", () => {
        const parsed = parseSessionPoolSettings({ activeSessionLimitMinutes: 30, keepAllAlive: false });

        expect(parsed.activeSessionLimitSeconds).toBe(1800);
        expect(parsed.keepAllAlive).toBe(false);
    });

    it("formats sub-minute limits in seconds", () => {
        expect(formatActiveSessionLimit(1)).toBe("1s");
        expect(formatActiveSessionLimit(45)).toBe("45s");
    });

    it("formats hour-scale limits compactly", () => {
        expect(formatActiveSessionLimit(3600)).toBe("1h");
        expect(formatActiveSessionLimit(14_400)).toBe("4h");
        expect(formatActiveSessionLimit(3661)).toBe("1h 1m 1s");
    });
});
