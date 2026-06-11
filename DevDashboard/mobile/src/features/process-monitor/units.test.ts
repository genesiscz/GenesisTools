import { describe, expect, it } from "bun:test";
import { DASH, cpu, mb, uptime } from "@/features/process-monitor/units";

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe("process-monitor units — mb", () => {
    it("formats bytes as MB under 1 GB, GB above, em-dash on null/NaN", () => {
        expect(mb(640 * MB)).toBe("640 MB");
        expect(mb(96 * MB)).toBe("96 MB");
        expect(mb(1.8 * GB)).toBe("1.8 GB");
        expect(mb(null)).toBe(DASH);
        expect(mb(undefined)).toBe(DASH);
        expect(mb(Number.NaN)).toBe(DASH);
    });
});

describe("process-monitor units — uptime", () => {
    it("formats ms as h/m, m, or s; em-dash on null/negative", () => {
        expect(uptime(5_400_000)).toBe("1h 30m");
        expect(uptime(600_000)).toBe("10m");
        expect(uptime(45_000)).toBe("45s");
        expect(uptime(0)).toBe("0s");
        expect(uptime(null)).toBe(DASH);
        expect(uptime(-1)).toBe(DASH);
    });
});

describe("process-monitor units — cpu", () => {
    it("rounds to a whole percent; em-dash on null/NaN", () => {
        expect(cpu(12.4)).toBe("12%");
        expect(cpu(61.5)).toBe("62%");
        expect(cpu(0)).toBe("0%");
        expect(cpu(null)).toBe(DASH);
        expect(cpu(Number.NaN)).toBe(DASH);
    });
});
