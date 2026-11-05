import { describe, expect, it } from "bun:test";
import { paceLine, resetLine, ringTone } from "./queries";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");

describe("account window lines", () => {
    it("counts down to the reset", () => {
        expect(resetLine({ resetsAt: "2026-11-04T14:10:00.000Z" }, NOW)).toBe("resets in 2 h 10 min");
        expect(resetLine({ resetsAt: "2026-11-04T12:25:00.000Z" }, NOW)).toBe("resets in 25 min");
        expect(resetLine({ resetsAt: "2026-11-07T12:00:00.000Z" }, NOW)).toBe("resets in 3 d");
        expect(resetLine({ resetsAt: null }, NOW)).toBeNull();
    });

    it("names the run-out time only before the reset and on fresh readings", () => {
        const exhaustAt = "2026-11-04T13:40:00.000Z";
        expect(paceLine({ exhaustAt, beforeReset: true, stale: false })).toMatch(/^runs out at .+ at this pace$/);
        expect(paceLine({ exhaustAt, beforeReset: false, stale: false })).toBeNull();
        expect(paceLine({ exhaustAt, beforeReset: true, stale: true })).toBeNull();
    });

    it("turns red near the cap or before a run-out", () => {
        expect(ringTone({ utilization: 95, beforeReset: false })).toBe("danger");
        expect(ringTone({ utilization: 20, beforeReset: true })).toBe("danger");
        expect(ringTone({ utilization: 75, beforeReset: false })).toBe("warning");
        expect(ringTone({ utilization: 10, beforeReset: false })).toBe("accent");
    });
});
