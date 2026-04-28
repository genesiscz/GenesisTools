import { describe, expect, it } from "bun:test";
import type { Action, Finding } from "@app/doctor/lib/types";
import { devCachesView } from "../dev-caches-view";

const noopAction: Action = {
    id: "noop",
    label: "noop",
    confirm: "none",
    execute: async (_ctx, finding) => ({ findingId: finding.id, actionId: "noop", status: "ok" }),
};

describe("devCachesView", () => {
    it("derives cache name from id prefix and shows size + path", () => {
        const finding: Finding = {
            id: "dev-xcode-derived",
            analyzerId: "dev-caches",
            title: "Xcode DerivedData",
            severity: "cautious",
            actions: [noopAction],
            reclaimableBytes: 700 * 1024 * 1024,
            metadata: { path: "/Users/me/Library/Developer/Xcode/DerivedData", bytes: 700 * 1024 * 1024 },
        };
        const res = devCachesView({ findings: [finding], selected: new Set(), cursor: 0, viewportRows: 10 });

        expect(res.actionable.rows).toHaveLength(1);
        expect(res.actionable.rows[0][2][0].text).toBe("Xcode DerivedData");
        expect(res.actionable.rows[0][3][0].text).toMatch(/MB$/);
        expect(res.actionable.rows[0][4][0].text).toContain("DerivedData");
        expect(res.total).toBe(1);
    });

    it("names node_modules entries from dev-node-modules- prefix", () => {
        const finding: Finding = {
            id: "dev-node-modules-/repo/foo",
            analyzerId: "dev-caches",
            title: "~/repo/foo",
            severity: "cautious",
            actions: [noopAction],
            reclaimableBytes: 900 * 1024 * 1024,
            metadata: { path: "/repo/foo", bytes: 900 * 1024 * 1024 },
        };
        const res = devCachesView({ findings: [finding], selected: new Set(), cursor: 0, viewportRows: 10 });

        expect(res.actionable.rows[0][2][0].text).toBe("node_modules");
    });
});
