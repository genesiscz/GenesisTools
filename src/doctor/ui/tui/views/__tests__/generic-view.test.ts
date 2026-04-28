import { describe, expect, it } from "bun:test";
import type { Action, Finding } from "@app/doctor/lib/types";
import { genericView } from "../generic-view";

const noopAction: Action = {
    id: "noop",
    label: "noop",
    confirm: "none",
    execute: async (_ctx, finding) => ({ findingId: finding.id, actionId: "noop", status: "ok" }),
};

describe("genericView", () => {
    it("classifies findings with actions as actionable and others as status", () => {
        const findings: Finding[] = [
            { id: "a", analyzerId: "x", title: "one", severity: "safe", actions: [noopAction], reclaimableBytes: 1024 },
            { id: "b", analyzerId: "x", title: "two", severity: "cautious", actions: [], detail: "why" },
        ];
        const res = genericView({ findings, selected: new Set(["a"]), cursor: 0, viewportRows: 10 });

        expect(res.status).toHaveLength(1);
        expect(res.status[0].label).toBe("two");
        expect(res.status[0].value).toBe("why");

        expect(res.actionable.columns).toHaveLength(5);
        expect(res.actionable.rows).toHaveLength(1);
        expect(res.actionable.rows[0][0][0].text).toBe("[x]");
        expect(res.actionable.findings[0].id).toBe("a");

        expect(res.total).toBe(2);
    });

    it("marks blocked findings with [-]", () => {
        const findings: Finding[] = [
            {
                id: "a",
                analyzerId: "x",
                title: "nope",
                severity: "blocked",
                actions: [noopAction],
            },
        ];
        const res = genericView({ findings, selected: new Set(), cursor: 0, viewportRows: 10 });
        expect(res.actionable.rows[0][0][0].text).toBe("[-]");
    });
});
