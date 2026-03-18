import { describe, expect, it } from "bun:test";
import { formatCountdown, generateId, isProcessAlive } from "./index";

describe("formatCountdown", () => {
    it("returns 00:00 for zero", () => {
        expect(formatCountdown(0)).toBe("00:00");
    });

    it("returns 00:00 for negative", () => {
        expect(formatCountdown(-1000)).toBe("00:00");
    });

    it("formats seconds", () => {
        expect(formatCountdown(5000)).toBe("00:05");
    });

    it("formats minutes and seconds", () => {
        expect(formatCountdown(90_000)).toBe("01:30");
    });

    it("formats hours", () => {
        expect(formatCountdown(3_661_000)).toBe("01:01:01");
    });
});

describe("generateId", () => {
    it("returns non-empty string", () => {
        expect(generateId().length).toBeGreaterThan(0);
    });

    it("generates unique IDs across 100 calls", () => {
        const ids = new Set(Array.from({ length: 100 }, () => generateId()));
        expect(ids.size).toBe(100);
    });
});

describe("isProcessAlive", () => {
    it("returns true for current process", () => {
        expect(isProcessAlive(process.pid)).toBe(true);
    });

    it("returns false for impossible PID", () => {
        expect(isProcessAlive(999999999)).toBe(false);
    });
});
