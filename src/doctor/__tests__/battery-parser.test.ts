import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePowerProfile, parseThermLog } from "@app/doctor/analyzers/battery";

describe("parsePowerProfile", () => {
    it("extracts cycle count, condition, and max capacity", () => {
        const raw = readFileSync(join(import.meta.dir, "fixtures", "system_profiler-power.txt"), "utf8");
        const parsed = parsePowerProfile(raw);

        expect(parsed.cycleCount).toBeGreaterThan(0);
        expect(parsed.condition).toBe("Normal");
        expect(parsed.maxCapacityPct).toBeGreaterThanOrEqual(0);
    });

    it("handles missing fields gracefully", () => {
        const parsed = parsePowerProfile("");
        expect(parsed.cycleCount).toBeNull();
    });
});

describe("parseThermLog", () => {
    it("treats empty output as no thermal events", () => {
        expect(parseThermLog("")).toEqual([]);
    });
});
