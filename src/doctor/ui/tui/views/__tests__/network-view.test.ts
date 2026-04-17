import type { Action, Finding } from "@app/doctor/lib/types";
import { describe, expect, it } from "bun:test";
import { networkView } from "../network-view";

const flushAction: Action = {
    id: "flush",
    label: "flush",
    confirm: "none",
    execute: async (_ctx, finding) => ({ findingId: finding.id, actionId: "flush", status: "ok" }),
};

const utun: Finding = {
    id: "net-utun-leftovers",
    analyzerId: "network",
    title: "12 utun interfaces",
    severity: "safe",
    actions: [],
    metadata: { count: 12, interfaces: [] },
};

const dns: Finding = {
    id: "net-dns-flush",
    analyzerId: "network",
    title: "Flush DNS cache",
    severity: "safe",
    actions: [flushAction],
};

const stuck: Finding = {
    id: "net-stuck-connections",
    analyzerId: "network",
    title: "200 stuck TCP connections",
    severity: "safe",
    actions: [],
    metadata: { counts: { TIME_WAIT: 180, CLOSE_WAIT: 20 } },
};

describe("networkView", () => {
    it("routes utun-leftovers to status", () => {
        const res = networkView({ findings: [utun], selected: new Set(), cursor: 0, viewportRows: 10 });

        expect(res.status).toHaveLength(1);
        expect(res.status[0].label).toBe("utun interfaces");
        expect(res.status[0].value).toContain("12");
        expect(res.actionable.rows).toHaveLength(0);
        expect(res.total).toBe(1);
    });

    it("shows DNS flush as actionable with short name", () => {
        const res = networkView({ findings: [dns], selected: new Set(), cursor: 0, viewportRows: 10 });

        expect(res.actionable.rows).toHaveLength(1);
        expect(res.actionable.rows[0][2][0].text).toBe("DNS cache");
        expect(res.total).toBe(1);
    });

    it("leaves stuck TCP in status when no actions", () => {
        const res = networkView({ findings: [stuck], selected: new Set(), cursor: 0, viewportRows: 10 });
        expect(res.status).toHaveLength(1);
        expect(res.status[0].label).toBe(stuck.title);
    });
});
