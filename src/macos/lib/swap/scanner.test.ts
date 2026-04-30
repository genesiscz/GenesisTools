import { describe, expect, it } from "bun:test";
import { parseSwapUsage } from "./scanner";

describe("parseSwapUsage", () => {
    it("parses standard sysctl output in MB", () => {
        const out = "vm.swapusage: total = 19456.00M  used = 18617.75M  free = 838.25M  (encrypted)";
        const result = parseSwapUsage(out);
        expect(result.totalBytes).toBe(19456 * 1024 * 1024);
        expect(result.usedBytes).toBeCloseTo(18617.75 * 1024 * 1024);
        expect(result.freeBytes).toBeCloseTo(838.25 * 1024 * 1024);
    });

    it("returns zeros when output is empty", () => {
        const result = parseSwapUsage("");
        expect(result.totalBytes).toBe(0);
        expect(result.usedBytes).toBe(0);
        expect(result.freeBytes).toBe(0);
    });
});
