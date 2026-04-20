import type { Action, Finding } from "@app/doctor/lib/types";
import { describe, expect, it } from "bun:test";
import { systemCachesView } from "../system-caches-view";

const noopAction: Action = {
    id: "noop",
    label: "noop",
    confirm: "none",
    execute: async (_ctx, finding) => ({ findingId: finding.id, actionId: "noop", status: "ok" }),
};

describe("systemCachesView", () => {
    it("shows path + size for user cache entries", () => {
        const finding: Finding = {
            id: "sys-cache-com.apple.example",
            analyzerId: "system-caches",
            title: "~/Library/Caches/com.apple.example",
            severity: "cautious",
            actions: [noopAction],
            reclaimableBytes: 120 * 1024 * 1024,
            metadata: { path: "/Users/me/Library/Caches/com.apple.example", bytes: 120 * 1024 * 1024 },
        };
        const res = systemCachesView({ findings: [finding], selected: new Set(), cursor: 0, viewportRows: 10 });

        expect(res.actionable.rows).toHaveLength(1);
        expect(res.actionable.rows[0][2][0].text).toContain("com.apple.example");
        expect(res.actionable.rows[0][3][0].text).toMatch(/MB$/);
        expect(res.actionable.rows[0][4][0].text).toBe("");
        expect(res.total).toBe(1);
    });

    it("shows file count in extra column for sys-var-log", () => {
        const finding: Finding = {
            id: "sys-var-log",
            analyzerId: "system-caches",
            title: "3 archived log(s)",
            severity: "cautious",
            actions: [noopAction],
            reclaimableBytes: 10 * 1024 * 1024,
            metadata: { paths: ["/var/log/a", "/var/log/b", "/var/log/c"], totalSize: 10 * 1024 * 1024 },
        };
        const res = systemCachesView({ findings: [finding], selected: new Set(), cursor: 0, viewportRows: 10 });
        expect(res.actionable.rows[0][4][0].text).toBe("3 files");
    });
});
