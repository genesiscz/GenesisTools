import { describe, expect, it } from "bun:test";
import type { Action, Finding } from "@app/doctor/lib/types";
import { processesView } from "../processes-view";

const killAction: Action = {
    id: "kill",
    label: "kill",
    confirm: "none",
    execute: async (_ctx, finding) => ({ findingId: finding.id, actionId: "kill", status: "ok" }),
};

const cpuFinding: Finding = {
    id: "proc-cpu-999",
    analyzerId: "processes",
    title: "legacy title",
    severity: "cautious",
    actions: [killAction],
    metadata: { pid: 999, cpu: 87.5, comm: "Chrome Helper", label: "Chrome browser", childCount: 3 },
};

const groupFinding: Finding = {
    id: "proc-group-Chrome Helper",
    analyzerId: "processes",
    title: "legacy title",
    severity: "cautious",
    actions: [killAction],
    reclaimableBytes: 4 * 1024 * 1024 * 1024,
    metadata: { comm: "Chrome Helper", count: 49, totalRss: 4 * 1024 * 1024 * 1024, label: "Chrome browser" },
};

const zombieFinding: Finding = {
    id: "proc-zombie-123",
    analyzerId: "processes",
    title: "Zombie PID 123",
    severity: "safe",
    actions: [],
    metadata: { pid: 123, ppid: 1, label: "Some process" },
};

describe("processesView", () => {
    it("shows CPU% for proc-cpu and empty RSS", () => {
        const res = processesView({ findings: [cpuFinding], selected: new Set(), cursor: 0, viewportRows: 5 });
        expect(res.actionable.rows[0][3][0].text).toBe("87.5%");
        expect(res.actionable.rows[0][4][0].text).toBe("");
        expect(res.actionable.rows[0][5][0].text).toBe("PID 999");
    });

    it("shows totalRss and × count for proc-group", () => {
        const res = processesView({ findings: [groupFinding], selected: new Set(), cursor: 0, viewportRows: 5 });
        expect(res.actionable.rows[0][3][0].text).toBe("");
        expect(res.actionable.rows[0][4][0].text).toMatch(/GB$/);
        expect(res.actionable.rows[0][5][0].text).toBe("× 49");
    });

    it("renders label as process name, not title", () => {
        const res = processesView({ findings: [cpuFinding], selected: new Set(), cursor: 0, viewportRows: 5 });
        expect(res.actionable.rows[0][2][0].text).toBe("Chrome browser");
    });

    it("routes zombies into the status strip and keeps hogs/groups actionable", () => {
        const res = processesView({
            findings: [cpuFinding, groupFinding, zombieFinding],
            selected: new Set(),
            cursor: 0,
            viewportRows: 10,
        });

        expect(res.status).toHaveLength(1);
        expect(res.status[0].label).toBe("Zombie");
        expect(res.status[0].value).toContain("PID 123");
        expect(res.status[0].value).toContain("parent 1");

        expect(res.actionable.findings).toHaveLength(2);
        expect(res.actionable.findings[0].id).toBe("proc-cpu-999");
        expect(res.actionable.findings[1].id).toBe("proc-group-Chrome Helper");
        expect(res.total).toBe(3);
    });
});
