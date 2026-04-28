import { describe, expect, it } from "bun:test";
import type { Action, Finding } from "@app/doctor/lib/types";
import { brewView } from "../brew-view";

const upgradeAction: Action = {
    id: "upgrade",
    label: "upgrade",
    confirm: "none",
    execute: async (_ctx, finding) => ({ findingId: finding.id, actionId: "upgrade", status: "ok" }),
};

const notInstalled: Finding = {
    id: "brew-not-installed",
    analyzerId: "brew",
    title: "Homebrew not installed",
    severity: "safe",
    actions: [],
};

const manyLeaves: Finding = {
    id: "brew-many-leaves",
    analyzerId: "brew",
    title: "42 top-level brew packages",
    severity: "safe",
    actions: [],
    metadata: { count: 42 },
};

const outdated: Finding = {
    id: "brew-outdated",
    analyzerId: "brew",
    title: "4 outdated brew package(s)",
    severity: "cautious",
    actions: [upgradeAction],
    metadata: {
        outdated: [
            { name: "git", installed: ["2.40.0"], current: "2.42.0" },
            { name: "node", installed: ["20.0.0"], current: "20.10.0" },
            { name: "bun", installed: ["1.0.0"], current: "1.1.0" },
            { name: "ripgrep", installed: ["14.0.0"], current: "14.1.0" },
        ],
    },
};

describe("brewView", () => {
    it("puts not-installed and many-leaves into status", () => {
        const res = brewView({
            findings: [notInstalled, manyLeaves],
            selected: new Set(),
            cursor: 0,
            viewportRows: 10,
        });

        expect(res.status).toHaveLength(2);
        expect(res.status[0].label).toBe("Homebrew");
        expect(res.status[0].value).toBe("not installed");
        expect(res.status[1].value).toContain("42 top-level");
        expect(res.actionable.rows).toHaveLength(0);
    });

    it("routes brew-outdated into actionable with count + truncated detail", () => {
        const res = brewView({ findings: [outdated], selected: new Set(), cursor: 0, viewportRows: 10 });

        expect(res.actionable.rows).toHaveLength(1);
        expect(res.actionable.rows[0][3][0].text).toBe("4");
        expect(res.actionable.rows[0][4][0].text).toBe("git, node, bun…");
        expect(res.total).toBe(1);
    });
});
