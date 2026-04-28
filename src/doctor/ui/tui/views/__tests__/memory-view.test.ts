import { describe, expect, it } from "bun:test";
import type { Action, Finding } from "@app/doctor/lib/types";
import { memoryView } from "../memory-view";

const killAction: Action = {
    id: "kill",
    label: "kill",
    confirm: "none",
    execute: async (_ctx, finding) => ({ findingId: finding.id, actionId: "kill", status: "ok" }),
};

const swap: Finding = {
    id: "mem-swap",
    analyzerId: "memory",
    title: "Swap - X used",
    severity: "safe",
    actions: [killAction],
    metadata: {
        swap: { totalBytes: 2 * 1024 * 1024 * 1024, usedBytes: 1 * 1024 * 1024 * 1024, freeBytes: 0, encrypted: true },
        vm: {},
    },
};

const pressure: Finding = {
    id: "mem-pressure",
    analyzerId: "memory",
    title: "Memory pressure - LOW",
    severity: "safe",
    actions: [],
    metadata: { vm: { pressure: "LOW" } },
};

const hog: Finding = {
    id: "mem-rss-42",
    analyzerId: "memory",
    title: "PID 42 - node - 1 GB",
    severity: "cautious",
    actions: [killAction],
    reclaimableBytes: 1024 * 1024 * 1024,
    metadata: { pid: 42, comm: "node", rssBytes: 1024 * 1024 * 1024, label: "Node" },
};

describe("memoryView", () => {
    it("routes swap + pressure into status and rss hogs into actionable", () => {
        const res = memoryView({
            findings: [swap, pressure, hog],
            selected: new Set(),
            cursor: 0,
            viewportRows: 10,
        });

        expect(res.status).toHaveLength(2);
        expect(res.status[0].label).toBe("Swap");
        expect(res.status[0].value).toContain("50%");
        expect(res.status[1].label).toBe("Memory pressure");
        expect(res.status[1].value).toBe("LOW");

        expect(res.actionable.rows).toHaveLength(1);
        expect(res.actionable.rows[0][2][0].text).toBe("Node");
        expect(res.actionable.rows[0][3][0].text).toMatch(/GB$/);
        expect(res.actionable.rows[0][4][0].text).toBe("42");
        expect(res.total).toBe(3);
    });

    it("returns empty actionable table when no mem-rss findings", () => {
        const res = memoryView({ findings: [pressure], selected: new Set(), cursor: 0, viewportRows: 10 });
        expect(res.status).toHaveLength(1);
        expect(res.actionable.rows).toHaveLength(0);
    });
});
