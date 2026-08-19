import { describe, expect, test } from "bun:test";
import { describeAccounts, describeLayout, type RestoreSettings, tuneOptions } from "@app/claude/lib/cmux/settings";
import type { RestorePlan } from "@app/claude/lib/cmux/types";

function settings(overrides: Partial<RestoreSettings> = {}): RestoreSettings {
    return {
        layout: "capped",
        perWorkspace: 4,
        perProject: true,
        newWindow: false,
        enter: true,
        autopick: false,
        ...overrides,
    };
}

const PLAN: RestorePlan = {
    workspaces: [
        { title: "app", cwd: "/app", panes: [{ paneIndex: 0, sessions: [] }] },
        { title: "web", cwd: "/web", panes: [{ paneIndex: 0, sessions: [] }] },
    ],
};

describe("tuneOptions", () => {
    test("restoring is the first row, so Enter confirms", () => {
        expect(tuneOptions(settings(), PLAN, 3)[0].value).toBe("go");
    });

    test("every row shows its current value, so the menu doubles as the summary", () => {
        const hints = new Map(tuneOptions(settings(), PLAN, 3).map((o) => [o.value, o.hint]));

        expect(hints.get("go")).toBe("3 sessions · 2 panes · 2 workspaces");
        expect(hints.get("grouping")).toBe("one workspace set per project");
        expect(hints.get("window")).toBe("this window");
        expect(hints.get("launch")).toBe("run the command");
    });

    test("the toggled state is what shows next time", () => {
        const hints = new Map(
            tuneOptions(settings({ perProject: false, newWindow: true, enter: false }), PLAN, 1).map((o) => [
                o.value,
                o.hint,
            ])
        );

        expect(hints.get("grouping")).toBe("all projects in one set");
        expect(hints.get("window")).toBe("a new cmux window");
        expect(hints.get("launch")).toBe("queue it at the prompt");
    });

    test("the pane cap is offered only for the layouts that overflow", () => {
        const values = (layout: RestoreSettings["layout"]) =>
            tuneOptions(settings({ layout }), PLAN, 1).map((o) => o.value);

        expect(values("capped")).toContain("per-workspace");
        expect(values("tabs")).toContain("per-workspace");
        expect(values("grid")).not.toContain("per-workspace");
    });

    test("singular counts read correctly", () => {
        const plan: RestorePlan = {
            workspaces: [{ title: "app", cwd: "/app", panes: [{ paneIndex: 0, sessions: [] }] }],
        };

        expect(tuneOptions(settings(), plan, 1)[0].hint).toBe("1 session · 1 pane · 1 workspace");
    });

    test("cancel is always reachable", () => {
        expect(tuneOptions(settings(), PLAN, 3).at(-1)?.value).toBe("cancel");
    });
});

describe("describeLayout", () => {
    test("names the cap for the layouts that use one", () => {
        expect(describeLayout(settings({ perWorkspace: 6 }))).toContain("6 panes per workspace");
        expect(describeLayout(settings({ layout: "tabs" }))).toContain("overflow as tabs");
    });

    test("says what grid means instead of quoting a cap it ignores", () => {
        expect(describeLayout(settings({ layout: "grid" }))).toBe("grid (one workspace, every session a pane)");
    });
});

describe("describeAccounts", () => {
    test("reports which of the three account modes is active", () => {
        expect(describeAccounts(settings())).toBe("pins, ask for the rest");
        expect(describeAccounts(settings({ autopick: true }))).toBe("pins, then auto-pick the rest");
        expect(describeAccounts(settings({ forceAccount: "work" }))).toBe("every pane as work");
    });
});
