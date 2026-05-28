import { describe, expect, it } from "bun:test";
import { isProcessAlive } from "./process-alive";

describe("isProcessAlive", () => {
    it("returns true for the current process", () => {
        expect(isProcessAlive(process.pid)).toBe(true);
    });

    it("returns false for a PID that cannot exist (ESRCH)", () => {
        expect(isProcessAlive(999_999_999)).toBe(false);
    });

    it("returns false for non-positive or non-finite PIDs", () => {
        expect(isProcessAlive(0)).toBe(false);
        expect(isProcessAlive(-1)).toBe(false);
        expect(isProcessAlive(Number.NaN)).toBe(false);
        expect(isProcessAlive(Number.POSITIVE_INFINITY)).toBe(false);
    });
});
