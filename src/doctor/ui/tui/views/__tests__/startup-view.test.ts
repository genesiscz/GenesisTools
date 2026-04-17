import type { Action, Finding } from "@app/doctor/lib/types";
import { describe, expect, it } from "bun:test";
import { startupView } from "../startup-view";

const removeAction: Action = {
    id: "remove",
    label: "remove",
    confirm: "none",
    execute: async (_ctx, finding) => ({ findingId: finding.id, actionId: "remove", status: "ok" }),
};

const assertion: Finding = {
    id: "startup-assertion-123",
    analyzerId: "startup",
    title: "App (PID 123) · PreventUserIdleSystemSleep",
    severity: "safe",
    actions: [],
    metadata: { pid: 123, processName: "App", kind: "PreventUserIdleSystemSleep", name: "held" },
};

const brokenAgent: Finding = {
    id: "startup-broken-com.example.agent",
    analyzerId: "startup",
    title: "Broken user agent: com.example.agent",
    detail: "Status: -9",
    severity: "cautious",
    actions: [removeAction],
    metadata: { pid: null, status: -9, label: "com.example.agent" },
};

describe("startupView", () => {
    it("puts power assertions into status", () => {
        const res = startupView({ findings: [assertion], selected: new Set(), cursor: 0, viewportRows: 10 });
        expect(res.status).toHaveLength(1);
        expect(res.status[0].label).toBe("Power assertion");
        expect(res.status[0].value).toContain("App");
        expect(res.actionable.rows).toHaveLength(0);
        expect(res.total).toBe(1);
    });

    it("routes broken agents into actionable with Broken agent kind", () => {
        const res = startupView({
            findings: [assertion, brokenAgent],
            selected: new Set(),
            cursor: 0,
            viewportRows: 10,
        });

        expect(res.status).toHaveLength(1);
        expect(res.actionable.rows).toHaveLength(1);
        expect(res.actionable.rows[0][2][0].text).toBe("Broken agent");
        expect(res.actionable.rows[0][3][0].text).toBe("com.example.agent");
        expect(res.total).toBe(2);
    });
});
