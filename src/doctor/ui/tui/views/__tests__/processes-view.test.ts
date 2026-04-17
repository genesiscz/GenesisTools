import type { Finding } from "@app/doctor/lib/types";
import { describe, expect, it } from "bun:test";
import { processesView } from "../processes-view";

const cpuFinding: Finding = {
    id: "proc-cpu-999",
    analyzerId: "processes",
    title: "legacy title",
    severity: "cautious",
    actions: [],
    metadata: { pid: 999, cpu: 87.5, comm: "Chrome Helper", label: "Chrome browser", childCount: 3 },
};

const groupFinding: Finding = {
    id: "proc-group-Chrome Helper",
    analyzerId: "processes",
    title: "legacy title",
    severity: "cautious",
    actions: [],
    reclaimableBytes: 4 * 1024 * 1024 * 1024,
    metadata: { comm: "Chrome Helper", count: 49, totalRss: 4 * 1024 * 1024 * 1024, label: "Chrome browser" },
};

describe("processesView", () => {
    it("shows CPU% for proc-cpu and empty RSS", () => {
        const res = processesView({ findings: [cpuFinding], selected: new Set(), cursor: 0, viewportRows: 5 });
        expect(res.rows[0][3][0].text).toBe("87.5%");
        expect(res.rows[0][4][0].text).toBe("");
        expect(res.rows[0][5][0].text).toBe("999");
    });

    it("shows totalRss and × count for proc-group", () => {
        const res = processesView({ findings: [groupFinding], selected: new Set(), cursor: 0, viewportRows: 5 });
        expect(res.rows[0][3][0].text).toBe("");
        expect(res.rows[0][4][0].text).toMatch(/GB$/);
        expect(res.rows[0][5][0].text).toBe("× 49");
    });

    it("renders label as process name, not title", () => {
        const res = processesView({ findings: [cpuFinding], selected: new Set(), cursor: 0, viewportRows: 5 });
        expect(res.rows[0][2][0].text).toBe("Chrome browser");
    });
});
