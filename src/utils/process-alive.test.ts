import { describe, expect, it, spyOn } from "bun:test";
import { isProcessAlive, isProcessGroupAlive } from "./process-alive";

describe("isProcessAlive", () => {
    it("returns true for the current process", () => {
        expect(isProcessAlive(process.pid)).toBe(true);
    });

    it("returns false for a PID that cannot exist (ESRCH)", () => {
        expect(isProcessAlive(999_999_999)).toBe(false);
    });

    it("probes owned process groups and keeps permission errors distinct from exit", () => {
        const kill = spyOn(process, "kill").mockImplementation(() => true);
        try {
            expect(isProcessGroupAlive(123)).toBe(true);
            expect(kill).toHaveBeenCalledWith(-123, 0);
            kill.mockImplementation(() => {
                throw Object.assign(new Error("permission"), { code: "EPERM" });
            });
            expect(isProcessGroupAlive(123)).toBe(true);
            kill.mockImplementation(() => {
                throw Object.assign(new Error("exited"), { code: "ESRCH" });
            });
            expect(isProcessGroupAlive(123)).toBe(false);
            expect(isProcessGroupAlive(0)).toBe(false);
            expect(isProcessGroupAlive(-123)).toBe(false);
        } finally {
            kill.mockRestore();
        }
    });

    it("returns false for non-positive or non-finite PIDs", () => {
        expect(isProcessAlive(0)).toBe(false);
        expect(isProcessAlive(-1)).toBe(false);
        expect(isProcessAlive(Number.NaN)).toBe(false);
        expect(isProcessAlive(Number.POSITIVE_INFINITY)).toBe(false);
    });
});
