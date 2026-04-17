import type { Finding } from "@app/doctor/lib/types";
import { describe, expect, it } from "bun:test";
import { batteryView } from "../battery-view";

const summary: Finding = {
    id: "battery-summary",
    analyzerId: "battery",
    title: "Battery · ...",
    severity: "safe",
    actions: [],
    metadata: {
        cycleCount: 412,
        condition: "Normal",
        maxCapacityPct: 87,
        fullyCharged: false,
        stateOfChargePct: 62,
    },
};

const thermal: Finding = {
    id: "battery-thermal",
    analyzerId: "battery",
    title: "No recent thermal throttling",
    severity: "safe",
    actions: [],
    metadata: { eventCount: 0 },
};

describe("batteryView", () => {
    it("returns empty actionable and status rows for summary + thermal", () => {
        const res = batteryView({ findings: [summary, thermal], selected: new Set(), cursor: 0, viewportRows: 10 });

        expect(res.actionable.rows).toHaveLength(0);
        expect(res.actionable.findings).toHaveLength(0);

        const labels = res.status.map((row) => row.label);
        expect(labels).toContain("Cycle count");
        expect(labels).toContain("Condition");
        expect(labels).toContain("Max capacity");
        expect(labels).toContain("Charge");
        expect(labels).toContain("Thermal events");

        const cycleRow = res.status.find((row) => row.label === "Cycle count");
        expect(cycleRow?.value).toBe("412");

        expect(res.total).toBe(2);
    });
});
