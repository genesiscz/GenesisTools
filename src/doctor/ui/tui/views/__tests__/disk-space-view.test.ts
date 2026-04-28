import { describe, expect, it } from "bun:test";
import type { Action, Finding } from "@app/doctor/lib/types";
import { diskSpaceView } from "../disk-space-view";

const noopAction: Action = {
    id: "noop",
    label: "noop",
    confirm: "none",
    execute: async (_ctx, finding) => ({ findingId: finding.id, actionId: "noop", status: "ok" }),
};

describe("diskSpaceView", () => {
    it("maps path/size/modified for large files", () => {
        const finding: Finding = {
            id: "disk-large-/Users/me/big.zip",
            analyzerId: "disk-space",
            title: "~/big.zip",
            severity: "cautious",
            actions: [noopAction],
            reclaimableBytes: 5 * 1024 * 1024 * 1024,
            metadata: {
                path: "/Users/me/big.zip",
                size: 5 * 1024 * 1024 * 1024,
                mtime: new Date(Date.now() - 3 * 86_400_000).toISOString(),
            },
        };
        const res = diskSpaceView({ findings: [finding], selected: new Set(), cursor: 0, viewportRows: 10 });

        expect(res.actionable.rows).toHaveLength(1);
        expect(res.actionable.rows[0][2][0].text).toContain("big.zip");
        expect(res.actionable.rows[0][3][0].text).toMatch(/GB$/);
        expect(res.actionable.rows[0][4][0].text).toMatch(/\d+d ago/);
        expect(res.total).toBe(1);
    });

    it("flags disk-install-fd as a recommendation", () => {
        const finding: Finding = {
            id: "disk-install-fd",
            analyzerId: "disk-space",
            title: "Install fd",
            severity: "safe",
            actions: [noopAction],
        };
        const res = diskSpaceView({ findings: [finding], selected: new Set(), cursor: 0, viewportRows: 10 });

        expect(res.actionable.rows[0][3][0].text).toBe("recommendation");
        expect(res.actionable.rows[0][4][0].text).toBe("");
    });
});
